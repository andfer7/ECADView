"""Interaction metadata survives compact native painting and text batching."""

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPointF, QRectF
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop.document import NativeDocument

APP = QApplication.instance() or QApplication([])


class NativeMetadataTests(unittest.TestCase):
    def test_nearest_metadata_and_all_selection_ancestors_survive_compact_paint(self):
        document = NativeDocument(
            {
                "name": "metadata",
                "polygon_elements": ["outer"],
                "selection": {
                    "components": [
                        {"id": "parent", "elements": ["outer"]},
                        {"id": "child", "elements": ["inner"]},
                    ],
                    "nets": [{"id": "logical", "elements": ["outer"]}],
                },
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">'
                '<g id="scene"><g id="layer-top" data-layer-role="copper">'
                '<g id="outer" data-component="U1" data-net="PARENT" data-pad-number="A1" '
                'fill="none" stroke="red" stroke-width=".2">'
                '<g id="inner" data-net="CHILD" transform="translate(2 3)">'
                '<line id="route" x1="0" y1="0" x2="4" y2="0" style="stroke:blue"/>'
                "</g></g></g></g></svg>",
            }
        )
        primitive = document.primitives[0]
        self.assertEqual(primitive.component, "U1")
        self.assertEqual(primitive.net, "CHILD")
        self.assertEqual(primitive.pin, "A1")
        self.assertEqual(primitive.schematic_components, ("child", "parent"))
        self.assertEqual(primitive.schematic_nets, ("logical",))
        self.assertTrue(primitive.polygon)
        self.assertEqual(primitive.layer, "layer-top")
        self.assertEqual(document.paints["route"], {"fill": "none", "stroke": "blue"})
        self.assertEqual(document.stroke_widths["route"], ".2")
        self.assertEqual(document.elements["inner"].get("data-net"), "CHILD")
        self.assertNotIn(b"data-", document.source)
        self.assertAlmostEqual(primitive.bounds.center().x(), 4)
        self.assertAlmostEqual(primitive.bounds.center().y(), 3)

    def test_text_group_is_one_exact_hit_target_with_click_through_empty_space(self):
        document = NativeDocument(
            {
                "name": "text",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">'
                '<g id="scene"><g id="layer-top" data-layer-role="copper">'
                '<g data-primitive="text" data-component="U1" transform="translate(2 3)">'
                '<path d="M0 0H4" fill="none" stroke="red" stroke-width=".2"/>'
                '<path d="M0 3H4" fill="none" stroke="red" stroke-width=".2"/>'
                "</g></g></g></svg>",
            }
        )
        self.assertEqual(len(document.primitives), 1)
        primitive = document.primitives[0]
        self.assertIn(primitive.id, document.text_groups)
        self.assertEqual(primitive.component, "U1")
        self.assertFalse(primitive.fill)
        self.assertTrue(primitive.stroke)
        expected = QRectF(1.9, 2.9, 4.2, 3.2)
        for actual, target in zip(
            primitive.bounds.getRect(), expected.getRect(), strict=True
        ):
            self.assertAlmostEqual(actual, target)
        self.assertEqual(
            document.pick(QPointF(4, 3), 0.05, {"layer-top"}, True),
            {"components": ["U1"], "nets": []},
        )
        self.assertIsNone(document.pick(QPointF(4, 4.5), 0.05, {"layer-top"}, True))


if __name__ == "__main__":
    unittest.main()
