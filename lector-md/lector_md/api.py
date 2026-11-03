"""Puente entre la interfaz web y el sistema de archivos."""

from __future__ import annotations

import ctypes
import logging
import os
import platform
import subprocess
import sys
import webbrowser
from pathlib import Path
from threading import RLock
from typing import Any
from urllib.parse import urlparse

import webview

from . import APP_NAME, __version__
from .library import Library, ReaderError, is_within, resolve_inside
from .settings import SettingsStore

log = logging.getLogger(__name__)


def _error(message: str) -> dict[str, Any]:
    return {"ok": False, "error": message}


def set_clipboard_text(text: str) -> bool:
    if sys.platform != "win32":
        return False
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    opened = False
    handle = None
    try:
        opened = bool(user32.OpenClipboard(None))
        if not opened:
            return False
        user32.EmptyClipboard()
        buffer = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(buffer)
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return False
        ctypes.memmove(pointer, buffer, size)
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            return False
        handle = None  # el portapapeles toma posesión de la memoria
        return True
    except Exception:
        log.exception("No se pudo copiar al portapapeles")
        return False
    finally:
        if handle:
            kernel32.GlobalFree(handle)
        if opened:
            user32.CloseClipboard()


class Api:
    def __init__(
        self,
        base_dir: Path,
        initial_folder: Path | None = None,
        initial_file: str | None = None,
    ) -> None:
        self.base_dir = base_dir
        self.demo_dir = base_dir / "ejemplo"
        self.settings = SettingsStore()
        self._initial_folder = initial_folder
        self._initial_file = initial_file
        self._window: webview.Window | None = None
        self._library: Library | None = None
        self._lock = RLock()

    def set_window(self, window: webview.Window) -> None:
        self._window = window

    # ------------------------------------------------------------------ boot
    def bootstrap(self) -> dict[str, Any]:
        try:
            initial = self._initial_folder
            last_file = None
            if initial is None:
                initial = self.settings.last_folder()
                if initial:
                    last_file = self.settings.last_file_for(initial)
            elif self._initial_file:
                last_file = self._initial_file

            if initial is not None and not initial.is_dir():
                initial = None
                last_file = None

            from_cli = initial is not None and self._initial_folder is not None
            return {
                "ok": True,
                "app": {
                    "name": APP_NAME,
                    "version": __version__,
                    "platform": platform.platform(),
                },
                "settings": self.settings.public(),
                "recents": self.settings.recent_folders(),
                "initial_folder": str(initial) if initial else None,
                "initial_file": last_file,
                "initial_remember": bool(from_cli),
                "demo_available": self.demo_dir.is_dir(),
            }
        except Exception as exc:  # pragma: no cover - protección de arranque
            log.exception("Fallo en bootstrap")
            return _error(f"No se pudo iniciar la aplicación: {exc}")

    # --------------------------------------------------------------- folders
    def choose_folder(self) -> dict[str, Any]:
        try:
            if self._window is None:
                return _error("La ventana todavía no está lista.")
            start = str(self._library.root) if self._library else str(Path.home())
            result = self._window.create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=start,
                allow_multiple=False,
            )
            if not result:
                return {"ok": True, "cancelled": True}
            folder = result[0] if isinstance(result, (list, tuple)) else result
            return self.open_folder(folder, True)
        except Exception as exc:
            log.exception("No se pudo abrir el diálogo de carpeta")
            return _error(f"No se pudo abrir el selector de carpetas: {exc}")

    def open_folder(self, path: str, remember: bool = True) -> dict[str, Any]:
        try:
            raw = os.path.expandvars(os.path.expanduser(str(path).strip().strip('"')))
            target = Path(raw).resolve()
            if not target.is_dir():
                return _error("La carpeta indicada no existe o no es accesible.")
            library = Library(target)
            with self._lock:
                self._library = library
            if remember:
                self.settings.remember_folder(library.root)
            last_file = self.settings.last_file_for(library.root)
            if last_file and last_file not in library.by_rel:
                last_file = None
            if not last_file:
                last_file = library.suggested_file()
            return {
                "ok": True,
                "folder": library.scan_result["summary"],
                "tree": library.scan_result["tree"],
                "last_file": last_file,
                "is_demo": self.demo_dir.is_dir()
                and os.path.normcase(str(library.root)) == os.path.normcase(str(self.demo_dir.resolve())),
            }
        except ReaderError as exc:
            return _error(str(exc))
        except Exception:
            log.exception("No se pudo abrir la carpeta %s", path)
            return _error("Ocurrió un error al abrir la carpeta.")

    def open_demo(self) -> dict[str, Any]:
        if not self.demo_dir.is_dir():
            return _error("La carpeta de ejemplo no está disponible.")
        return self.open_folder(str(self.demo_dir), False)

    def refresh_folder(self) -> dict[str, Any]:
        try:
            with self._lock:
                library = self._library
            if library is None:
                return _error("Primero abre una carpeta.")
            fresh = Library(library.root)
            with self._lock:
                self._library = fresh
            return {
                "ok": True,
                "folder": fresh.scan_result["summary"],
                "tree": fresh.scan_result["tree"],
            }
        except ReaderError as exc:
            return _error(str(exc))
        except Exception:
            log.exception("No se pudo recargar la carpeta")
            return _error("No se pudo recargar la carpeta.")

    def go_up(self) -> dict[str, Any]:
        try:
            with self._lock:
                library = self._library
            if library is None:
                return _error("Primero abre una carpeta.")
            parent = library.root.parent
            if parent == library.root:
                return _error("Ya estás en la raíz del disco.")
            return self.open_folder(str(parent), True)
        except Exception as exc:
            return _error(f"No se pudo subir de carpeta: {exc}")

    def close_folder(self) -> dict[str, Any]:
        with self._lock:
            self._library = None
        self.settings.data["last_folder"] = None
        self.settings.save()
        return {"ok": True}

    # ------------------------------------------------------------- documents
    def read_file(self, rel_path: str) -> dict[str, Any]:
        try:
            with self._lock:
                library = self._library
            if library is None:
                return _error("Primero abre una carpeta con documentos Markdown.")
            document = library.read_document(rel_path)
            self.settings.remember_file(library.root, document["path"])
            document["ok"] = True
            return document
        except ReaderError as exc:
            return _error(str(exc))
        except Exception:
            log.exception("No se pudo leer el documento %s", rel_path)
            return _error("No se pudo mostrar el documento.")

    def search_content(self, query: str) -> dict[str, Any]:
        try:
            with self._lock:
                library = self._library
            if library is None:
                return _error("Abre una carpeta para buscar en su contenido.")
            result = library.search(query)
            result["ok"] = True
            return result
        except ReaderError as exc:
            return _error(str(exc))
        except Exception:
            log.exception("Fallo la búsqueda de contenido")
            return _error("No se pudo completar la búsqueda.")

    # ------------------------------------------------------------------ files
    def open_external(self, target: str) -> dict[str, Any]:
        try:
            value = (target or "").strip()
            if not value:
                return _error("No hay nada que abrir.")
            parsed = urlparse(value)
            if parsed.scheme.lower() in {"http", "https", "mailto"}:
                webbrowser.open(value)
                return {"ok": True}
            if parsed.scheme.lower() in {"javascript", "vbscript", "data", "file"}:
                if parsed.scheme.lower() == "file":
                    value = parsed.path
                else:
                    return _error("Ese tipo de enlace no está permitido.")

            with self._lock:
                library = self._library
            if library is None:
                return _error("Abre una carpeta primero.")
            raw = Path(value)
            if raw.is_absolute():
                path = raw.resolve()
            else:
                path = resolve_inside(library.root, value.replace("\\", "/"))
            if not is_within(library.root, path):
                return _error("Ese archivo está fuera de la carpeta abierta.")
            if not path.exists():
                return _error("El archivo enlazado no existe.")
            os.startfile(str(path))  # type: ignore[attr-defined]
            return {"ok": True}
        except ReaderError as exc:
            return _error(str(exc))
        except Exception:
            log.exception("No se pudo abrir %s", target)
            return _error("Windows no pudo abrir ese elemento.")

    def reveal(self, rel_path: str | None = None) -> dict[str, Any]:
        try:
            with self._lock:
                library = self._library
            if library is None:
                return _error("Primero abre una carpeta.")
            if rel_path:
                path = resolve_inside(library.root, rel_path)
                if not is_within(library.root, path):
                    return _error("Ese archivo está fuera de la carpeta abierta.")
                if not path.exists():
                    return _error("El archivo ya no existe.")
            else:
                path = library.root
            if path.is_file():
                subprocess.Popen(["explorer.exe", "/select,", str(path)])
            else:
                os.startfile(str(path))  # type: ignore[attr-defined]
            return {"ok": True}
        except ReaderError as exc:
            return _error(str(exc))
        except Exception:
            log.exception("No se pudo abrir el Explorador")
            return _error("No se pudo abrir el Explorador de Windows.")

    def copy_text(self, text: str) -> dict[str, Any]:
        value = str(text or "")[:20_000]
        if set_clipboard_text(value):
            return {"ok": True}
        return _error("No se pudo copiar al portapapeles.")

    # --------------------------------------------------------------- settings
    def save_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        try:
            return {"ok": True, "settings": self.settings.update(patch)}
        except Exception:
            log.exception("No se pudieron guardar las preferencias")
            return _error("No se pudieron guardar las preferencias.")

    def forget_recents(self) -> dict[str, Any]:
        self.settings.data["recents"] = []
        self.settings.save()
        return {"ok": True, "recents": []}

    # ------------------------------------------------------------------- misc
    def set_window_title(self, title: str) -> dict[str, Any]:
        if self._window is not None:
            self._window.set_title(str(title or APP_NAME)[:150])
        return {"ok": True}

    def app_info(self) -> dict[str, Any]:
        with self._lock:
            root = str(self._library.root) if self._library else None
        return {
            "ok": True,
            "name": APP_NAME,
            "version": __version__,
            "python": platform.python_version(),
            "platform": platform.platform(),
            "folder": root,
        }

    def open_data_folder(self) -> dict[str, Any]:
        try:
            os.startfile(str(self.settings.path.parent))  # type: ignore[attr-defined]
            return {"ok": True}
        except Exception:
            return _error("No se pudo abrir la carpeta de configuración.")

    def quit_app(self) -> dict[str, Any]:
        if self._window is not None:
            self._window.destroy()
        return {"ok": True}
