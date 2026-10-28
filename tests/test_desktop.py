"""Native Qt rendering, navigation, selection and asynchronous-window regressions."""

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt
from PySide6.QtGui import (
    QColor,
    QCursor,
    QImage,
    QMouseEvent,
    QPainter,
    QPainterPath,
    QPainterPathStroker,
    QVector3D,
)
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
from shapely.geometry import Polygon

from pcbvisualizer.desktop.app import MainWindow
from pcbvisualizer.desktop.canvas import BoardCanvas
from pcbvisualizer.desktop.document import NativeDocument
from pcbvisualizer.desktop.probing import probe
from pcbvisualizer.desktop.solid import build_mesh, prism_hit
from pcbvisualizer.rendering import render_file

APP = QApplication.instance() or QApplication([])
ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "kicad"


def wait_for(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        APP.processEvents()
        if predicate():
            return
        QTest.qWait(10)
    raise AssertionError("Native application did not finish the requested operation")


def board_document():
    return NativeDocument(render_file(FIXTURES / "demo.kicad_pcb"))


def paint_at(document, x, y, nets=(), components=(), visible=None, layer_order=()):
    if visible is None:
        visible = {layer["id"] for layer in document.layers if layer["visible"]}
    return (
        document.raster(
            {
                "style": (visible, True, set(components), set(nets), layer_order),
                "token": 1,
                "rect": QRectF(x - 1, y - 1, 2, 2),
                "width": 200,
                "height": 200,
            }
        )["image"]
        .pixelColor(100, 100)
        .name()
    )


class NativeRenderingTests(unittest.TestCase):
    def test_measurement_centres_include_unconnected_copper_and_transform_exact_origins(
        self,
    ):
        document = NativeDocument(
            {
                "name": "centres",
                "kind": "pcb",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">'
                '<g id="scene" transform="translate(2 3)">'
                '<g id="layer-top" data-layer-role="copper">'
                '<rect data-primitive="pad" x="0" y="0" width="4" height="2" data-snap-x=".3" data-snap-y=".4"/>'
                '<circle data-primitive="via" cx="5" cy="1" r=".5"/>'
                '<path data-primitive="track" data-net="N" d="M0 7H9" stroke="red"/>'
                '<circle data-primitive="via-hole" data-hole-owner="via" cx="5" cy="1" r=".2"/>'
                '</g><g id="layer-mask" data-layer-role="mask"><circle data-primitive="pad" cx="9" cy="1" r="1"/></g>'
                "</g></svg>",
            }
        )
        centres = document.info()["snap_points"]
        self.assertEqual(
            [(point.x(), point.y()) for point, layers in centres], [(2.3, 3.4), (7, 4)]
        )
        self.assertTrue(all(layers == {"layer-top"} for point, layers in centres))
        board = board_document()
        self.assertEqual(
            {(p.x(), p.y()) for p, layers in board.info()["snap_points"]},
            {(10, 8), (10, 12), (20, 12), (28, 20), (32, 20)},
        )
        self.assertEqual(
            NativeDocument(render_file(FIXTURES / "demo.kicad_sch")).info()[
                "snap_points"
            ],
            [],
        )

    def test_layer_order_changes_crossing_paint_and_pick_but_preserves_drills(self):
        document = NativeDocument(
            {
                "name": "crossing",
                "kind": "pcb",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                '<g id="scene" transform="translate(1 1)">'
                '<g id="layer-top"><path data-net="TOP" d="M0 4H8" fill="none" stroke="red" stroke-width=".5"/></g>'
                '<g id="layer-bottom"><path data-net="BOTTOM" d="M4 0V8" fill="none" stroke="blue" stroke-width=".5"/></g>'
                '<g id="layer-drills"><circle data-hole-owner="via" cx="6" cy="4" r=".2" fill="#1b1d21"/></g>'
                "</g></svg>",
            }
        )
        visible = document.layer_ids
        for order, color, net in [
            ((), "#0000ff", "BOTTOM"),
            (("layer-bottom", "layer-drills", "layer-top"), "#ff0000", "TOP"),
            (("layer-drills", "layer-top", "layer-bottom"), "#0000ff", "BOTTOM"),
        ]:
            with self.subTest(order=order):
                self.assertEqual(paint_at(document, 5, 5, layer_order=order), color)
                self.assertEqual(
                    document.pick(QPointF(5, 5), 0.03, visible, True, order)["nets"],
                    [net],
                )
                self.assertEqual(paint_at(document, 7, 5, layer_order=order), "#1b1d21")
                self.assertIsNone(
                    document.pick(QPointF(7, 5), 0.03, visible, True, order)
                )
                self.assertEqual(
                    paint_at(
                        document, 5, 5, visible={"layer-bottom"}, layer_order=order
                    ),
                    "#0000ff",
                )
        self.assertEqual(paint_at(document, 5, 5), "#0000ff")

    def test_only_selected_schematic_net_strokes_thicken_and_restore(self):
        for kind in ("schematic", "pcb"):
            for group_width, path_style in [
                ('stroke-width=".2"', ""),
                ('style="stroke-width:.2px"', ""),
                ('stroke-width=".1"', 'style="stroke-width:.3px"'),
            ]:
                with self.subTest(kind=kind, group=group_width, path=path_style):
                    document = NativeDocument(
                        {
                            "name": "wire",
                            "kind": kind,
                            "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                            f'<g id="scene"><g id="layer-top" {group_width}>'
                            f'<path data-net="N1" data-component="C1" d="M1 5H9" stroke="red" fill="none" {path_style}/>'
                            "</g></g></svg>",
                        }
                    )

                    def stroke_pixels(nets=(), components=(), document=document):
                        image = document.raster(
                            {
                                "style": (
                                    {"layer-top"},
                                    True,
                                    set(components),
                                    set(nets),
                                ),
                                "token": 1,
                                "rect": QRectF(2, 4, 2, 2),
                                "width": 200,
                                "height": 400,
                            }
                        )["image"]
                        return sum(
                            image.pixelColor(100, y).name() != "#1b1d21"
                            for y in range(400)
                        )

                    normal = stroke_pixels()
                    highlighted = stroke_pixels({"N1"})
                    self.assertAlmostEqual(
                        highlighted,
                        normal * (3.5 if kind == "schematic" else 1),
                        delta=2,
                    )
                    self.assertEqual(stroke_pixels({"N1"}, {"C1"}), highlighted)
                    self.assertEqual(stroke_pixels(components={"C1"}), normal)
                    self.assertEqual(stroke_pixels({"N1"}), highlighted)
                    self.assertEqual(stroke_pixels(), normal)

    def test_schematic_component_contours_preserve_fills_but_layout_still_tints_them(
        self,
    ):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12">'
            '<g id="scene"><g id="layer-top" data-component="U1" stroke-width=".2">'
            '<rect x="2" y="2" width="4" height="4" fill="#ffffcc" stroke="green"/>'
            '<path d="M8 2H12V6H8Z" fill="#eeeeee" stroke="none"/>'
            '<text x="2" y="10" font-size="2" fill="green" stroke="none">U1</text>'
            "</g></g></svg>"
        )
        for kind in ("schematic", "pcb"):
            document = NativeDocument({"name": "component", "kind": kind, "svg": svg})
            for point, interior in [((4, 4), "#ffffcc"), ((10, 4), "#eeeeee")]:
                with self.subTest(kind=kind, point=point):
                    self.assertEqual(
                        paint_at(document, *point, components={"U1"}),
                        interior if kind == "schematic" else "#ffe066",
                    )
                    self.assertEqual(paint_at(document, *point), interior)
            if kind == "schematic":
                for point in [(4, 2), (10, 2)]:
                    self.assertEqual(
                        paint_at(document, *point, components={"U1"}), "#008a3b"
                    )
            # Native text is made of filled paths. It must remain bright and
            # legible rather than being treated as a filled symbol body.
            image = document.raster(
                {
                    "style": ({"layer-top"}, True, {"U1"}, set()),
                    "token": 1,
                    "rect": QRectF(1, 7, 6, 4),
                    "width": 300,
                    "height": 200,
                }
            )["image"]
            self.assertGreater(
                sum(
                    image.pixelColor(x, y).name()
                    == ("#008a3b" if kind == "schematic" else "#ffe066")
                    for y in range(200)
                    for x in range(300)
                ),
                100,
            )

    def test_selected_route_remains_visible_at_faded_layer_crossings(self):
        document = NativeDocument(
            {
                "name": "crossing",
                "kind": "pcb",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                '<g id="scene" transform="translate(1 1)">'
                '<g id="layer-top"><path data-net="SIGNAL" d="M0 4H8" fill="none" stroke="red" stroke-width=".5"/></g>'
                '<g id="layer-bottom"><path data-net="OTHER" d="M4 0V8" fill="none" stroke="blue" stroke-width=".5"/></g>'
                '<g id="layer-drills"><circle data-hole-owner="via" cx="6" cy="4" r=".2" fill="#1b1d21"/></g>'
                "</g></svg>",
            }
        )
        self.assertEqual(paint_at(document, 5, 5), "#0000ff")
        self.assertEqual(paint_at(document, 5, 5, {"SIGNAL"}), "#39e0f3")
        self.assertEqual(paint_at(document, 7, 5, {"SIGNAL"}), "#1b1d21")
        self.assertEqual(
            paint_at(document, 3, 5, {"SIGNAL"}, visible={"layer-bottom"}), "#1b1d21"
        )
        self.assertEqual(paint_at(document, 5, 5), "#0000ff")

    def assert_faded(self, original, faded, background, retained_contrast=0.15):
        def contrast(value):
            return max(
                abs(a - b)
                for a, b in zip(
                    QColor(value).getRgb()[:3],
                    QColor(background).getRgb()[:3],
                    strict=True,
                )
            )

        self.assertGreater(contrast(faded), 0, "unselected geometry stays visible")
        self.assertAlmostEqual(
            contrast(faded) / contrast(original), retained_contrast, delta=0.05
        )

    def test_layout_selection_fades_other_components_pours_and_board_graphics(self):
        document = board_document()
        # Include a component pad with no net, poured copper, and a nonselectable
        # board outline: fading must cover more than indexed net primitives.
        for point in [(32, 20), (5, 20), (0, 15)]:
            for nets, components in [
                ({"SIGNAL"}, set()),
                (set(), {"R1"}),
                ({"SIGNAL"}, {"R1"}),
            ]:
                with self.subTest(point=point, nets=nets, components=components):
                    original = paint_at(document, *point)
                    faded = paint_at(document, *point, nets, components)
                    self.assert_faded(original, faded, "#1b1d21")
                    self.assertEqual(paint_at(document, *point), original)
        self.assert_faded(
            paint_at(document, 15, 8),
            paint_at(document, 15, 8, components={"R1"}),
            "#1b1d21",
        )
        visible = {layer["id"] for layer in document.layers if layer["visible"]}
        # A faded item remains a valid next click, including after multiselection.
        self.assertEqual(
            document.pick(QPointF(15, 8), 0.03, visible, True)["nets"], ["SIGNAL"]
        )
        self.assertIsNone(document.pick(QPointF(10, 12), 0.03, visible, True))

    def test_schematic_selection_fades_context_and_preserves_paper_and_clicks(self):
        document = NativeDocument(render_file(FIXTURES / "demo.kicad_sch"))
        net = next(
            key for key, row in document.net_rows.items() if row["name"] == "SIGNAL"
        )
        component = next(
            key for key, row in document.component_rows.items() if row["name"] == "R1"
        )
        for nets, components in [
            ({net}, set()),
            (set(), {component}),
            ({net}, {component}),
        ]:
            for point in [(40, 50), (80, 50)]:
                with self.subTest(point=point, nets=nets, components=components):
                    original = paint_at(document, *point)
                    faded = paint_at(document, *point, nets, components)
                    self.assert_faded(original, faded, "#fffcf8", 0.45)
                    self.assertEqual(paint_at(document, *point), original)
            self.assertEqual(paint_at(document, 30, 30, nets, components), "#fffcf8")
            self.assertTrue(document.pick(QPointF(40, 50), 0.03, set(), True)["nets"])
        self.assertEqual(
            paint_at(document, 50, 50, components={component}),
            paint_at(document, 50, 50),
        )
        self.assertEqual(paint_at(document, 50, 49, components={component}), "#008a3b")
        other = next(
            key for key, row in document.net_rows.items() if row["name"] == "GND"
        )
        self.assertEqual(paint_at(document, 40, 50, {net, other}), "#008a3b")
        self.assertEqual(paint_at(document, 60, 50, {net, other}), "#008a3b")

    def test_selected_layout_net_colors_tracks_arcs_pads_and_vias(self):
        document = board_document()
        for x, y in [(15, 8), (22, 10), (10.8, 8), (20.5, 12), (28, 20)]:
            with self.subTest(point=(x, y)):
                original = paint_at(document, x, y)
                self.assertNotEqual(original, "#39e0f3")
                self.assertEqual(paint_at(document, x, y, {"SIGNAL"}), "#39e0f3")
                self.assertEqual(paint_at(document, x, y), original)
        self.assertEqual(paint_at(document, 20, 12, {"SIGNAL"}), "#1b1d21")
        self.assertEqual(
            paint_at(document, 15, 8, {"SIGNAL"}, visible=set()), "#1b1d21"
        )
        self.assertEqual(paint_at(document, 15, 8, {"SIGNAL"}, {"R1"}), "#39e0f3")
        self.assertEqual(paint_at(document, 10.8, 8, {"SIGNAL"}, {"R1"}), "#ffe066")

    def test_selected_schematic_net_colors_wires_and_connected_pins(self):
        document = NativeDocument(render_file(FIXTURES / "demo.kicad_sch"))
        net = next(
            key for key, row in document.net_rows.items() if row["name"] == "SIGNAL"
        )
        for x, y in [(60, 50), (70, 50), (53.5, 50), (76.5, 50)]:
            with self.subTest(point=(x, y)):
                original = paint_at(document, x, y)
                self.assertNotEqual(original, "#008a3b")
                self.assertEqual(paint_at(document, x, y, {net}), "#008a3b")
                self.assertEqual(paint_at(document, x, y), original)
        self.assert_faded(
            paint_at(document, 40, 50),
            paint_at(document, 40, 50, {net}),
            "#fffcf8",
            0.45,
        )

    def test_selected_legacy_net_colors_entire_wires_and_junctions(self):
        document = NativeDocument(render_file(FIXTURES / "legacy.sch"))
        net = next(
            key for key, row in document.net_rows.items() if "RETURN" in row["aliases"]
        )
        for x, y in [(38.1, 50.8), (50.8, 57.15), (50.8, 50.8), (133.35, 50.8)]:
            with self.subTest(point=(x, y)):
                original = paint_at(document, x, y)
                self.assertNotEqual(original, "#008a3b")
                self.assertEqual(paint_at(document, x, y, {net}), "#008a3b")
                self.assertEqual(paint_at(document, x, y), original)

    def test_selection_preserves_inherited_no_fill_and_inline_stroke_styles(self):
        document = NativeDocument(
            {
                "name": "styles",
                "kind": "schematic",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                '<g fill="none" stroke="red" stroke-width=".2" data-net="SIGNAL">'
                '<path d="M1 1H5V5"/>'
                '<path d="M1 7H5" style="stroke:blue;stroke-width:.3"/>'
                '<circle cx="8" cy="8" r=".5" style="fill:blue;stroke:none"/>'
                "</g></svg>",
            }
        )
        for x, y in [(3, 1), (3, 7), (8, 8)]:
            self.assertEqual(paint_at(document, x, y, {"SIGNAL"}), "#008a3b")
        # Selection must not fill the open elbow or expand a strokeless circle.
        for x, y in [(4, 2), (8.7, 8)]:
            self.assertEqual(paint_at(document, x, y, {"SIGNAL"}), "#1b1d21")

    def test_generated_altium_documents_use_the_same_native_renderer(self):
        from altium_monkey import (
            AltiumPcbDoc,
            AltiumSchDoc,
            SchPointMils,
            make_sch_net_label,
            make_sch_wire,
        )
        from altium_monkey.altium_board import AltiumBoardOutline

        with tempfile.TemporaryDirectory() as directory:
            pcb = AltiumPcbDoc()
            pcb.set_board_outline(
                AltiumBoardOutline.from_points_mils(
                    [(0, 0), (1000, 0), (1000, 1000), (0, 1000)]
                )
            )
            pcb.add_component(
                designator="U1", footprint="TEST", position_mils=(500, 500)
            )
            pad = pcb.add_pad(
                designator="A1",
                position_mils=(500, 500),
                width_mils=100,
                height_mils=100,
                net="SIG",
            )
            pad.component_index = 0
            path = Path(directory) / "native.PcbDoc"
            pcb.save(path)
            document = NativeDocument(render_file(path))
            self.assertIn("U1", document.info()["components"])
            self.assertEqual(document.info()["terminals"][("U1", "A1")], {"SIG"})
            self.assertTrue(
                document.info()["snap_points"], "Altium pad centres are available"
            )
            schematic = AltiumSchDoc()
            schematic.add_object(
                make_sch_wire(
                    points_mils=[SchPointMils(100, 100), SchPointMils(500, 100)]
                )
            )
            schematic.add_object(
                make_sch_net_label(location_mils=SchPointMils(100, 100), text="SIG")
            )
            path = Path(directory) / "native.SchDoc"
            schematic.save(path)
            document = NativeDocument(render_file(path))
            self.assertEqual(document.info()["kind"], "schematic")
            self.assertTrue(document.info()["nets"])

    def test_native_raster_and_spatial_selection_respect_holes_layers_and_pours(self):
        document = board_document()
        info = document.info()
        visible = {layer["id"] for layer in info["layers"] if layer["visible"]}
        frame = document.raster(
            {
                "style": (visible, True, set(), set()),
                "token": 4,
                "rect": info["home"],
                "width": 800,
                "height": 600,
            }
        )
        self.assertFalse(frame["image"].isNull())
        self.assertEqual(frame["token"], 4)
        self.assertEqual(
            document.pick(QPointF(10, 11.3), 0.05, visible, True)["components"], ["R1"]
        )
        self.assertIsNone(
            document.pick(QPointF(10, 12), 0.03, visible, True),
            "drill centres remain click-through",
        )
        self.assertEqual(
            document.pick(QPointF(5, 20), 0.05, visible, True)["nets"], ["GND"]
        )
        self.assertIsNone(document.pick(QPointF(5, 20), 0.05, visible, False))
        self.assertIsNone(document.pick(QPointF(10, 11.3), 0.05, set(), True))

    def test_selection_style_is_native_and_does_not_change_source_or_geometry(self):
        path = FIXTURES / "demo.kicad_pcb"
        source = path.read_bytes()
        document = NativeDocument(render_file(path))
        info = document.info()
        visible = {layer["id"] for layer in info["layers"] if layer["visible"]}
        request = {"token": 1, "rect": info["home"], "width": 400, "height": 300}
        a = document.raster(dict(request, style=(visible, True, set(), set())))["image"]
        b = document.raster(dict(request, style=(visible, True, {"R1"}, set())))[
            "image"
        ]
        self.assertNotEqual(a, b)
        self.assertEqual(path.read_bytes(), source)
        self.assertEqual(
            document.info()["component_bounds"]["R1"], info["component_bounds"]["R1"]
        )

    def test_schematic_bodies_wires_and_exact_cross_probing_in_both_directions(self):
        board = board_document().info()
        schematic = NativeDocument(render_file(FIXTURES / "demo.kicad_sch"))
        info = schematic.info()
        body = schematic.pick(QPointF(50, 50), 0.1, set(), True)
        symbol = next(
            key for key, row in info["components"].items() if row["name"] == "R1"
        )
        self.assertIn(symbol, body["components"])
        wire = schematic.pick(QPointF(40, 50), 0.1, set(), True)
        net = next(key for key, row in info["nets"].items() if row["name"] == "GND")
        self.assertIn(net, wire["nets"])
        self.assertEqual(probe(info, board, {symbol}, {net}), ({"R1"}, {"GND"}, []))
        self.assertEqual(probe(board, info, {"R1"}, {"GND"}), ({symbol}, {net}, []))

    def test_tiny_native_text_is_outlined_without_zero_pixel_fonts(self):
        data = {
            "name": "tiny",
            "kind": "pcb",
            "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><g id="scene"><g id="layer-top"><text data-component="R1" x=".5" y=".5" font-size=".1">R1</text></g></g></svg>',
        }
        document = NativeDocument(data)
        self.assertNotIn(b"<text", document.source)
        self.assertGreater(document.info()["component_bounds"]["R1"].width(), 0)


