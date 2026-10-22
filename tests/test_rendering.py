"""Run with: .venv/bin/python -B -m unittest discover -s tests -v."""
import hashlib
from io import BytesIO
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zlib

import freetype
from altium_monkey.altium_embedded_files import EmbeddedFont
from altium_monkey import (
    AltiumSchComponent, AltiumSchDesignator, AltiumSchDoc, SchPointMils, SchRectMils,
    make_sch_net_label, make_sch_rectangle, make_sch_wire,
)

from pcb_viewer_gui import (
    AltiumPcbDoc, get_font_path_with_style, prepare_embedded_fonts, render_file, resolve_polygon_nets,
)


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


class PolygonNetTests(unittest.TestCase):
    def test_poured_copper_inherits_its_polygon_net_in_both_region_streams_and_hatched_fills(self):
        pcb = SimpleNamespace(nets=[object(), object()], polygons=[SimpleNamespace(net=1)])
        for collection in ("regions", "shapebased_regions", "tracks", "arcs", "fills"):
            setattr(pcb, collection, [SimpleNamespace(net_index=None, polygon_index=0),
                                      SimpleNamespace(net_index=0xFFFF, polygon_index=0)])
        resolve_polygon_nets(pcb)
        for collection in ("regions", "shapebased_regions", "tracks", "arcs", "fills"):
            with self.subTest(collection=collection):
                self.assertEqual([p.net_index for p in getattr(pcb, collection)], [1, 1])

    def test_existing_primitive_net_wins_over_the_polygon_net(self):
        primitive = SimpleNamespace(net_index=0, polygon_index=0)
        pcb = SimpleNamespace(nets=[object(), object()], polygons=[SimpleNamespace(net=1)], regions=[primitive])
        resolve_polygon_nets(pcb)
        self.assertEqual(primitive.net_index, 0)

    def test_first_net_is_a_valid_polygon_connection(self):
        primitive = SimpleNamespace(net_index=0xFFFF, polygon_index=0)
        pcb = SimpleNamespace(nets=[object()], polygons=[SimpleNamespace(net=0)], regions=[primitive])
        resolve_polygon_nets(pcb)
        self.assertEqual(primitive.net_index, 0)

    def test_unlinked_or_invalid_polygon_connections_stay_unlinked(self):
        for polygon_index in (None, -1, 1, 0xFFFF, 0xFFFFFFFF):
            with self.subTest(polygon_index=polygon_index):
                primitive = SimpleNamespace(net_index=None, polygon_index=polygon_index)
                pcb = SimpleNamespace(nets=[object()], polygons=[SimpleNamespace(net=0)], regions=[primitive])
                resolve_polygon_nets(pcb)
                self.assertIsNone(primitive.net_index)
        for net_index in (None, -1, 1, 0xFFFF, 0xFFFFFFFF):
            with self.subTest(net_index=net_index):
                primitive = SimpleNamespace(net_index=0xFFFF, polygon_index=0)
                pcb = SimpleNamespace(nets=[object()], polygons=[SimpleNamespace(net=net_index)], regions=[primitive])
                resolve_polygon_nets(pcb)
                self.assertEqual(primitive.net_index, 0xFFFF)


