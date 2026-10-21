"""Run with: .venv/bin/python -B -m unittest discover -s tests -v."""
import hashlib
from io import BytesIO
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zlib

import freetype
from altium_monkey.altium_embedded_files import EmbeddedFont

from pcb_viewer_gui import get_font_path_with_style, prepare_embedded_fonts, render_file


def embedded_font(data, name="Arial", style="Regular"):
    return EmbeddedFont(name=name, style=style, compressed_data=zlib.compress(data), raw_data=b"")


class EmbeddedFontTests(unittest.TestCase):
    def test_readable_embedded_fonts_are_preserved(self):
        data = Path(get_font_path_with_style("Arial")).read_bytes()
        font = embedded_font(data)
        pcb = SimpleNamespace(embedded_fonts=[font])
        self.assertEqual(prepare_embedded_fonts(pcb), [])
        self.assertIs(pcb.embedded_fonts[0], font)
        self.assertEqual(font.decompress(), data)

    def test_unreadable_font_is_replaced_without_changing_other_fonts(self):
        original = embedded_font(b"broken font", "Cambria")
        valid = embedded_font(Path(get_font_path_with_style("Arial")).read_bytes())
        pcb = SimpleNamespace(embedded_fonts=[original, valid])
        warnings = prepare_embedded_fonts(pcb)
        self.assertEqual(len(warnings), 1)
        self.assertIn('"Cambria"', warnings[0])
        self.assertIn("Text shape and spacing may differ", warnings[0])
        self.assertIs(pcb.embedded_fonts[1], valid)
        self.assertEqual(original.decompress(), b"broken font")
        self.assertGreater(freetype.Face(BytesIO(pcb.embedded_fonts[0].decompress())).num_glyphs, 0)

    def test_font_style_is_used_for_replacement(self):
        replacement = get_font_path_with_style("Arial", bold=True, italic=True)
        pcb = SimpleNamespace(embedded_fonts=[embedded_font(b"broken", "Arial", "Bold Italic")])
        with patch("pcb_viewer_gui.get_font_path_with_style", return_value=replacement) as resolve:
            prepare_embedded_fonts(pcb)
        resolve.assert_called_once_with("Arial", bold=True, italic=True)

    def test_missing_replacement_reports_the_font(self):
        pcb = SimpleNamespace(embedded_fonts=[embedded_font(b"broken", "Cambria")])
        with patch("pcb_viewer_gui.get_font_path_with_style", return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Cambria.*no replacement font'):
                prepare_embedded_fonts(pcb)

    def test_unreadable_replacement_reports_the_font(self):
        pcb = SimpleNamespace(embedded_fonts=[embedded_font(b"broken", "Cambria")])
        with patch("pcb_viewer_gui.get_font_path_with_style", return_value="/missing/font.ttf"):
            with self.assertRaisesRegex(RuntimeError, 'replacement.*Cambria'):
                prepare_embedded_fonts(pcb)

    def test_unrelated_parse_errors_are_not_hidden(self):
        with patch("pcb_viewer_gui.AltiumPcbDoc.from_file", side_effect=ValueError("Invalid PCB")):
            with self.assertRaisesRegex(ValueError, "Invalid PCB"):
                render_file(Path("invalid.PcbDoc"))


@unittest.skipUnless(os.environ.get("PCB_TEST_FILE"), "Set PCB_TEST_FILE to exercise a real PCB layout")
class RealBoardTests(unittest.TestCase):
    def test_renders_all_views_without_modifying_source(self):
        path = Path(os.environ["PCB_TEST_FILE"])
        original_digest = hashlib.sha256(path.read_bytes()).digest()
        for side in ("all", "top", "bottom"):
            with self.subTest(side=side):
                data = render_file(path, side=side)
                self.assertEqual(ET.fromstring(data["svg"]).tag, "{http://www.w3.org/2000/svg}svg")
                self.assertGreater(data["stats"]["components"], 0)
                self.assertNotIn("data-text-fallback", data["svg"])
                self.assertEqual(len(data["warnings"]), 1)
                self.assertIn("Cambria", data["warnings"][0])
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original_digest)


if __name__ == "__main__":
    unittest.main()