class NativeNavigationTests(unittest.TestCase):
    def setUp(self):
        self.canvas = BoardCanvas()
        self.canvas.resize(800, 600)
        self.canvas.set_document(board_document().info())
        self.canvas.timer.stop()

    def tearDown(self):
        self.canvas.timer.stop()
        self.canvas.close()

    def test_distance_label_bounds_clear_segments_markers_and_xy_legs_at_any_angle(
        self,
    ):
        canvas = self.canvas
        image = QImage(800, 600, QImage.Format.Format_ARGB32)
        labels, strokes = [], []

        class Painter(QPainter):
            def drawText(self, position, text):
                labels.append(
                    QRectF(self.fontMetrics().boundingRect(text)).translated(position)
                )
                return super().drawText(position, text)

            def drawLine(self, a, b):
                path = QPainterPath(a)
                path.lineTo(b)
                stroker = QPainterPathStroker()
                stroker.setWidth(self.pen().widthF() + 4)
                strokes.append(stroker.createStroke(path))
                return super().drawLine(a, b)

        for mode in ("completed", "selected", "preview"):
            for dx, dy in [
                (240, 180),
                (240, -180),
                (-240, 180),
                (-240, -180),
                (240, 0),
                (-240, 0),
                (0, 180),
                (0, -180),
                (1, 1),
                (0, 0),
            ]:
                with self.subTest(mode=mode, dx=dx, dy=dy):
                    p = QPointF(400, 300)
                    q = p + QPointF(dx, dy)
                    a, b = canvas.to_world(p), canvas.to_world(q)
                    canvas.unit = "mil" if dy < 0 else "mm"
                    canvas.measurements = [] if mode == "preview" else [(a, b)]
                    canvas.selected_measurement = 0 if mode == "selected" else None
                    canvas.measuring = mode == "preview"
                    canvas.points = [a] if canvas.measuring else []
                    canvas.measure_pointer = q
                    labels.clear()
                    strokes.clear()
                    painter = Painter(image)
                    canvas.paint_measurements(painter)
                    painter.end()
                    self.assertEqual(len(labels), 3 if mode == "selected" else 1)
                    label = QPainterPath()
                    label.addRect(labels[0])
                    self.assertFalse(
                        any(stroke.intersects(label) for stroke in strokes),
                        "the full distance text must clear every measurement stroke",
                    )

    def test_selected_measurement_adds_dashed_xy_components_in_current_units(self):
        canvas = self.canvas
        canvas.measurements = [(QPointF(13, 15), QPointF(10, 11))]
        image = QImage(800, 600, QImage.Format.Format_ARGB32)
        labels, lines = [], []

        class Painter(QPainter):
            def drawText(self, *args):
                labels.append(args[-1])
                return super().drawText(*args)

            def drawLine(self, a, b):
                lines.append((QPointF(a), QPointF(b), self.pen().style()))
                return super().drawLine(a, b)

        def paint():
            labels.clear()
            lines.clear()
            painter = Painter(image)
            canvas.paint_measurements(painter)
            painter.end()

        paint()
        self.assertEqual(labels, ["5.000 mm"])
        self.assertFalse(any(style == Qt.DashLine for a, b, style in lines))
        canvas.selected_measurement = 0
        for unit, expected in [
            ("mm", ["5.000 mm", "X: 3.000 mm", "Y: 4.000 mm"]),
            ("mil", ["196.9 mil", "X: 118.1 mil", "Y: 157.5 mil"]),
            ("in", ["0.1969 in", "X: 0.1181 in", "Y: 0.1575 in"]),
        ]:
            canvas.unit = unit
            paint()
            self.assertEqual(labels, expected)
            dashed = [(a, b) for a, b, style in lines if style == Qt.DashLine]
            self.assertEqual(len(dashed), 2)
            self.assertEqual(dashed[0][0].y(), dashed[0][1].y())
            self.assertEqual(dashed[1][0].x(), dashed[1][1].x())
            self.assertEqual(dashed[0][1], dashed[1][0])
        canvas.unit = "mm"
        for end, expected in [
            (QPointF(16, 15), ["3.000 mm", "X: 3.000 mm", "Y: 0.000 mm"]),
            (QPointF(13, 11), ["4.000 mm", "X: 0.000 mm", "Y: 4.000 mm"]),
            (QPointF(13, 15), ["0.000 mm", "X: 0.000 mm", "Y: 0.000 mm"]),
        ]:
            canvas.measurements = [(QPointF(13, 15), end)]
            paint()
            self.assertEqual(labels, expected)

    def test_measurement_hit_radius_is_in_pixels_and_clamps_to_segment_ends(self):
        canvas = self.canvas
        a, b = QPointF(5, 5), QPointF(15, 5)
        canvas.measurements = [(a, b)]
        for scale in (5, 50, 500):
            canvas.scale = scale
            midpoint = canvas.to_screen((a + b) / 2)
            self.assertEqual(canvas.measurement_at(midpoint + QPointF(0, 4)), 0)
            self.assertIsNone(canvas.measurement_at(midpoint + QPointF(0, 9)))
            self.assertIsNone(
                canvas.measurement_at(canvas.to_screen(b) + QPointF(9, 0))
            )
        canvas.measurements = [(a, a)]
        self.assertEqual(canvas.measurement_at(canvas.to_screen(a) + QPointF(2, 2)), 0)

    def test_measurement_snap_radius_stays_in_pixels_and_ignores_hidden_layers(self):
        canvas = self.canvas
        center = QPointF(10, 12)
        for scale in (5, 50, 500):
            canvas.scale = scale
            canvas.camera = center
            position = canvas.to_screen(center) + QPointF(7, 3)
            self.assertEqual(
                canvas.measurement_position(position, True), (center, True)
            )
            free, snapped = canvas.measurement_position(position, False)
            self.assertFalse(snapped)
            self.assertEqual(free, canvas.to_world(position))
            _far, snapped = canvas.measurement_position(
                canvas.to_screen(center) + QPointF(13, 0), True
            )
            self.assertFalse(snapped)
        canvas.visible.clear()
        self.assertFalse(canvas.measurement_position(position, True)[1])
        # Either visible copper side of a through pad can supply the same centre.
        layer = next(
            iter(
                next(layers for point, layers in canvas.snap_points if point == center)
            )
        )
        canvas.visible = {layer}
        self.assertEqual(canvas.measurement_position(position, True), (center, True))

    def test_pan_reuses_overscan_but_zoom_and_style_changes_request_new_detail(self):
        canvas = self.canvas
        requests = []
        canvas.render_requested.connect(requests.append)

        def complete():
            request = requests[-1]
            image = QImage(
                request["width"], request["height"], QImage.Format.Format_ARGB32
            )
            image.fill(QColor("red"))
            canvas.accept_frame({**request, "image": image, "renders": len(requests)})
            canvas.timer.stop()

        canvas.request_frame()
        complete()
        canvas.camera += QPointF(0.01, 0)
        canvas.schedule(navigation=True)
        canvas.request_frame()
        self.assertEqual(len(requests), 1)
        canvas.zoom_at(QPointF(400, 300), 2)
        canvas.request_frame()
        self.assertEqual(len(requests), 2)
        complete()
        self.assertIsNotNone(canvas.overview)
        canvas.camera += QPointF(canvas.frame["rect"].width(), 0)
        canvas.schedule(navigation=True)
        canvas.request_frame()
        self.assertEqual(len(requests), 3)
        complete()
        canvas.visible.clear()
        canvas.schedule()
        canvas.request_frame()
        self.assertEqual(len(requests), 4)
        complete()
        self.assertIsNone(
            canvas.overview, "old layers must not leak through the fallback"
        )

    def test_zoom_refines_once_after_the_gesture_pauses(self):
        canvas = self.canvas
        requests = []
        canvas.render_requested.connect(requests.append)
        canvas.request_frame()
        request = requests.pop()
        image = QImage(request["width"], request["height"], QImage.Format.Format_ARGB32)
        image.fill(QColor("red"))
        canvas.accept_frame({**request, "image": image, "renders": 1})
        for _ in range(6):
            canvas.zoom_at(QPointF(400, 300), 1.02)
            QTest.qWait(25)
        self.assertEqual(
            requests, [], "covered navigation should only transform the cache"
        )
        wait_for(lambda: bool(requests))
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["token"], canvas.serial)

    def test_overview_fills_area_outside_the_detail_frame_during_navigation(self):
        canvas = self.canvas
        canvas.info["captions"] = []
        canvas.info["home"] = QRectF(-10, -10, 20, 20)
        canvas.camera, canvas.scale = QPointF(), 20
        overview = QImage(800, 800, QImage.Format.Format_ARGB32)
        overview.fill(QColor("red"))
        canvas.accept_frame(
            {"image": overview, "rect": QRectF(-20, -20, 40, 40), "renders": 1}
        )
        detail = QImage(200, 200, QImage.Format.Format_ARGB32)
        detail.fill(QColor("blue"))
        canvas.accept_frame(
            {"image": detail, "rect": QRectF(-5, -5, 10, 10), "renders": 2}
        )
        image = QImage(800, 600, QImage.Format.Format_ARGB32)
        painter = QPainter(image)
        canvas.render(painter, QPoint())
        painter.end()
        self.assertEqual(image.pixelColor(400, 300).name(), "#0000ff")
        self.assertEqual(image.pixelColor(100, 300).name(), "#ff0000")

    def test_offscreen_and_tiny_captions_do_not_measure_text(self):
        canvas = self.canvas
        canvas.camera, canvas.scale = QPointF(), 40
        canvas.info["home"] = QRectF(-50, -50, 100, 100)
        canvas.visible = {"layer-top"}
        canvas.info["captions"] = [
            (bounds, pin, "NET", "layer-top", False, "R1")
            for bounds, pin in [
                (QRectF(100, 100, 2, 2), "OFFSCREEN"),
                (QRectF(0, 0, 0.01, 0.01), "TINY"),
                (QRectF(-1, -1, 2, 2), "VISIBLE"),
            ]
        ]
        image = QImage(800, 600, QImage.Format.Format_ARGB32)
        image.fill(QColor("gray"))
        canvas.frame = {"image": image, "rect": canvas.viewport()}
        target = image.copy()
        painter = QPainter(target)
        canvas.paint_captions(painter)
        self.assertEqual(set(canvas.caption_sizes), {"VISIBLE\nNET"})
        painter.end()

    def test_pad_captions_follow_the_union_of_selected_components_and_nets(self):
        canvas = self.canvas
        canvas.camera, canvas.scale = QPointF(), 40
        canvas.info["home"] = QRectF(-50, -50, 100, 100)
        canvas.visible = {"layer-top"}
        canvas.info["captions"] = [
            (QRectF(x - 1, -1, 2, 2), pin, net, "layer-top", False, component)
            for x, pin, net, component in [
                (-5, "1", "N1", "R1"),
                (0, "2", "N2", "R2"),
                (5, "3", "N3", "R3"),
            ]
        ]
        image = QImage(800, 600, QImage.Format.Format_ARGB32_Premultiplied)
        image.fill(QColor("gray"))
        canvas.frame = {"image": image, "rect": QRectF(-10, -7.5, 20, 15)}
        labels = []

        class CaptionPainter(QPainter):
            def drawText(self, *args):
                labels.append(args[-1])
                return super().drawText(*args)

        for components, nets, expected in [
            ({"R1"}, set(), {"1\nN1"}),
            (set(), {"N2"}, {"2\nN2"}),
            ({"R1"}, {"N2"}, {"1\nN1", "2\nN2"}),
            (set(), set(), {"1\nN1", "2\nN2", "3\nN3"}),
        ]:
            canvas.components, canvas.nets = components, nets
            labels.clear()
            target = image.copy()
            painter = CaptionPainter(target)
            canvas.paint_captions(painter)
            painter.end()
            self.assertEqual(set(labels), expected)

    def test_zoom_stays_cursor_anchored_and_measurements_remain_in_mm(self):
        point = QPointF(200, 100)
        before = self.canvas.to_world(point)
        self.canvas.zoom_at(point, 2)
        after = self.canvas.to_world(point)
        self.assertAlmostEqual(before.x(), after.x())
        self.assertAlmostEqual(before.y(), after.y())
        self.assertEqual(self.canvas.distance(QPointF(0, 0), QPointF(3, 4)), "5.000 mm")
        self.canvas.unit = "mil"
        self.assertEqual(
            self.canvas.distance(QPointF(), QPointF(25.4, 0)), "1000.0 mil"
        )

    def test_layout_component_and_net_clicks_toggle_independently(self):
        self.canvas.accept_pick(
            {"shift": False, "result": {"components": ["R1"], "nets": ["GND"]}}
        )
        self.canvas.accept_pick(
            {"shift": False, "result": {"components": ["R1"], "nets": ["SIGNAL"]}}
        )
        self.assertFalse(self.canvas.components)
        self.assertEqual(self.canvas.nets, {"SIGNAL"})
        self.canvas.accept_pick({"shift": False, "result": None})
        self.assertEqual(
            self.canvas.nets, {"SIGNAL"}, "blank PCB clicks retain selection"
        )

    def test_navigation_coalesces_rasters_and_cache_has_a_fixed_pixel_bound(self):
        requests = []
        self.canvas.render_requested.connect(requests.append)
        for i in range(200):
            self.canvas.camera += QPointF(0.01, 0)
            self.canvas.schedule()
        self.canvas.timer.stop()
        self.canvas.request_frame()
        self.assertEqual(len(requests), 1)
        self.assertLessEqual(max(requests[0]["width"], requests[0]["height"]), 4096)
        for i in range(200):
            self.canvas.zoom_at(QPointF(400, 300), 1.001)
        self.canvas.timer.stop()
        self.canvas.request_frame()
        self.assertEqual(
            len(requests),
            1,
            "a slow worker cannot accumulate hundreds of queued frames",
        )
        self.canvas.accept_frame(
            {
                "token": 1,
                "rect": requests[0]["rect"],
                "image": QImage(1, 1, QImage.Format.Format_ARGB32),
                "renders": 1,
            }
        )
        self.canvas.timer.stop()
        self.canvas.request_frame()
        self.assertEqual(len(requests), 2)


