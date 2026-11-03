from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lector_md.library import (  # noqa: E402
    Library,
    ReaderError,
    decode_bytes,
    is_markdown,
    resolve_inside,
    scan_folder,
    split_front_matter,
)
from lector_md.settings import SettingsStore  # noqa: E402


class LibraryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = ROOT / "tests" / "tmp" / self._testMethodName
        if self.base.exists():
            shutil.rmtree(self.base, ignore_errors=True)
        (self.base / "docs" / "recetas").mkdir(parents=True)
        (self.base / "docs" / "imagenes").mkdir(parents=True)
        (self.base / "docs" / "node_modules").mkdir(parents=True)
        (self.base / "docs" / ".oculto").mkdir(parents=True)

        (self.base / "docs" / "inicio.md").write_text(
            "---\n"
            'title: "Manual de inicio"\n'
            "author: Ana\n"
            "---\n\n"
            "# Bienvenido\n\n"
            "Esto es **importante** y `código`.\n\n"
            "| Nombre | Valor |\n"
            "| --- | --- |\n"
            "| uno | 1 |\n\n"
            "- [x] tarea hecha\n"
            "- [ ] tarea pendiente\n\n"
            "```python\nprint('hola')\n```\n\n"
            "[Otra receta](recetas/sopa.md#pasos)\n"
            "[Fuera](https://example.com)\n"
            "[Roto](no-existe.md)\n\n"
            "![Diagrama](imagenes/diagrama.png)\n"
            "![Falta](imagenes/falta.png)\n",
            encoding="utf-8",
        )
        (self.base / "docs" / "imagenes" / "diagrama.png").write_bytes(
            b"\x89PNG\r\n\x1a\nfake-image-data"
        )
        (self.base / "docs" / "recetas" / "sopa.md").write_text(
            "# Sopa de verduras\n\n## Pasos\n\nCortá las verduras y cociná 20 minutos.\n\n"
            "La preparación requiere paciencia y una olla grande.\n",
            encoding="utf-8",
        )
        (self.base / "docs" / "recetas" / "postre.md").write_text(
            "# Postre\n\nMezclar azúcar y limón.\n",
            encoding="utf-8",
        )
        (self.base / "docs" / "node_modules" / "ignorar.md").write_text("# No\n", encoding="utf-8")
        (self.base / "docs" / ".oculto" / "ignorar.md").write_text("# No\n", encoding="utf-8")
        (self.base / "docs" / "notas.txt").write_text("No es markdown\n", encoding="utf-8")

        self.root = self.base / "docs"
        self.library = Library(self.root)

    def tearDown(self) -> None:
        if self.base.exists():
            shutil.rmtree(self.base, ignore_errors=True)

    def test_scan_filters_and_sorts(self) -> None:
        scan = scan_folder(self.root)
        self.assertEqual(scan["summary"]["file_count"], 3)
        self.assertEqual(scan["summary"]["folder_count"], 1)
        names = [item["name"] for item in scan["files"]]
        self.assertIn("inicio.md", names)
        self.assertNotIn("ignorar.md", names)
        self.assertNotIn("notas.txt", names)
        dirs = [child["name"] for child in scan["tree"]["children"] if child["type"] == "dir"]
        self.assertEqual(dirs, ["recetas"])

    def test_nested_markdown_and_md_txt(self) -> None:
        nested = self.root / "otros" / "mas"
        nested.mkdir(parents=True)
        note = nested / "nota.md.txt"
        note.write_text("# Nota anidada\n\nContenido en una subcarpeta.", encoding="utf-8")
        self.assertTrue(is_markdown(note))

        scan = scan_folder(self.root)
        paths = [item["path"] for item in scan["files"]]
        self.assertIn("otros/mas/nota.md.txt", paths)
        otros = next(child for child in scan["tree"]["children"] if child["name"] == "otros")
        self.assertEqual(otros["count"], 1)
        mas = next(child for child in otros["children"] if child["name"] == "mas")
        self.assertEqual(mas["children"][0]["path"], "otros/mas/nota.md.txt")

        library = Library(self.root)
        document = library.read_document("otros/mas/nota.md.txt")
        self.assertIn("Nota anidada", document["html"])
        self.assertIn("otros/mas/nota.md.txt", [item["path"] for item in library.files])

    def test_read_document_renders_and_rewrites(self) -> None:
        doc = self.library.read_document("inicio.md")
        self.assertEqual(doc["title"], "Manual de inicio")
        self.assertEqual(doc["meta"]["author"], "Ana")
        self.assertIn("<table>", doc["html"])
        self.assertIn("language-python", doc["html"])
        self.assertIn("task-list-item", doc["html"])
        self.assertNotIn("title: Manual", doc["html"])
        self.assertIn("data:image/png;base64,", doc["html"])
        self.assertIn("image-missing", doc["html"])
        self.assertIn('data-md-path="recetas/sopa.md"', doc["html"])
        self.assertIn('data-md-fragment="pasos"', doc["html"])
        self.assertIn('data-external="true"', doc["html"])
        self.assertIn('data-broken-link="true"', doc["html"])
        self.assertGreater(doc["stats"]["words"], 10)
        self.assertEqual(doc["encoding"], "UTF-8")

    def test_path_traversal_rejected(self) -> None:
        with self.assertRaises(ReaderError):
            resolve_inside(self.root, "../secreto.md")
        with self.assertRaises(ReaderError):
            resolve_inside(self.root, "C:/Windows/win.ini")
        with self.assertRaises(ReaderError):
            resolve_inside(self.root, "/etc/passwd")
        with self.assertRaises(ReaderError):
            self.library.read_document("../notas.txt")

    def test_search_accent_insensitive(self) -> None:
        result = self.library.search("azucar")
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["results"][0]["path"], "recetas/postre.md")
        self.assertEqual(result["query"], "azucar")
        hit = result["results"][0]
        self.assertEqual(hit["snippet"][hit["match_start"] : hit["match_start"] + hit["match_length"]], "azúcar")

    def test_search_minimum_length(self) -> None:
        with self.assertRaises(ReaderError):
            self.library.search("a")

    def test_relative_image_and_link(self) -> None:
        doc = self.library.read_document("recetas/sopa.md")
        self.assertIn("Sopa de verduras", doc["html"])
        self.assertNotIn("data:image", doc["html"])

    def test_encoding_fallbacks(self) -> None:
        text, label = decode_bytes("Información en español".encode("cp1252"))
        self.assertEqual(text, "Información en español")
        self.assertEqual(label, "Windows-1252")
        utf16 = "Hola mundo".encode("utf-16")
        text, label = decode_bytes(utf16)
        self.assertEqual(text, "Hola mundo")
        self.assertEqual(label, "UTF-16")

    def test_front_matter_invalid_is_content(self) -> None:
        meta, body = split_front_matter("---\nNo es clave\n---\nTexto")
        self.assertEqual(meta, {})
        self.assertIn("No es clave", body)


class SettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = ROOT / "tests" / "tmp" / f"settings-{self._testMethodName}"
        if self.base.exists():
            shutil.rmtree(self.base)
        self.base.mkdir(parents=True)
        self.path = self.base / "settings.json"
        self.store = SettingsStore(self.path)

    def tearDown(self) -> None:
        if self.base.exists():
            shutil.rmtree(self.base, ignore_errors=True)

    def test_roundtrip_and_validation(self) -> None:
        self.store.update({"theme": "dark", "font_size": 99})
        self.assertEqual(self.store.data["theme"], "dark")
        self.assertEqual(self.store.data["font_size"], 24)
        reloaded = SettingsStore(self.path)
        self.assertEqual(reloaded.data["theme"], "dark")
        self.assertEqual(reloaded.public()["font_size"], 24)

    def test_recents(self) -> None:
        folder = self.base / "docs"
        folder.mkdir()
        self.store.remember_folder(folder)
        recent = self.store.recent_folders()
        self.assertEqual(recent[0]["path"], str(folder.resolve()))
        self.assertTrue(recent[0]["available"])
        self.assertEqual(self.store.last_folder(), folder.resolve())


if __name__ == "__main__":
    unittest.main(verbosity=2)
