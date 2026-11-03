"""Lectura de carpetas, render seguro de Markdown y búsqueda de contenido."""

from __future__ import annotations

import base64
import codecs
import html as html_lib
import logging
import math
import mimetypes
import os
import re
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname

from markdown_it import MarkdownIt
from mdit_py_plugins.anchors import anchors_plugin
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from pygments import highlight as pygments_highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import TextLexer, get_lexer_by_name
from pygments.util import ClassNotFound

log = logging.getLogger(__name__)

MARKDOWN_EXTENSIONS = {".md", ".markdown", ".mdown", ".mkd", ".mdtext"}
# Extensión accidental frecuente al crear archivos desde Windows (nada.md.txt).
MARKDOWN_NAME_SUFFIXES = (".md.txt", ".markdown.txt")
SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".venv",
    "__pycache__",
    "node_modules",
    "venv",
}
MAX_FILES = 20_000
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_SEARCH_BYTES = 3 * 1024 * 1024
MAX_SEARCH_RESULTS = 120
MAX_SEARCH_FILES = 2_500
SEARCH_TIME_BUDGET = 8.0

IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
}


class ReaderError(Exception):
    """Error legible para mostrar en la interfaz."""


# --------------------------------------------------------------------------- utils
def natural_key(text: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", text)]


def is_within(root: Path, candidate: Path) -> bool:
    try:
        root_s = os.path.normcase(os.path.abspath(root))
        candidate_s = os.path.normcase(os.path.abspath(candidate))
        return os.path.commonpath([root_s, candidate_s]) == root_s
    except (ValueError, OSError):
        return False


def rel_posix(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def resolve_inside(root: Path, rel_path: str) -> Path:
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ReaderError("La ruta del archivo no es válida.")
    if "\x00" in rel_path:
        raise ReaderError("La ruta del archivo no es válida.")
    clean = rel_path.replace("\\", "/")
    if clean.startswith("/") or re.match(r"^[A-Za-z]:", clean):
        raise ReaderError("La ruta debe ser relativa a la carpeta abierta.")
    candidate = (root / clean).resolve()
    if not is_within(root, candidate):
        raise ReaderError("Ese archivo está fuera de la carpeta abierta.")
    return candidate


def is_markdown(path: Path) -> bool:
    name = path.name.casefold()
    return path.suffix.casefold() in MARKDOWN_EXTENSIONS or name.endswith(MARKDOWN_NAME_SUFFIXES)


def decode_bytes(data: bytes) -> tuple[str, str]:
    if data.startswith(codecs.BOM_UTF8):
        return data.decode("utf-8-sig"), "UTF-8"
    if data.startswith(codecs.BOM_UTF16_LE) or data.startswith(codecs.BOM_UTF16_BE):
        return data.decode("utf-16"), "UTF-16"
    if b"\x00" in data[:4096]:
        for encoding in ("utf-16-le", "utf-16-be"):
            try:
                text = data.decode(encoding)
                if "\x00" not in text[:4096]:
                    return text, "UTF-16"
            except UnicodeDecodeError:
                continue
    for encoding, label in (("utf-8", "UTF-8"), ("cp1252", "Windows-1252")):
        try:
            return data.decode(encoding), label
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1"), "Latin-1"


def read_text_file(path: Path, max_bytes: int = MAX_DOCUMENT_BYTES) -> tuple[str, str]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ReaderError("No se pudo acceder al archivo.") from exc
    if size > max_bytes:
        raise ReaderError(
            f"El archivo es demasiado grande para mostrarlo ({size / 1024 / 1024:.1f} MB)."
        )
    try:
        data = path.read_bytes()
    except PermissionError as exc:
        raise ReaderError("Windows no permitió leer este archivo.") from exc
    except OSError as exc:
        raise ReaderError("No se pudo leer el archivo.") from exc
    return decode_bytes(data)


def split_front_matter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = None
    for index in range(1, min(len(lines), 100)):
        if lines[index].strip() in {"---", "..."}:
            end = index
            break
    if end is None:
        return {}, text

    meta: dict[str, str] = {}
    for line in lines[1:end]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_-]{1,40})\s*:\s*(.*)$", line.rstrip())
        if not match:
            return {}, text
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        meta[match.group(1).lower()] = value[:500]
    if not meta:
        return {}, text
    body = "".join(lines[end + 1 :])
    return meta, body.lstrip("\r\n")