class NativeWindowTests(unittest.TestCase):
    def setUp(self):
        self.window = MainWindow()
        self.window.show()

    def tearDown(self):
        self.window.close()
        APP.processEvents()

    def test_q_toggles_unit_systems_and_refreshes_all_measurement_labels(self):
        self.assertFalse(self.window.units_action.isEnabled())
        self.assertFalse(self.window.unit.isEnabled())
        self.window.open_files(
            [
                FIXTURES / "demo.kicad_pcb",
                FIXTURES / "demo.kicad_pcb",
                FIXTURES / "demo.kicad_sch",
            ]
        )
        wait_for(lambda: all(self.window.tabs.widget(i).info for i in range(3)))
        first, second, _schematic = [self.window.tabs.widget(i) for i in range(3)]
        self.assertFalse(
            self.window.units_action.isEnabled(), "schematics have no measuring tool"
        )
        self.window.tabs.setCurrentWidget(first)
        canvas = first.canvas
        canvas.measurements = [(QPointF(5, 5), QPointF(30.4, 5))]
        canvas.selected_measurement = 0
        self.window.toggle_measure(True)
        canvas.points = [QPointF(5, 8)]
        canvas.measure_pointer = canvas.to_screen(QPointF(30.4, 8))
        geometry = (
            list(canvas.measurements),
            list(canvas.points),
            QPointF(canvas.camera),
            canvas.scale,
        )
        image = QImage(canvas.size(), QImage.Format.Format_ARGB32)
        labels = []

        class Painter(QPainter):
            def drawText(self, *args):
                labels.append(args[-1])
                return super().drawText(*args)

        def paint_labels():
            labels.clear()
            painter = Painter(image)
            canvas.paint_measurements(painter)
            painter.end()
            return list(labels)

        def toggle():
            canvas.setFocus()
            QTest.keyClick(canvas, Qt.Key_Q)

        serial = canvas.serial
        toggle()
        self.assertEqual(canvas.unit, "mil")
        self.assertEqual(self.window.unit.currentText(), "mil")
        self.assertEqual(self.window.units_action.text(), "Imperial (mil)")
        self.assertEqual(self.window.statusBar().currentMessage(), "1000.0 mil")
        self.assertEqual(
            paint_labels(), ["1000.0 mil", "X: 1000.0 mil", "Y: 0.0 mil", "1000.0 mil"]
        )
        toggle()
        self.assertEqual(canvas.unit, "mm")
        self.assertEqual(self.window.units_action.text(), "Metric (mm)")
        self.assertEqual(
            paint_labels(), ["25.400 mm", "X: 25.400 mm", "Y: 0.000 mm", "25.400 mm"]
        )
        self.window.unit.setCurrentText("in")
        self.assertEqual(
            paint_labels(), ["1.0000 in", "X: 1.0000 in", "Y: 0.0000 in", "1.0000 in"]
        )
        toggle()
        self.assertEqual(canvas.unit, "mm")
        toggle()
        self.assertEqual(canvas.unit, "in", "remember the chosen imperial unit")
        self.assertEqual(
            canvas.serial, serial, "changing units needs no vector refinement"
        )
        self.assertEqual(
            (canvas.measurements, canvas.points, canvas.camera, canvas.scale), geometry
        )
        self.window.tabs.setCurrentWidget(second)
        self.assertEqual(self.window.unit.currentText(), "mm")
        second.canvas.setFocus()
        QTest.keyClick(second.canvas, Qt.Key_Q)
        self.assertEqual(second.canvas.unit, "mil")
        self.window.tabs.setCurrentWidget(first)
        self.assertEqual(self.window.unit.currentText(), "in")
        self.assertEqual(self.window.units_action.text(), "Imperial (in)")
        self.assertEqual(self.window.statusBar().currentMessage(), "1.0000 in")
        field = self.window.component.lineEdit()
        field.setFocus()
        field.selectAll()
        QTest.keyClicks(field, "Q1")
        self.assertEqual(field.text(), "Q1")
        self.assertEqual(canvas.unit, "in", "Q remains usable in text searches")
        with patch.object(first, "is_3d", return_value=True):
            self.window.mount()
            self.assertFalse(self.window.units_action.isEnabled())
        self.window.mount()
        self.assertTrue(self.window.units_action.isEnabled())

    def test_selected_layer_order_is_per_board_and_survives_sidebar_refresh(self):
        self.window.open_files(
            [FIXTURES / "demo.kicad_pcb"] * 2 + [FIXTURES / "demo.kicad_sch"]
        )
        wait_for(lambda: all(self.window.tabs.widget(i).info for i in range(3)))
        first, second, schematic = [self.window.tabs.widget(i) for i in range(3)]
        original = list(second.canvas.layer_order)
        self.window.tabs.setCurrentWidget(first)
        item = self.window.layers.item(0)
        identifier = item.data(Qt.ItemDataRole.UserRole)
        self.window.layers.setCurrentItem(item)
        self.assertEqual(first.canvas.layer_order[-1], identifier)
        self.assertEqual(second.canvas.layer_order, original)
        item.setCheckState(Qt.CheckState.Unchecked)
        self.assertNotIn(identifier, first.canvas.visible)
        self.window.layers.setCurrentRow(1)
        item.setCheckState(Qt.CheckState.Checked)
        self.assertEqual(first.canvas.layer_order[-1], identifier)
        self.assertIn(identifier, first.canvas.visible)
        expected = list(first.canvas.layer_order)
        self.window.tabs.setCurrentWidget(schematic)
        self.assertEqual(schematic.canvas.layer_order, [])
        self.window.tabs.setCurrentWidget(second)
        self.assertEqual(second.canvas.layer_order, original)
        self.window.tabs.setCurrentWidget(first)
        self.assertEqual(first.canvas.layer_order, expected)
        self.assertEqual(
            self.window.layers.currentItem().data(Qt.ItemDataRole.UserRole), identifier
        )
        self.window.all_layers(False)
        self.window.all_layers(True)
        self.assertEqual(first.canvas.layer_order, expected)

    def test_async_tabs_search_layers_measurements_and_cross_probe(self):
        self.window.open_files(
            [FIXTURES / "demo.kicad_pcb", FIXTURES / "demo.kicad_sch"]
        )
        wait_for(lambda: all(self.window.tabs.widget(i).info for i in range(2)))
        board, schematic = self.window.tabs.widget(0), self.window.tabs.widget(1)
        self.window.tabs.setCurrentWidget(board)
        self.window.component.setEditText("R1")
        self.window.net.setEditText("GND")
        self.window.search()
        self.assertEqual(board.canvas.components, {"R1"})
        self.assertEqual(board.canvas.nets, {"GND"})
        board.canvas.measurements.append((QPointF(), QPointF(10, 0)))
        self.window.all_layers(False)
        self.assertFalse(board.canvas.visible)
        self.window.reveal_selection()
        self.assertTrue(board.canvas.visible)
        self.window.cross_probe()
        self.assertIs(self.window.current(), schematic)
        self.assertEqual(len(schematic.canvas.components), 1)
        self.assertEqual(len(schematic.canvas.nets), 1)
        self.window.tabs.setCurrentWidget(board)
        self.assertEqual(len(board.canvas.measurements), 1)
        self.assertEqual(board.canvas.components, {"R1"})

    def test_failed_and_closed_uploads_do_not_destroy_open_tabs(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().info)
        board = self.window.current()
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / "bad.kicad_pcb"
            bad.write_text("(kicad_pcb")
            self.window.open_files([bad])
            wait_for(lambda: self.window.current().error_message)
            self.assertIn("Invalid KiCad", self.window.warning.text())
            self.window.close_tab(1)
        self.assertIs(self.window.current(), board)
        self.assertTrue(board.info)

    def test_native_mouse_measurement_and_click_selection(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().canvas.frame)
        canvas = self.window.current().canvas
        self.window.toggle_measure(True)
        start = canvas.to_screen(QPointF(5, 5)).toPoint()
        end = canvas.to_screen(QPointF(15, 5)).toPoint()
        QTest.mouseClick(canvas, Qt.MouseButton.LeftButton, pos=start)
        self.assertEqual(len(canvas.points), 1)
        QTest.mouseMove(canvas, end)
        self.assertEqual(canvas.measure_pointer, QPointF(end))
        self.assertFalse(canvas.measurements)

        def overlay():
            image = QImage(canvas.size(), QImage.Format.Format_ARGB32)
            image.fill(QColor("#1b1d21"))
            labels = []

            class Painter(QPainter):
                def drawText(self, *args):
                    labels.append(args[-1])
                    return super().drawText(*args)

            painter = Painter(image)
            canvas.paint_measurements(painter)
            painter.end()
            return image, labels

        image, labels = overlay()
        self.assertNotEqual(image.pixelColor(start).name(), "#1b1d21")
        self.assertEqual(
            labels, [canvas.distance(canvas.points[0], canvas.to_world(QPointF(end)))]
        )
        self.assertGreater(
            sum(
                image.pixelColor(x, start.y()).name() != "#1b1d21"
                for x in range(start.x() + 10, end.x() - 10)
            ),
            10,
        )
        canvas.unit = "mil"
        self.assertTrue(overlay()[1][0].endswith("mil"))
        canvas.unit = "mm"
        QTest.mouseClick(canvas, Qt.MouseButton.LeftButton, pos=end)
        self.assertEqual(len(canvas.measurements), 1)
        self.assertFalse(canvas.points)
        self.assertEqual(canvas.measure_pointer, QPointF(end))
        completed, _ = overlay()
        for point in (start, end):
            self.assertNotEqual(
                completed.pixelColor(point + QPoint(0, 6)).name(),
                "#1b1d21",
                "both endpoints retain a marker",
            )
        QTest.mouseMove(canvas, end + QPoint(40, 20))
        self.assertEqual(len(canvas.measurements), 1)
        moved, _ = overlay()
        for point in (start, end, end + QPoint(40, 20)):
            self.assertNotEqual(
                moved.pixelColor(point + QPoint(0, 6)).name(), "#1b1d21"
            )
        a, b = canvas.measurements[0]
        self.assertAlmostEqual(b.x() - a.x(), 10, delta=0.1)
        self.window.toggle_measure(False)
        QTest.mouseClick(
            canvas,
            Qt.MouseButton.LeftButton,
            pos=canvas.to_screen(QPointF(10, 11.3)).toPoint(),
        )
        wait_for(lambda: bool(canvas.components))
        self.assertEqual(canvas.components, {"R1"})

    def test_measurement_preview_cancels_when_disabled_cleared_or_escaped(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().canvas.frame)
        canvas = self.window.current().canvas
        for cancel in (
            lambda: self.window.toggle_measure(False),
            self.window.clear_measurements,
            lambda: QTest.keyClick(canvas, Qt.Key.Key_Escape),
        ):
            self.window.toggle_measure(True)
            QTest.mouseClick(canvas, Qt.MouseButton.LeftButton, pos=QPoint(150, 150))
            QTest.mouseMove(canvas, QPoint(250, 200))
            self.assertTrue(canvas.points)
            cancel()
            self.assertFalse(canvas.points)
            self.assertEqual(canvas.measure_pointer is not None, canvas.measuring)
            self.assertFalse(canvas.measurements)

    def test_command_snaps_first_click_live_preview_and_final_via_endpoint(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().canvas.frame)
        canvas = self.window.current().canvas
        self.window.toggle_measure(True)
        start, end = QPointF(10, 12), QPointF(20, 12)
        near_start = canvas.to_screen(start).toPoint() + QPoint(6, 2)
        near_end = canvas.to_screen(end).toPoint() + QPoint(7, 1)
        QTest.mouseMove(canvas, near_start)
        QTest.keyPress(canvas, Qt.Key.Key_Control)
        self.assertTrue(
            canvas.measure_snapping, "Command works without moving the pointer"
        )
        QTest.mouseClick(
            canvas, Qt.MouseButton.LeftButton, Qt.ControlModifier, near_start
        )
        self.assertEqual(canvas.points, [start])
        # Send the same modifier state a physical drag-free hover carries.
        event = QMouseEvent(
            QMouseEvent.Type.MouseMove,
            QPointF(near_end),
            QPointF(near_end),
            Qt.NoButton,
            Qt.NoButton,
            Qt.ControlModifier,
        )
        APP.sendEvent(canvas, event)
        self.assertEqual(
            canvas.measurement_position(
                canvas.measure_pointer, canvas.measure_snapping
            ),
            (end, True),
        )
        QTest.keyRelease(canvas, Qt.Key.Key_Control)
        self.assertFalse(canvas.measure_snapping)
        self.assertEqual(
            canvas.measurement_position(canvas.measure_pointer, False),
            (canvas.to_world(QPointF(near_end)), False),
        )
        QTest.keyPress(canvas, Qt.Key.Key_Control)
        self.assertEqual(
            canvas.measurement_position(
                canvas.measure_pointer, canvas.measure_snapping
            ),
            (end, True),
        )
        QTest.mouseClick(
            canvas, Qt.MouseButton.LeftButton, Qt.ControlModifier, near_end
        )
        self.assertEqual(canvas.measurements, [(start, end)])
        self.assertEqual(canvas.distance(*canvas.measurements[0]), "10.000 mm")
        self.assertEqual(canvas.measure_pointer, QPointF(near_end))
        QTest.keyRelease(canvas, Qt.Key.Key_Control)
        free_position = near_start + QPoint(0, 20)
        QTest.mouseClick(canvas, Qt.MouseButton.LeftButton, pos=free_position)
        self.assertEqual(canvas.points, [canvas.to_world(QPointF(free_position))])

    def test_clicking_completed_measurements_selects_xy_without_starting_a_new_one(
        self,
    ):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().canvas.frame)
        canvas = self.window.current().canvas
        first = (QPointF(5, 5), QPointF(15, 10))
        second = (QPointF(5, 17), QPointF(15, 23))
        canvas.measurements = [first, second]
        picks = []
        canvas.pick_requested.connect(picks.append)
        click = lambda point: QTest.mouseClick(
            canvas, Qt.LeftButton, pos=canvas.to_screen(point).toPoint()
        )
        click((first[0] + first[1]) / 2)
        self.assertEqual(canvas.selected_measurement, 0)
        self.assertFalse(picks)
        self.window.toggle_measure(True)
        click((second[0] + second[1]) / 2)
        self.assertEqual(canvas.selected_measurement, 1)
        self.assertFalse(canvas.points)
        self.assertEqual(len(canvas.measurements), 2)
        click((second[0] + second[1]) / 2)
        self.assertIsNone(canvas.selected_measurement)
        click(QPointF(30, 5))
        self.assertEqual(len(canvas.points), 1)
        click((first[0] + first[1]) / 2)
        self.assertEqual(
            len(canvas.measurements),
            3,
            "a pending second point still completes its measurement",
        )
        self.assertIsNone(canvas.selected_measurement)
        click((first[0] + first[1]) / 2)
        self.assertIsNotNone(canvas.selected_measurement)
        QTest.keyClick(canvas, Qt.Key_Escape)
        self.assertIsNone(canvas.selected_measurement)
        self.assertEqual(len(canvas.measurements), 3)
        click((second[0] + second[1]) / 2)
        self.window.clear_measurements()
        self.assertIsNone(canvas.selected_measurement)
        self.assertFalse(canvas.measurements)

    def test_physical_control_does_not_snap_or_place_right_click_measurements(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().canvas.frame)
        canvas = self.window.current().canvas
        start = QPointF(10, 12)
        near_start = canvas.to_screen(start).toPoint() + QPoint(6, 2)
        self.window.toggle_measure(True)
        QTest.mouseClick(canvas, Qt.RightButton, pos=near_start)
        self.assertFalse(canvas.points, "ordinary right-click is not a measurement")
        # Qt maps the physical macOS Control key to Meta, and Command to Control.
        QTest.mouseMove(canvas, near_start)
        QTest.keyPress(canvas, Qt.Key_Meta)
        self.assertFalse(canvas.measure_snapping)
        QTest.mouseClick(canvas, Qt.RightButton, Qt.MetaModifier, near_start)
        self.assertFalse(canvas.measurements)
        self.assertFalse(canvas.points)
        QTest.keyRelease(canvas, Qt.Key_Meta)
        QTest.mouseClick(canvas, Qt.LeftButton, Qt.MetaModifier, near_start)
        self.assertEqual(canvas.points, [canvas.to_world(QPointF(near_start))])

    def test_measurement_marker_is_visible_immediately_on_every_mode_entry(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        wait_for(lambda: self.window.current().canvas.frame)
        canvas = self.window.current().canvas
        for position in (QPoint(350, 250), QPoint(650, 400)):
            with patch.object(
                QCursor, "pos", return_value=canvas.mapToGlobal(position)
            ):
                self.window.measure_action.trigger()
            self.assertTrue(canvas.measuring)
            self.assertEqual(canvas.measure_pointer, QPointF(position))
            self.assertEqual(canvas.cursor().shape(), Qt.CrossCursor)
            self.assertFalse(canvas.points)
            image = QImage(canvas.size(), QImage.Format.Format_ARGB32)
            image.fill(QColor("#1b1d21"))
            painter = QPainter(image)
            canvas.paint_measurements(painter)
            painter.end()
            self.assertNotEqual(
                image.pixelColor(position).name(),
                "#1b1d21",
                "marker appears without moving or clicking",
            )
            self.window.measure_action.trigger()
            self.assertFalse(canvas.measuring)
            self.assertIsNone(canvas.measure_pointer)
            self.assertNotEqual(canvas.cursor().shape(), Qt.CrossCursor)

    def test_close_while_loading_joins_workers_without_destroying_running_threads(self):
        self.window.open_files([FIXTURES / "demo.kicad_pcb"])
        document = self.window.current()
        self.window.close_tab(0)
        self.assertFalse(document.thread.isRunning())


class NativeSolidTests(unittest.TestCase):
    def test_prism_picking_respects_holes_sides_and_board_occlusion(self):
        from pcbvisualizer.desktop.solid import SolidView

        scene = {
            "board": [
                {"outline": [[-10, -10], [10, -10], [10, 10], [-10, 10]], "holes": []}
            ],
            "thickness": 1.6,
            "bodies": [
                {
                    "outline": [[-3, -3], [3, -3], [3, 3], [-3, 3]],
                    "holes": [],
                    "z": -4,
                    "height": 3,
                    "id": "back",
                    "name": "back",
                }
            ],
        }
        view = SolidView()
        view.resize(800, 600)
        view.mesh = build_mesh(scene)
        view.fit("top")
        self.assertIsNone(
            view.pick(QPointF(400, 300)), "board hides a body on its back side"
        )
        view.fit("bottom")
        self.assertEqual(view.pick(QPointF(400, 300)), "back")
        obj = {
            "polygon": Polygon(
                [(-2, -2), (2, -2), (2, 2), (-2, 2)],
                [[(-1, -1), (1, -1), (1, 1), (-1, 1)]],
            ),
            "z": 0,
            "top": 2,
        }
        self.assertIsNone(prism_hit(QVector3D(0, 0, 5), QVector3D(0, 0, -1), obj))
        self.assertAlmostEqual(
            prism_hit(QVector3D(5, 0, 1), QVector3D(-1, 0, 0), obj), 3
        )
        view.close()

    def test_native_triangles_preserve_holes_and_body_identity(self):
        scene = render_file(FIXTURES / "demo.kicad_pcb")["scene3d"]
        scene["bodies"] = [
            {
                "outline": [[-2, -2], [2, -2], [2, 2], [-2, 2]],
                "holes": [],
                "z": 0.8,
                "height": 3,
                "id": "U1",
                "name": "U1",
            }
        ]
        mesh = build_mesh(scene)
        self.assertEqual(mesh["objects"][1]["id"], "U1")
        board = mesh["objects"][0]
        area = 0
        from array import array

        coordinates = array("f")
        coordinates.frombytes(mesh["vertices"])
        for start in range(
            board["first"] * 6, (board["first"] + board["count"]) * 6, 18
        ):
            triangle = [coordinates[start + i : start + i + 3] for i in (0, 6, 12)]
            if all(abs(p[2] - 0.8) < 1e-6 for p in triangle):
                area += Polygon([(p[0], p[1]) for p in triangle]).area
        self.assertAlmostEqual(area, board["polygon"].area, places=5)

    def test_body_edits_are_per_view_and_undo_restores_grouped_deletions(self):
        # No GL context is needed for the body edit model.
        from pcbvisualizer.desktop.solid import SolidView

        a, b = SolidView(), SolidView()
        a.selected = {"A", "B"}
        a.delete_selected()
        self.assertEqual(a.deleted, {"A", "B"})
        self.assertFalse(b.deleted)
        a.undo_delete()
        self.assertFalse(a.deleted)
        self.assertEqual(a.selected, {"A", "B"})
        a.close()
        b.close()


class NativeLaunchTests(unittest.TestCase):
    def test_default_launcher_uses_native_app_and_starts_no_server_or_browser(self):
        from pcbvisualizer import cli

        with (
            patch("sys.argv", ["pcbvisualizer", str(FIXTURES / "demo.kicad_pcb")]),
            patch("pcbvisualizer.desktop.app.run", return_value=0) as run,
            patch.object(cli, "ThreadingHTTPServer") as server,
            patch.object(cli, "open_in_browser") as browser,
        ):
            with self.assertRaises(SystemExit) as exit_status:
                cli.main()
            self.assertEqual(exit_status.exception.code, 0)
            run.assert_called_once_with([FIXTURES / "demo.kicad_pcb"])
            server.assert_not_called()
            browser.assert_not_called()
