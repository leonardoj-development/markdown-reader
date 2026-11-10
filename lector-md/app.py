"""Punto de entrada de Lector MD."""

from __future__ import annotations

import argparse
import ctypes
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

import webview

from lector_md import APP_NAME, __version__
from lector_md.api import Api
from lector_md.library import is_markdown
from lector_md.settings import config_dir

APP_ID = "LectorMD.App.1"


def enable_dpi_awareness() -> None:
    """Evita que Windows escale la ventana como si fuera una app antigua."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass


def window_geometry() -> tuple[int, int, int, int]:
    """Tamaño inicial y posición centrada, en píxeles lógicos."""
    width, height = 1400, 860
    x = y = None
    if sys.platform != "win32":
        return width, height, 0, 0
    try:
        user32 = ctypes.windll.user32
        user32.SetProcessDPIAware()
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
        try:
            scale = user32.GetDpiForSystem() / 96.0
        except Exception:
            scale = 1.0

        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long),
            ]

        work = RECT()
        if user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0):
            logical_w = (work.right - work.left) / scale
            logical_h = (work.bottom - work.top) / scale
        else:
            logical_w = screen_w / scale
            logical_h = screen_h / scale
        width = int(max(900, min(1400, logical_w - 32)))
        height = int(max(620, min(860, logical_h - 44)))
        x = max(0, int((logical_w - width) / 2))
        y = max(0, int((logical_h - height) / 2))
    except Exception:
        pass
    return width, height, x, y


def base_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def setup_logging() -> None:
    try:
        log_path = config_dir() / "lector-md.log"
        handler = RotatingFileHandler(
            log_path, maxBytes=1_000_000, backupCount=2, encoding="utf-8"
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s  %(levelname)-7s  %(name)s  %(message)s")
        )
        logging.basicConfig(level=logging.INFO, handlers=[handler])
    except OSError:
        logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("Iniciando %s %s", APP_NAME, __version__)


def show_error(message: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    except Exception:
        print(message, file=sys.stderr)


def parse_cli() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="Lector MD",
        description="Un lector de archivos Markdown para Windows.",
    )
    parser.add_argument("path", nargs="?", help="Carpeta o archivo Markdown a abrir")
    parser.add_argument("--folder", help="Carpeta que se abrirá al iniciar")
    parser.add_argument("--debug", action="store_true", help="Abrir herramientas de desarrollo")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {__version__}")
    return parser.parse_args()


def resolve_initial(args: argparse.Namespace) -> tuple[Path | None, str | None]:
    raw = args.folder or args.path
    if not raw:
        return None, None
    candidate = Path(raw).expanduser()
    try:
        candidate = candidate.resolve()
    except OSError:
        return None, None
    if candidate.is_file() and is_markdown(candidate):
        return candidate.parent, candidate.name
    if candidate.is_dir():
        return candidate, None
    return None, None


def main() -> int:
    setup_logging()
    args = parse_cli()

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:
        pass

    root = base_dir()
    initial_folder, initial_file = resolve_initial(args)
    api = Api(root, initial_folder=initial_folder, initial_file=initial_file)
    icon = root / "assets" / "icon.ico"
    enable_dpi_awareness()
    width, height, pos_x, pos_y = window_geometry()

    try:
        window = webview.create_window(
            APP_NAME,
            url=(root / "ui" / "index.html").as_uri(),
            js_api=api,
            width=width,
            height=height,
            x=pos_x,
            y=pos_y,
            min_size=(min(900, width), min(620, height)),
            background_color="#F3F0E9",
            text_select=True,
            zoomable=False,
            confirm_close=False,
        )
        if window is None:
            show_error("No se pudo crear la ventana de la aplicación.")
            return 1
        api.set_window(window)
        webview.start(
            icon=str(icon) if icon.exists() else None,
            debug=args.debug,
            private_mode=False,
            storage_path=str(config_dir() / "webview"),
        )
    except Exception as exc:
        logging.getLogger(__name__).exception("No se pudo iniciar la interfaz")
        hint = (
            "Asegúrate de que Microsoft Edge WebView2 Runtime esté instalado."
            if sys.platform == "win32"
            else "Revisa las dependencias de pywebview y el registro de la aplicación."
        )
        show_error(
            "No se pudo iniciar Lector MD.\n\n"
            f"{hint}\n\n"
            f"Detalle: {exc}"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