def plain_text(fragment: str) -> str:
    without_scripts = re.sub(
        r"<(script|style)\b[^>]*>.*?</\1>", " ", fragment, flags=re.IGNORECASE | re.DOTALL
    )
    without_tags = re.sub(r"<[^>]+>", " ", without_scripts)
    return re.sub(r"\s+", " ", html_lib.unescape(without_tags)).strip()


def extract_heading(rendered: str) -> str:
    match = re.search(r"<h1\b[^>]*>(.*?)</h1>", rendered, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return re.sub(r"\s+", " ", html_lib.unescape(re.sub(r"<[^>]+>", " ", match.group(1)))).strip()


def fold_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch)).casefold()


def fold_with_map(text: str) -> tuple[str, list[int]]:
    chars: list[str] = []
    positions: list[int] = []
    for index, char in enumerate(text):
        folded = fold_text(char)
        for item in folded:
            chars.append(item)
            positions.append(index)
    return "".join(chars), positions


def human_size(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


# --------------------------------------------------------------------------- scanner
def scan_folder(root: Path, max_files: int = MAX_FILES) -> dict[str, Any]:
    root = root.resolve()
    flat_files: list[dict[str, Any]] = []
    state = {"folders": 0, "truncated": False}

    def walk(directory: Path, rel: str) -> dict[str, Any] | None:
        try:
            entries = list(os.scandir(directory))
        except OSError as exc:
            log.warning("No se pudo leer la carpeta %s: %s", directory, exc)
            return None

        dirs: list[os.DirEntry[str]] = []
        files: list[os.DirEntry[str]] = []
        for entry in entries:
            name = entry.name
            if name.startswith(".") or name.lower() in SKIP_DIRS:
                continue
            try:
                if entry.is_symlink() or getattr(entry, "is_junction", lambda: False)():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    dirs.append(entry)
                elif entry.is_file(follow_symlinks=False) and is_markdown(Path(name)):
                    files.append(entry)
            except OSError:
                continue

        dirs.sort(key=lambda item: natural_key(item.name))
        files.sort(key=lambda item: natural_key(item.name))

        children: list[dict[str, Any]] = []
        count = 0
        for entry in dirs:
            if state["truncated"]:
                break
            child_rel = f"{rel}/{entry.name}" if rel else entry.name
            child = walk(Path(entry.path), child_rel)
            if child and child["count"]:
                children.append(child)
                count += child["count"]
                state["folders"] += 1

        for entry in files:
            if len(flat_files) >= max_files:
                state["truncated"] = True
                break
            try:
                stat = entry.stat(follow_symlinks=False)
                child_rel = f"{rel}/{entry.name}" if rel else entry.name
                node = {
                    "type": "file",
                    "name": entry.name,
                    "path": child_rel,
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                }
                children.append(node)
                flat_files.append(
                    {
                        "path": child_rel,
                        "name": entry.name,
                        "folder": rel,
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                    }
                )
                count += 1
            except OSError:
                continue

        return {
            "type": "dir",
            "name": directory.name or str(directory),
            "path": rel,
            "children": children,
            "count": count,
        }

    tree = walk(root, "")
    if tree is None:
        raise ReaderError("No se pudo leer la carpeta seleccionada.")
    tree["name"] = root.name or str(root)
    summary = {
        "name": root.name or str(root),
        "path": str(root),
        "file_count": len(flat_files),
        "folder_count": state["folders"],
        "truncated": state["truncated"],
    }
    return {"tree": tree, "files": flat_files, "summary": summary}


# --------------------------------------------------------------------------- renderer
class MarkdownRenderer:
    def __init__(self) -> None:
        self.md = MarkdownIt(
            "commonmark",
            {
                "html": False,
                "linkify": False,
                "typographer": True,
                "breaks": False,
                "quotes": "“”‘’",
            },
        )
        self.md.enable(["table", "strikethrough"])
        self.md.options["langPrefix"] = "language-"
        self.md.options["highlight"] = self._highlight
        self.md.use(footnote_plugin)
        self.md.use(tasklists_plugin, enabled=True, label=True)
        anchors_plugin(self.md, min_level=1, max_level=4, permalink=False)
        self._formatter = HtmlFormatter(nowrap=True)

    @staticmethod
    def _highlight(code: str, lang: str, _attrs: str) -> str:
        language = (lang or "").strip().split(maxsplit=1)[0] if lang else ""
        try:
            lexer = get_lexer_by_name(language, stripall=False) if language else TextLexer()
        except ClassNotFound:
            lexer = TextLexer()
        try:
            return pygments_highlight(code, lexer, HtmlFormatter(nowrap=True))
        except Exception:  # pragma: no cover - protección ante lexers exóticos
            return html_lib.escape(code)

    def render(self, source: str) -> str:
        return self.md.render(source)


class Library:
    """Una carpeta abierta y sus documentos."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        if not self.root.is_dir():
            raise ReaderError("La carpeta ya no existe o no es accesible.")
        self.renderer = MarkdownRenderer()
        self.scan_result = scan_folder(self.root)
        self.files = self.scan_result["files"]
        self.by_rel = {item["path"]: item for item in self.files}

    def suggested_file(self) -> str | None:
        """Documento inicial razonable: README, inicio o primer archivo de la raíz."""
        if not self.files:
            return None
        root_files = [item for item in self.files if "/" not in item["path"]]
        preferred = ("readme.md", "index.md", "inicio.md", "bienvenido.md", "home.md")
        for wanted in preferred:
            for item in root_files:
                if item["name"].casefold() == wanted:
                    return item["path"]
        if root_files:
            return root_files[0]["path"]
        return self.files[0]["path"]

    # --------------------------------------------------------------- documents
    def read_document(self, rel_path: str) -> dict[str, Any]:
        path = resolve_inside(self.root, rel_path)
        if not path.exists() or not path.is_file():
            raise ReaderError("No se encontró el archivo. Puede que se haya movido o eliminado.")
        if not is_markdown(path):
            raise ReaderError("El archivo seleccionado no es un documento Markdown.")
        try:
            stat = path.stat()
        except OSError as exc:
            raise ReaderError("No se pudo acceder al archivo.") from exc

        text, encoding = read_text_file(path)
        meta, body = split_front_matter(text)
        if not body.strip():
            body = "_Este documento está vacío._"

        rendered = self.renderer.render(body)
        rendered = self._convert_images(rendered, path)
        rendered = self._classify_links(rendered, path)

        title = meta.get("title") or extract_heading(rendered) or path.stem
        stats = self._stats(text, rendered)
        modified = datetime.fromtimestamp(stat.st_mtime).astimezone()
        rel = rel_posix(path, self.root)

        return {
            "path": rel,
            "absolute_path": str(path),
            "name": path.name,
            "title": title,
            "folder": rel.rsplit("/", 1)[0] if "/" in rel else "",
            "html": rendered,
            "meta": meta,
            "stats": stats,
            "encoding": encoding,
            "size": stat.st_size,
            "size_label": human_size(stat.st_size),
            "modified": modified.isoformat(timespec="seconds"),
            "modified_label": modified.strftime("%d/%m/%Y · %H:%M"),
        }

    @staticmethod
    def _stats(source: str, rendered: str) -> dict[str, Any]:
        text = plain_text(rendered)
        words = re.findall(r"[\wÀ-ÖØ-öø-ÿ]+(?:[’'\-][\wÀ-ÖØ-öø-ÿ]+)*", text)
        word_count = len(words)
        return {
            "words": word_count,
            "characters": len(text),
            "minutes": max(1, math.ceil(word_count / 220)) if word_count else 0,
            "lines": source.count("\n") + 1,
        }

    # ----------------------------------------------------------------- images
    def _convert_images(self, fragment: str, doc_path: Path) -> str:
        pattern = re.compile(r'(<img\b[^>]*?\bsrc=")([^"]*)("[^>]*>)', re.IGNORECASE)

        def replace(match: re.Match[str]) -> str:
            prefix, raw_src, suffix = match.group(1), match.group(2), match.group(3)
            tag = f"{prefix}{raw_src}{suffix}"
            src = html_lib.unescape(raw_src).strip()
            lower = src.lower()

            if lower.startswith(("https://", "http://", "//", "data:")):
                return self._add_img_attrs(tag)

            try:
                image_path = self._image_path(src, doc_path)
            except (ValueError, OSError):
                image_path = None

            if image_path is None:
                return self._image_placeholder(src, "Fuera de la carpeta")
            if not image_path.exists() or not image_path.is_file():
                return self._image_placeholder(src, "No encontrada")
            mime = IMAGE_MIME.get(image_path.suffix.lower())
            if not mime:
                guessed, _ = mimetypes.guess_type(image_path.name)
                if not guessed or not guessed.startswith("image/"):
                    return self._image_placeholder(src, "Formato no compatible")
                mime = guessed
            try:
                size = image_path.stat().st_size
                if size > MAX_IMAGE_BYTES:
                    return self._image_placeholder(
                        src, f"Imagen muy grande ({human_size(size)})"
                    )
                data = image_path.read_bytes()
            except OSError:
                return self._image_placeholder(src, "No se pudo leer")

            encoded = base64.b64encode(data).decode("ascii")
            new_tag = f'{prefix}data:{mime};base64,{encoded}"{suffix}'
            return self._add_img_attrs(new_tag)

        return pattern.sub(replace, fragment)

    @staticmethod
    def _add_img_attrs(tag: str) -> str:
        lower = tag.casefold()
        additions = []
        if "loading=" not in lower:
            additions.append('loading="lazy"')
        if "decoding=" not in lower:
            additions.append('decoding="async"')
        if not additions:
            return tag
        suffix = " " + " ".join(additions)
        if tag.endswith("/>"):
            return tag[:-2].rstrip() + suffix + " />"
        if tag.endswith(">"):
            return tag[:-1].rstrip() + suffix + ">"
        return tag

    def _image_path(self, src: str, doc_path: Path) -> Path | None:
        if not src:
            return None
        parsed = urlparse(src)
        if parsed.scheme.lower() == "file":
            raw_path = url2pathname(unquote(parsed.path))
            if re.match(r"^/[A-Za-z]:", raw_path):
                raw_path = raw_path[1:]
            candidate = Path(raw_path)
        elif re.match(r"^[A-Za-z]:[\\/]", src):
            candidate = Path(unquote(src))
        elif parsed.scheme:
            return None
        else:
            value = unquote(parsed.path)
            if value.startswith("/"):
                candidate = self.root / value.lstrip("/")
            else:
                candidate = doc_path.parent / value.replace("/", os.sep)
        candidate = candidate.resolve()
        if not is_within(self.root, candidate):
            return None
        return candidate

    @staticmethod
    def _image_placeholder(src: str, reason: str) -> str:
        label = html_lib.escape(src, quote=True)[:160]
        return (
            f'<span class="image-missing" title="{html_lib.escape(reason, quote=True)}">'
            f'<span class="image-missing-icon">▧</span> Imagen no disponible'
            f' <span class="image-missing-reason">({html_lib.escape(reason)})</span>'
            f'<code>{label}</code></span>'
        )

    # ------------------------------------------------------------------ links
    def _classify_links(self, fragment: str, doc_path: Path) -> str:
        pattern = re.compile(r'(<a\b[^>]*?\bhref=")([^"]*)("[^>]*>)', re.IGNORECASE)

        def replace(match: re.Match[str]) -> str:
            prefix, raw_href, suffix = match.group(1), match.group(2), match.group(3)
            href = html_lib.unescape(raw_href).strip()
            if not href:
                return self._attr(f"{prefix}{raw_href}{suffix}", "data-broken-link", "true")

            lower = href.lower()
            if lower.startswith(("http://", "https://", "mailto:")):
                tag = self._attr(f"{prefix}{raw_href}{suffix}", "data-external", "true")
                return self._attr(tag, "rel", "noopener noreferrer")

            if href.startswith("#"):
                return f"{prefix}{raw_href}{suffix}"

            parsed = urlparse(href)
            if parsed.scheme.lower() in {"javascript", "vbscript", "data"}:
                safe = f'{prefix}#{suffix}'
                return self._attr(safe, "data-broken-link", "true")

            try:
                target = self._link_path(href, doc_path)
            except (ValueError, OSError):
                return self._attr(f"{prefix}{raw_href}{suffix}", "data-broken-link", "true")

            if target is None or not is_within(self.root, target):
                return self._attr(f"{prefix}{raw_href}{suffix}", "data-broken-link", "true")
            if not target.exists():
                return self._attr(f"{prefix}{raw_href}{suffix}", "data-broken-link", "true")

            rel = rel_posix(target, self.root)
            tag = f"{prefix}{raw_href}{suffix}"
            if target.is_dir():
                return self._attr(tag, "data-folder-path", rel)
            if is_markdown(target):
                tag = self._attr(tag, "data-md-path", rel)
                if parsed.fragment:
                    tag = self._attr(tag, "data-md-fragment", parsed.fragment)
                return tag
            return self._attr(tag, "data-file-path", rel)

        return pattern.sub(replace, fragment)

    def _link_path(self, href: str, doc_path: Path) -> Path | None:
        parsed = urlparse(href)
        if parsed.scheme.lower() == "file":
            raw_path = url2pathname(unquote(parsed.path))
            if re.match(r"^/[A-Za-z]:", raw_path):
                raw_path = raw_path[1:]
            return Path(raw_path).resolve()
        if parsed.scheme:
            return None
        value = unquote(parsed.path)
        if re.match(r"^[A-Za-z]:[\\/]", value):
            return Path(value).resolve()
        if value.startswith("/"):
            return (self.root / value.lstrip("/")).resolve()
        if not value:
            return None
        return (doc_path.parent / value.replace("/", os.sep)).resolve()

    @staticmethod
    def _attr(tag: str, name: str, value: str) -> str:
        if re.search(rf"\b{re.escape(name)}=", tag, flags=re.IGNORECASE):
            return tag
        escaped = html_lib.escape(value, quote=True)
        if tag.endswith("/>"):
            return tag[:-2].rstrip() + f' {name}="{escaped}" />'
        if tag.endswith(">"):
            return tag[:-1].rstrip() + f' {name}="{escaped}">'
        return tag

    # ----------------------------------------------------------------- search
    def search(self, query: str, limit: int = MAX_SEARCH_RESULTS) -> dict[str, Any]:
        needle_raw = (query or "").strip()
        if len(needle_raw) < 2:
            raise ReaderError("Escribe al menos dos caracteres para buscar.")
        needle = fold_text(needle_raw)
        results: list[dict[str, Any]] = []
        scanned = 0
        started = time.monotonic()
        truncated = False

        for item in self.files:
            if len(results) >= limit or scanned >= MAX_SEARCH_FILES:
                truncated = True
                break
            if time.monotonic() - started > SEARCH_TIME_BUDGET:
                truncated = True
                break
            if item["size"] > MAX_SEARCH_BYTES:
                continue
            path = self.root / item["path"]
            try:
                data = path.read_bytes()
                text, _ = decode_bytes(data)
            except OSError:
                continue
            scanned += 1
            hits_in_file = 0
            for line_number, line in enumerate(text.splitlines(), start=1):
                folded, positions = fold_with_map(line)
                index = folded.find(needle)
                if index < 0:
                    continue
                end_folded = index + len(needle)
                start_original = positions[index] if index < len(positions) else 0
                end_original = positions[end_folded - 1] + 1 if end_folded - 1 < len(positions) else start_original + len(needle_raw)
                content = line.strip()
                if not content:
                    continue
                leading = len(line) - len(line.lstrip())
                start_in_content = max(0, start_original - leading)
                end_in_content = max(start_in_content + 1, min(len(content), end_original - leading))
                window = 70
                start = max(0, start_in_content - window)
                end = min(len(content), end_in_content + window)
                prefix = "…" if start > 0 else ""
                suffix = "…" if end < len(content) else ""
                snippet = prefix + content[start:end] + suffix
                results.append(
                    {
                        "path": item["path"],
                        "name": item["name"],
                        "folder": item["folder"],
                        "line": line_number,
                        "snippet": snippet,
                        "match_start": start_in_content - start + (1 if prefix else 0),
                        "match_length": max(1, end_in_content - start_in_content),
                    }
                )
                hits_in_file += 1
                if hits_in_file >= 3 or len(results) >= limit:
                    break
        return {
            "query": needle_raw,
            "results": results,
            "scanned": scanned,
            "total_files": len(self.files),
            "truncated": truncated,
        }
