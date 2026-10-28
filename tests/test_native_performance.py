"""Regressions for changing selection on large native PCB drawings."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

from PySide6.QtCore import QRectF
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop.document import NativeDocument

APP = QApplication.instance() or QApplication([])
BACKGROUND = "#1b1d21"
NET_COLOR = "#39e0f3"
COMPONENT_COLOR = "#ffe066"


def large_board():
    """Include enough unrelated routes that rebuilding all XML is significant."""
    routes = "".join(
        f'<path data-net="NET-{index % 30}" '
        f'd="M{60 + index % 100 * 0.3:g} {60 + index // 100:g}h.2" '
        'fill="none" stroke="#ff0000" stroke-width=".1"/>'
        for index in range(3000)
    )
    return NativeDocument(
        {
            "name": "large-selection-board",
            "kind": "pcb",
            "polygon_elements": ["polygon-a"],
            "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            '<g id="scene" transform="translate(2 3)">'
            '<g id="layer-top" data-layer-role="copper">'
            '<path id="route-a" data-net="A" data-component="CROSS" d="M10 25H40" '
            'fill="none" stroke="#ff0000" stroke-width="3"/>'
            '<path data-net="C" d="M10 40H40" '
            'fill="none" stroke="#ff0000" stroke-width="2"/>'
            '<rect data-component="C1" data-net="PAD" data-primitive="pad" '
            'x="45" y="20" width="10" height="10" fill="#ff0000"/>'
            f'{routes}</g><g id="layer-bottom" data-layer-role="copper">'
            '<path data-net="B" d="M25 10V32" '
            'fill="none" stroke="#0000ff" stroke-width="3"/>'
            '</g><g id="layer-polygons" data-layer-role="copper">'
            '<rect id="polygon-a" data-net="POLYGON" '
            'x="60" y="20" width="20" height="10" fill="#ff0000"/>'
            '</g><g id="layer-drills" data-layer-role="drill">'
            '<circle data-hole-owner="via" cx="35" cy="25" r="1" '
            'fill="#1b1d21"/>'
            '<circle data-hole-owner="pad" cx="50" cy="25" r="1" '
            'fill="#1b1d21"/>'
            "</g></g></svg>",
        }
    )


class NativeSelectionPerformanceTests(unittest.TestCase):
    def test_direct_simple_masks_match_qt_svg_including_transforms_and_strokes(self):
        data = {
            "name": "altium-mask-shapes",
            "kind": "pcb",
            "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
            '<g id="scene" transform="translate(2 3)"><g id="layer-top">'
            '<line id="pcb-track-0-L1-main" data-net="A" x1="2" y1="2" x2="12" y2="8" fill="none" stroke="red" stroke-width=".5" stroke-linecap="round"/>'
            '<circle id="pcb-via-0-L1-main" data-net="A" cx="20" cy="6" r="2" fill="none" stroke="blue" stroke-width=".7"/>'
            '<ellipse id="pcb-pad-0-L1-main" data-net="A" cx="5" cy="18" rx="2" ry="3" fill="red"/>'
            '<rect id="pcb-pad-1-L1-main" data-net="A" x="15" y="16" width="7" height="5" rx="1" fill="blue"/>'
            '<g style="opacity:.5"><line id="pcb-track-1-L1-main" data-net="A" x1="2" y1="27" x2="12" y2="28" stroke="red" stroke-width=".5"/></g>'
            '<line id="pcb-track-2-L1-main" data-net="A" x1="15" y1="28" x2="25" y2="28" stroke="red" stroke-width=".5" stroke-dasharray="1 1"/>'
            "</g></g></svg>",
        }
        fast, reference = NativeDocument(data), NativeDocument(data)
        request = {
            "token": 1,
            "rect": QRectF(0, 0, 40, 40),
            "width": 800,
            "height": 800,
            "style": ({"layer-top"}, True, set(), set()),
        }
        fast.raster(request)
        reference.raster(request)
        request["style"] = ({"layer-top"}, True, set(), {"A"})
        with patch.object(reference.pcb_raster, "mask_shape", return_value=None):
            expected = reference.raster(request)["image"]
        actual = fast.raster(request)["image"]
        self.assertEqual(actual, expected)
        self.assertIsNone(fast.pcb_raster.mask_shapes["pcb-track-1-L1-main"])
        self.assertIsNone(fast.pcb_raster.mask_shapes["pcb-track-2-L1-main"])

    def setUp(self):
        self.document = large_board()
        self.visible = self.document.layer_ids

    def raster(
        self,
        nets=(),
        components=(),
        visible=None,
        polygons=True,
        order=(),
        rect=None,
        width=1000,
        height=1000,
    ):
        return self.document.raster(
            {
                "style": (
                    self.visible if visible is None else visible,
                    polygons,
                    set(components),
                    set(nets),
                    order,
                ),
                "token": 1,
                "rect": QRectF(0, 0, 100, 100) if rect is None else rect,
                "width": width,
                "height": height,
            }
        )["image"]

    def pixel(self, image, x, y):
        return image.pixelColor(round(x * 10), round(y * 10)).name()

    def test_selection_toggles_never_serialize_or_reload_whole_board(self):
        baseline = self.raster()
        with (
            patch(
                "pcbvisualizer.desktop.document.ET.tostring", wraps=ET.tostring
            ) as serialize,
            patch.object(
                self.document.renderer, "load", wraps=self.document.renderer.load
            ) as reload_svg,
            patch.object(
                self.document.renderer, "render", wraps=self.document.renderer.render
            ) as render_svg,
        ):
            for net in ("A", "B", "NET-0", "NET-29", "A", "B"):
                selected = self.raster(nets={net})
                self.assertNotEqual(selected, baseline)
                self.assertEqual(self.raster(), baseline)
            selected = self.raster(components={"C1"})
            self.assertEqual(self.pixel(selected, 48, 27), COMPONENT_COLOR)
            self.assertEqual(self.raster(), baseline)
            serialize.assert_not_called()
            reload_svg.assert_not_called()
            # Cached background paint may be reused; only individual selected
            # elements and drill cutouts need Qt rendering on these toggles.
            self.assertTrue(
                all(
                    len(call.args) >= 2 and isinstance(call.args[1], str)
                    for call in render_svg.call_args_list
                )
            )

    def test_selection_stays_above_crossing_but_preserves_drills_and_viewport(self):
        baseline = self.raster()
        self.assertEqual(self.pixel(baseline, 27, 28), "#0000ff")
        selected = self.raster(nets={"A", "C", "PAD"})
        self.assertEqual(self.pixel(selected, 27, 28), NET_COLOR)
        self.assertEqual(self.pixel(selected, 37, 28), BACKGROUND)
        self.assertEqual(self.pixel(selected, 52, 28), BACKGROUND)
        self.assertEqual(self.pixel(selected, 27, 43), NET_COLOR)
        self.assertEqual(self.pixel(selected, 37, 43), NET_COLOR)
        faded_blue = selected.pixelColor(270, 180).getRgb()[:3]
        for actual, expected in zip(faded_blue, (23, 25, 66), strict=True):
            self.assertAlmostEqual(actual, expected, delta=1)
        self.assertEqual(self.raster(), baseline)
        cropped = self.raster(
            nets={"A"}, rect=QRectF(20, 20, 20, 20), width=400, height=400
        )
        for x in (0, 200, 399):
            self.assertEqual(cropped.pixelColor(x, 160).name(), NET_COLOR)
        outside = self.raster(
            nets={"A", "C"}, rect=QRectF(0, 0, 10, 10), width=100, height=100
        )
        self.assertTrue(
            all(
                outside.pixelColor(x, y).name() == BACKGROUND
                for x in range(100)
                for y in range(100)
            )
        )

    def test_hidden_layers_and_polygons_remain_hidden_during_selection(self):
        for visible, polygons, selected_nets, point in (
            (self.visible - {"layer-top"}, True, {"A"}, (20, 28)),
            (self.visible, False, {"POLYGON"}, (70, 28)),
            (self.visible - {"layer-polygons"}, True, {"POLYGON"}, (70, 28)),
        ):
            with self.subTest(visible=visible, polygons=polygons):
                baseline = self.raster(visible=visible, polygons=polygons)
                with patch(
                    "pcbvisualizer.desktop.document.ET.tostring", wraps=ET.tostring
                ) as serialize:
                    selected = self.raster(
                        nets=selected_nets, visible=visible, polygons=polygons
                    )
                    self.assertEqual(self.pixel(selected, *point), BACKGROUND)
                    self.assertEqual(
                        self.raster(visible=visible, polygons=polygons), baseline
                    )
                    serialize.assert_not_called()

    def test_layer_order_and_component_precedence_survive_repeated_switching(self):
        for order, color, overlap_color in (
            ((), "#0000ff", NET_COLOR),
            (("layer-bottom", "layer-top"), "#ff0000", COMPONENT_COLOR),
        ):
            with self.subTest(order=order):
                baseline = self.raster(order=order)
                self.assertEqual(self.pixel(baseline, 27, 28), color)
                for _ in range(3):
                    selected = self.raster(nets={"A"}, order=order)
                    self.assertEqual(self.pixel(selected, 27, 28), NET_COLOR)
                    overlap = self.raster(nets={"B"}, components={"CROSS"}, order=order)
                    self.assertEqual(self.pixel(overlap, 27, 28), overlap_color)
                    selected = self.raster(nets={"PAD"}, components={"C1"}, order=order)
                    self.assertEqual(self.pixel(selected, 48, 27), COMPONENT_COLOR)
                    self.assertEqual(self.pixel(selected, 52, 28), BACKGROUND)
                    self.assertEqual(self.raster(order=order), baseline)

    def test_changing_viewport_and_image_size_invalidates_cached_base(self):
        whole_board = self.raster()
        self.raster(nets={"A"})
        for rect, width, height in (
            (QRectF(10, 10, 50, 50), 1000, 1000),
            (QRectF(0, 0, 100, 100), 600, 400),
            (QRectF(20, 20, 25, 25), 400, 400),
        ):
            with self.subTest(rect=rect, width=width, height=height):
                baseline = self.raster(rect=rect, width=width, height=height)
                self.assertEqual(baseline.width(), width)
                self.assertEqual(baseline.height(), height)
                self.assertNotEqual(baseline, whole_board)
                with patch(
                    "pcbvisualizer.desktop.document.ET.tostring", wraps=ET.tostring
                ) as serialize:
                    self.raster(nets={"A"}, rect=rect, width=width, height=height)
                    self.assertEqual(
                        self.raster(rect=rect, width=width, height=height), baseline
                    )
                    serialize.assert_not_called()
        self.assertEqual(self.raster(), whole_board)


if __name__ == "__main__":
    unittest.main()