class SchematicTests(unittest.TestCase):
    def test_selection_follows_connected_nets_and_source_components(self):
        schematic = AltiumSchDoc()
        component = AltiumSchComponent()
        schematic.add_object(component)
        designator = AltiumSchDesignator(); designator.text = 'U[1]&"'
        schematic.add_object(designator, owner=component)
        body = make_sch_rectangle(bounds_mils=SchRectMils(500, 500, 700, 700))
        schematic.add_object(body, owner=component)
        wires = []
        for points, name in [([(100, 100), (500, 100)], "GND"),
                             ([(300, 0), (300, 200)], "SIGNAL"),
                             ([(100, 400), (500, 400)], "GND")]:
            wire = make_sch_wire(points_mils=[SchPointMils(*point) for point in points])
            wires.append(wire)
            schematic.add_object(wire)
            schematic.add_object(make_sch_net_label(location_mils=SchPointMils(*points[0]), text=name))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "selection.SchDoc"
            schematic.save(path)
            data = render_file(path)
        nets = {net["name"]: set(net["elements"]) for net in data["selection"]["nets"]}
        self.assertEqual(set(nets), {"GND", "SIGNAL"}, "Wire-only nets must be selectable")
        self.assertIn(wires[0].unique_id, nets["GND"])
        self.assertIn(wires[2].unique_id, nets["GND"], "Disconnected same-name labels belong to the same net")
        self.assertNotIn(wires[1].unique_id, nets["GND"], "A crossing without a junction must not merge nets")
        self.assertIn(wires[1].unique_id, nets["SIGNAL"])
        selection = data["selection"]["components"]
        self.assertEqual(selection, [{"id": component.unique_id, "name": 'U[1]&"', "elements": [component.unique_id],
                                      "body_elements": [body.unique_id]}])
        svg_ids = {element.get("id") for element in ET.fromstring(data["svg"]).iter()}
        for row in data["selection"]["nets"] + selection:
            self.assertTrue(set(row["elements"]) <= svg_ids)

    def test_parses_and_renders_a_saved_schematic_without_modifying_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sheet.sChDoC"
            schematic = AltiumSchDoc()
            schematic.add_object(make_sch_wire(points_mils=[SchPointMils(100, 100), SchPointMils(400, 100)]))
            schematic.save(path)
            original = path.read_bytes()
            data = render_file(path)
            root = ET.fromstring(data["svg"])
            self.assertEqual(data["kind"], "schematic")
            self.assertEqual(data["name"], path.name)
            self.assertEqual(data["stats"], {"components": 0, "wires": 1, "net_labels": 0})
            self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
            self.assertTrue(root.get("viewBox"))
            self.assertIsNotNone(root.find(".//*[@id='scene']"))
            self.assertEqual(path.read_bytes(), original)

    def test_unsupported_files_report_supported_formats(self):
        with self.assertRaisesRegex(ValueError, r"PcbDoc.*SchDoc"):
            render_file(Path("notes.txt"))

    @unittest.skipUnless(os.environ.get("SCH_TEST_FILE"), "Set SCH_TEST_FILE to exercise a real schematic")
    def test_real_schematic_renders_components_wires_and_text(self):
        path = Path(os.environ["SCH_TEST_FILE"])
        original = hashlib.sha256(path.read_bytes()).digest()
        data = render_file(path)
        root = ET.fromstring(data["svg"])
        self.assertGreater(data["stats"]["components"], 0)
        self.assertGreater(data["stats"]["wires"], 0)
        self.assertIsNotNone(root.find(".//{http://www.w3.org/2000/svg}text"))
        svg_ids = {element.get("id") for element in root.iter()}
        self.assertEqual(len(data["selection"]["components"]), data["stats"]["components"])
        self.assertTrue(all(row["id"] in svg_ids for row in data["selection"]["components"]))
        self.assertTrue(all(row["body_elements"] for row in data["selection"]["components"]))
        pin_ids = {element.unique_id for component in AltiumSchDoc(path).get_components() for element in component.pins}
        for row in data["selection"]["components"]:
            self.assertTrue(set(row["body_elements"]) <= svg_ids)
            self.assertFalse(set(row["body_elements"]) & pin_ids, "Body targets must exclude pin/net graphics")
        ground = next(net for net in data["selection"]["nets"] if net["name"] == "GND")
        self.assertGreater(len(ground["elements"]), 2)
        self.assertTrue(set(ground["elements"]) <= svg_ids)
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)


@unittest.skipUnless(os.environ.get("PCB_TEST_FILE"), "Set PCB_TEST_FILE to exercise a real PCB layout")
class RealBoardTests(unittest.TestCase):
    def test_real_polygon_copper_gets_net_metadata_without_changing_its_shape(self):
        path = Path(os.environ["PCB_TEST_FILE"])
        for legacy_regions in (False, True):
            with self.subTest(legacy_regions=legacy_regions):
                pcb = AltiumPcbDoc.from_file(path)
                if legacy_regions:
                    pcb.shapebased_regions = []
                with patch("pcb_viewer_gui.AltiumPcbDoc.from_file", return_value=pcb):
                    with patch("pcb_viewer_gui.resolve_polygon_nets"):
                        before = ET.fromstring(render_file(path)["svg"])
                    after = ET.fromstring(render_file(path)["svg"])
                kind = "region" if legacy_regions else "shapebased-region"
                pours = [e for e in after.iter() if e.get("data-primitive") == kind and e.get("data-net") == "GND"]
                self.assertTrue(pours, "GND pour must participate in net search")
                originals = {e.get("id"): e for e in before.iter() if e.get("data-primitive") == kind}
                for pour in pours:
                    self.assertEqual(pour.get("d"), originals[pour.get("id")].get("d"))
                    self.assertEqual(pour.get("fill-rule"), "evenodd")

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
