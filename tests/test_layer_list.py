"""Physical copper order in the inspector must not change paint order."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import sexpdata
from altium_monkey import AltiumPcbDoc
from altium_monkey.altium_pcbdoc_layer_stack_builder import PcbDocLayerStackTemplate
from PySide6.QtGui import QGuiApplication

from ecadview.geometry.document import GeometryDocument
from ecadview.kicad_common import form, load
from ecadview.rendering import copper_layer_order, render_file

APP = QGuiApplication.instance() or QGuiApplication([])
FIXTURE = Path(__file__).parent / "fixtures" / "kicad" / "demo.kicad_pcb"


def save_stack(path):
    base = PcbDocLayerStackTemplate.four_layer_fr4()
    top, first, second, bottom = base.copper_layers
    first = replace(
        first, legacy_layer_id=10, v7_layer_id=0x0100000A, name="Z analogue"
    )
    plane = replace(
        first, legacy_layer_id=39, v7_layer_id=0x01010001, name="Reference plane"
    )
    second = replace(
        second, legacy_layer_id=2, v7_layer_id=0x01000002, name="A digital"
    )
    stack = replace(
        base,
        copper_layers=(top, first, plane, second, bottom),
        dielectrics_between=(
            *base.dielectrics_between,
            replace(base.dielectrics_between[-1], name="Dielectric 4"),
        ),
    )
    pcb = AltiumPcbDoc()
    pcb.set_layer_stack_template(stack)
    for layer in (
        "TOP",
        "MID9",
        "PLANE1",
        "MID1",
        "BOTTOM",
        "TOPOVERLAY",
        "MECHANICAL2",
    ):
        pcb.add_track((100, 100), (800, 800), width_mils=20, layer=layer, net="N")
    pcb.save(path)


class LayerListTests(unittest.TestCase):
    def test_saved_stack_uses_physical_order_without_changing_rendered_pixels(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stack.PcbDoc"
            save_stack(path)
            original = path.read_bytes()
            data = render_file(path, native=True)
            self.assertEqual(
                data["copper_layer_order"], ["TOP", "MID9", "PLANE1", "MID1", "BOTTOM"]
            )
            document = GeometryDocument(data)
            info = document.info()
            expected = [
                "layer-TOP",
                "layer-MID9",
                "layer-PLANE1",
                "layer-MID1",
                "layer-BOTTOM",
            ]
            self.assertEqual(
                [row["id"] for row in info["layer_list"] if row["id"] in expected],
                expected,
            )
            self.assertNotEqual(info["layer_list"], info["layers"])
            self.assertEqual(
                [row for row in info["layer_list"] if row["id"] not in expected],
                [row for row in info["layers"] if row["id"] not in expected],
            )
            control = GeometryDocument({**data, "copper_layer_order": []})
            self.assertEqual(info["layers"], control.info()["layers"])
            self.assertEqual(document.source, control.source)
            request = {
                "token": 1,
                "rect": info["home"],
                "width": 300,
                "height": 300,
                "style": (
                    document.layer_ids,
                    True,
                    set(),
                    set(),
                    tuple(row["id"] for row in info["layers"]),
                ),
            }
            self.assertEqual(
                document.raster(request)["image"], control.raster(request)["image"]
            )
            self.assertEqual(path.read_bytes(), original)

    def test_missing_stack_keeps_file_order_and_does_not_prevent_loading(self):
        data = render_file(FIXTURE)
        for order in ([], ["unavailable-layer"]):
            with self.subTest(order=order):
                document = GeometryDocument({**data, "copper_layer_order": order})
                self.assertEqual(
                    document.info()["layer_list"], document.info()["layers"]
                )
        with patch(
            "ecadview.rendering.resolved_layer_stack_from_pcbdoc",
            side_effect=ValueError("missing stack"),
        ):
            self.assertEqual(copper_layer_order(AltiumPcbDoc()), [])

    def test_kicad_stack_order_is_separate_from_declaration_and_display_names(self):
        root = load(FIXTURE, "kicad_pcb")
        layers = form(root, "layers")
        copper = [row for row in layers[1:] if str(row[1]).endswith(".Cu")]
        other = [row for row in layers[1:] if row not in copper]
        layers[:] = [layers[0], *reversed(copper), *other]
        setup = form(root, "setup")
        setup.append(
            sexpdata.loads(
                '(stackup (layer "F.Cu" (type "copper")) (layer "In1.Cu" (type "copper")) (layer "In2.Cu" (type "copper")) (layer "B.Cu" (type "copper")))'
            )
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stack.kicad_pcb"
            path.write_text(sexpdata.dumps(root))
            data = render_file(path)
        self.assertEqual(data["copper_layer_order"], ["TOP", "MID1", "MID2", "BOTTOM"])
        document = GeometryDocument(data)
        source = document.info()["layers"]
        displayed = document.info()["layer_list"]
        copper_ids = {
            node.get("id"): node.get("data-layer-token")
            for node in document.scene
            if node.get("data-layer-role") == "copper"
        }
        self.assertEqual(
            [copper_ids[row["id"]] for row in displayed if row["id"] in copper_ids],
            ["TOP", "MID1", "MID2", "BOTTOM"],
        )
        self.assertEqual(
            [copper_ids[row["id"]] for row in source if row["id"] in copper_ids],
            ["BOTTOM", "MID2", "MID1", "TOP"],
        )



if __name__ == "__main__":
    unittest.main()
