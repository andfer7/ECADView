"""Layer identity controls SVG paint, inspector swatches and WebGL colors."""

import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

import numpy as np
from altium_monkey import AltiumPcbDoc
from PySide6.QtGui import QColor, QGuiApplication

from pcbvisualizer.geometry.document import GeometryDocument
from pcbvisualizer.geometry.gpu_scene import build_scene
from pcbvisualizer.layer_colors import BASE_COLORS, layer_colors
from pcbvisualizer.rendering import render_file

APP = QGuiApplication.instance() or QGuiApplication([])
FIXTURE = Path(__file__).parent / "fixtures/kicad/demo.kicad_pcb"


def groups(data):
    root = ET.fromstring(data["svg"])
    scene = next(node for node in root.iter() if node.get("id") == "scene")
    return [node for node in scene if node.get("data-color")]


class LayerColorTests(unittest.TestCase):
    def test_many_layers_are_distinct_and_independent_of_input_order(self):
        tokens = [*BASE_COLORS, *(f"MID{i}" for i in range(1, 127)),
                  *(f"PLANE{i}" for i in range(1, 17)),
                  *(f"MECHANICAL{i}" for i in range(1, 256)),
                  "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "User.1", "User.2"]
        colors = layer_colors(tokens)
        self.assertEqual(len(colors), len(set(colors.values())))
        self.assertEqual(colors, layer_colors(reversed(tokens)))
        self.assertTrue(all(QColor(color).isValid() for color in colors.values()))
        self.assertEqual({key: colors[key] for key in BASE_COLORS}, BASE_COLORS)
        self.assertEqual(layer_colors(["F.Cu", "B.Cu", "In1.Cu"]),
                         {"F.Cu": colors["TOP"], "B.Cu": colors["BOTTOM"], "In1.Cu": colors["MID1"]})

    def test_rounding_collisions_are_resolved_and_existing_colors_reserved(self):
        with patch("pcbvisualizer.layer_colors.hashlib.sha256") as digest:
            digest.return_value.digest.return_value = bytes(32)
            first = layer_colors(["User.1", "User.2"])
            self.assertNotEqual(first["User.1"], first["User.2"])
            added = layer_colors(["User.0"], existing=first)
            self.assertNotIn(added["User.0"], first.values())

    def assert_gpu_colors(self, data):
        source_groups = groups(data)
        colors = {node.get("id"): node.get("data-color") for node in source_groups
                  if node.get("data-layer-role") != "drill"}
        self.assertEqual(len(colors), len(set(colors.values())))
        scene = build_scene(GeometryDocument(data))
        self.assertTrue(scene["supported"], scene.get("reason"))
        vertices = np.frombuffer(scene["vertices"], dtype=np.float32).reshape(-1, 20)
        indices = np.frombuffer(scene["indices"], dtype=np.uint32)
        checked = set()
        for entry in scene["entries"]:
            if entry["layer"] not in colors:
                continue
            first, count = entry["first"], entry["count"]
            actual = vertices[indices[first:first + count], 8:11]
            color = QColor(colors[entry["layer"]])
            expected = np.array([color.redF(), color.greenF(), color.blueF()])
            np.testing.assert_allclose(actual, np.broadcast_to(expected, actual.shape), atol=1e-6)
            checked.add(entry["layer"])
        self.assertEqual(checked, set(colors))

    def test_altium_inner_plane_and_extended_mechanical_paint_matches_swatches(self):
        tokens = ["TOP", "MID1", "MID2", "BOTTOM", "PLANE1", "PLANE2",
                  "TOPOVERLAY", "BOTTOMOVERLAY", "TOPPASTE", "BOTTOMPASTE",
                  "MECHANICAL1", "MECHANICAL2", "MECHANICAL17", "MECHANICAL18", "MECHANICAL53"]
        pcb = AltiumPcbDoc()
        for index, token in enumerate(tokens):
            pcb.add_track((100, 100 + index * 50), (800, 100 + index * 50),
                          width_mils=20, layer=token, net="N")
        pcb.add_via(position_mils=(900, 500), diameter_mils=40, hole_size_mils=20, net="N")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "colors.PcbDoc"
            pcb.save(path)
            original = path.read_bytes()
            data = render_file(path, native=True)
            actual = {node.get("data-layer-token"): node.get("data-color") for node in groups(data)}
            self.assertEqual(actual, layer_colors([*tokens, "TOPSOLDER", "BOTTOMSOLDER", "DRILLS"]))
            self.assertEqual(len(actual), len(set(actual.values())), "drills must not share the paste swatch")
            self.assert_gpu_colors(data)
            self.assertEqual(path.read_bytes(), original)

    def test_kicad_text_pours_technical_layers_and_sides_use_the_layer_palette(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "colors.kicad_pcb"
            # Existing fixture includes vias on every copper layer, text, pours,
            # mask and paste apertures. Add technical layers sharing old fallback.
            graphics = "".join(
                f'(gr_rect (start {index * 5} 32) (end {index * 5 + 3} 35) '
                f'(stroke (width 0.1) (type solid)) (fill solid) (layer "{layer}"))'
                for index, layer in enumerate(["F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab"])
            )
            path.write_text(FIXTURE.read_text().rstrip()[:-1] + graphics + ")")
            original = path.read_bytes()
            data = render_file(path)
            self.assert_gpu_colors(data)
            all_colors = {node.get("data-layer-token"): node.get("data-color") for node in groups(data)}
            for side in ("top", "bottom"):
                for node in groups(render_file(path, side=side)):
                    self.assertEqual(node.get("data-color"), all_colors[node.get("data-layer-token")])
            override = render_file(path, pour_color="#123456")
            root = ET.fromstring(override["svg"])
            pours = [node for node in root.iter() if node.get("data-primitive") == "region"]
            self.assertTrue(pours)
            self.assertTrue(all(node.get("fill") == "#123456" for node in pours))
            self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
