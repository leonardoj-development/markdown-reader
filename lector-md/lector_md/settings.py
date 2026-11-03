"""Persistencia de preferencias y carpetas recientes."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from . import APP_NAME

log = logging.getLogger(__name__)

DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "system",
    "font_size": 17,
    "sidebar_open": True,
    "sidebar_width": 288,
    "toc_visible": True,
    "last_folder": None,
    "last_files": {},
    "recents": [],
}

MAX_RECENTS = 8
MAX_LAST_FILES = 30


def config_dir() -> Path:
    """Carpeta de configuración del usuario, con alternativa portable."""
    base = os.environ.get("APPDATA")
    if base:
        path = Path(base) / "LectorMD"
    else:
        path = Path.home() / ".lector-md"
    try:
        path.mkdir(parents=True, exist_ok=True)
        return path
    except OSError:
        fallback = Path.home() / ".lector-md"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


class SettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (config_dir() / "settings.json")
        self.data: dict[str, Any] = dict(DEFAULT_SETTINGS)
        self.load()

    # ------------------------------------------------------------------ load
    def load(self) -> None:
        try:
            raw = self.path.read_text(encoding="utf-8")
            loaded = json.loads(raw)
            if isinstance(loaded, dict):
                self.data = self._sanitize(loaded)
        except FileNotFoundError:
            pass
        except (OSError, ValueError) as exc:
            log.warning("No se pudieron leer los ajustes: %s", exc)

    def _sanitize(self, raw: dict[str, Any]) -> dict[str, Any]:
        data = dict(DEFAULT_SETTINGS)
        theme = raw.get("theme")
        if theme in {"light", "dark", "system"}:
            data["theme"] = theme
        try:
            data["font_size"] = max(14, min(24, int(raw.get("font_size", 17))))
        except (TypeError, ValueError):
            data["font_size"] = 17
        for key in ("sidebar_open", "toc_visible"):
            if isinstance(raw.get(key), bool):
                data[key] = raw[key]
        try:
            data["sidebar_width"] = max(240, min(420, int(raw.get("sidebar_width", 288))))
        except (TypeError, ValueError):
            data["sidebar_width"] = 288

        recents: list[dict[str, Any]] = []
        for item in raw.get("recents", []) if isinstance(raw.get("recents"), list) else []:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            if not isinstance(path, str) or not path:
                continue
            recents.append(
                {
                    "path": path,
                    "name": item.get("name") if isinstance(item.get("name"), str) else Path(path).name,
                    "opened": item.get("opened") if isinstance(item.get("opened"), str) else "",
                }
            )
        data["recents"] = recents[:MAX_RECENTS]

        last_files = raw.get("last_files")
        if isinstance(last_files, dict):
            clean: dict[str, str] = {}
            for key, value in list(last_files.items())[-MAX_LAST_FILES:]:
                if isinstance(key, str) and isinstance(value, str):
                    clean[key] = value
            data["last_files"] = clean

        last_folder = raw.get("last_folder")
        if isinstance(last_folder, str) and last_folder:
            data["last_folder"] = last_folder
        return data

    # ------------------------------------------------------------------ save
    def save(self) -> bool:
        payload = json.dumps(self.data, ensure_ascii=False, indent=2)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(payload, encoding="utf-8")
            try:
                tmp.replace(self.path)
            except OSError:
                # Dropbox, antivirus u otro proceso pueden bloquear el reemplazo.
                self.path.write_text(payload, encoding="utf-8")
            return True
        except OSError as exc:
            log.warning("No se pudieron guardar los ajustes: %s", exc)
            return False

    # --------------------------------------------------------------- updates
    def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            return self.public()

        if patch.get("theme") in {"light", "dark", "system"}:
            self.data["theme"] = patch["theme"]
        if "font_size" in patch:
            try:
                self.data["font_size"] = max(14, min(24, int(patch["font_size"])))
            except (TypeError, ValueError):
                pass
        for key in ("sidebar_open", "toc_visible"):
            if isinstance(patch.get(key), bool):
                self.data[key] = patch[key]
        if "sidebar_width" in patch:
            try:
                self.data["sidebar_width"] = max(240, min(420, int(patch["sidebar_width"])))
            except (TypeError, ValueError):
                pass
        self.save()
        return self.public()

    def public(self) -> dict[str, Any]:
        return {
            "theme": self.data["theme"],
            "font_size": self.data["font_size"],
            "sidebar_open": self.data["sidebar_open"],
            "sidebar_width": self.data["sidebar_width"],
            "toc_visible": self.data["toc_visible"],
        }

    # ------------------------------------------------------------- recents
    def remember_folder(self, path: Path) -> None:
        resolved = str(path)
        recents = [
            item
            for item in self.data.get("recents", [])
            if os.path.normcase(item.get("path", "")) != os.path.normcase(resolved)
        ]
        recents.insert(
            0,
            {
                "path": resolved,
                "name": path.name or resolved,
                "opened": datetime.now().astimezone().isoformat(timespec="seconds"),
            },
        )
        self.data["recents"] = recents[:MAX_RECENTS]
        self.data["last_folder"] = resolved
        self.save()

    def remember_file(self, root: Path, rel_path: str) -> None:
        key = str(root)
        last = dict(self.data.get("last_files", {}))
        last.pop(key, None)
        last[key] = rel_path
        if len(last) > MAX_LAST_FILES:
            last = dict(list(last.items())[-MAX_LAST_FILES:])
        self.data["last_files"] = last
        self.save()

    def last_file_for(self, root: Path) -> str | None:
        value = self.data.get("last_files", {}).get(str(root))
        return value if isinstance(value, str) else None

    def recent_folders(self) -> list[dict[str, Any]]:
        result = []
        for item in self.data.get("recents", []):
            entry = dict(item)
            entry["available"] = Path(entry["path"]).is_dir()
            result.append(entry)
        return result

    def last_folder(self) -> Path | None:
        value = self.data.get("last_folder")
        if not isinstance(value, str):
            return None
        path = Path(value)
        return path if path.is_dir() else None
