"""Offscreen geometry and SVG reference-raster regression coverage."""
import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import tempfile
import unittest
from pathlib import Path
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QPointF, QRectF
from PySide6.QtGui import QColor, QGuiApplication, QImage, QPainter
from ecadview.geometry.document import GeometryDocument
from ecadview.rendering import render_file
APP = QGuiApplication.instance() or QGuiApplication([])
ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "kicad"

def board_document():
    return GeometryDocument(render_file(FIXTURES / "demo.kicad_pcb"))


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


class GeometryReferenceTests(unittest.TestCase):
    def test_embedded_schematic_images_survive_conversion_zoom_and_style_reload(self):
        pixels = QImage(8, 4, QImage.Format.Format_ARGB32)
        pixels.fill(QColor("red"))
        painter = QPainter(pixels)
        painter.fillRect(QRectF(4, 0, 4, 4), QColor("blue"))
        painter.end()
        encoded = QByteArray()
        buffer = QBuffer(encoded)
        buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        self.assertTrue(pixels.save(buffer, "PNG"))
        buffer.close()
        uri = "data:image/png;base64," + bytes(encoded.toBase64()).decode("ascii")
        for prefix in ("xlink", "asset"):
            with self.subTest(prefix=prefix):
                svg = (
                    '<svg xmlns="http://www.w3.org/2000/svg" '
                    f'xmlns:{prefix}="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">'
                    '<rect width="10" height="10" fill="#fffcf8"/>'
                    '<g id="scene" transform="translate(1 2)">'
                    f'<image x="2" y="1" width="4" height="2" {prefix}:href="{uri}"/>'
                    '<path data-net="N" d="M0 6H8" stroke="black"/>'
                    "</g></svg>"
                )
                document = GeometryDocument(
                    {"name": "diagram", "kind": "schematic", "svg": svg}
                )
                for nets in ((), ("N",), ()):
                    request = {
                        "token": 1,
                        "rect": document.home,
                        "width": 200,
                        "height": 200,
                        "style": (set(), True, set(), set(nets), ()),
                    }
                    image = document.raster(request)["image"]
                    self.assertEqual(image.pixelColor(80, 80).name(), "#ff0000")
                    self.assertEqual(image.pixelColor(120, 80).name(), "#0000ff")
                    self.assertEqual(image.pixelColor(40, 80).name(), "#fffcf8")
                    self.assertEqual(paint_at(document, 4, 4, nets=nets), "#ff0000")
                    self.assertEqual(paint_at(document, 6, 4, nets=nets), "#0000ff")
                self.assertEqual(document.data["svg"], svg)

    def test_repeated_style_changes_restore_original_attributes_order_and_pixels(self):
        import xml.etree.ElementTree as etree

        for name in ("demo.kicad_pcb", "demo.kicad_sch"):
            with self.subTest(name=name):
                document = GeometryDocument(render_file(FIXTURES / name))
                info = document.info()
                layers = {layer["id"] for layer in info["layers"]}
                component = next(iter(info["components"]))
                net = next(iter(info["nets"]))
                original = etree.tostring(document.root)
                request = {
                    "token": 1,
                    "rect": info["home"],
                    "width": 400,
                    "height": 300,
                }
                baseline = (layers, True, set(), set(), ())
                expected = document.raster(dict(request, style=baseline))["image"]
                styles = [
                    (set(), False, {component}, set(), tuple(sorted(layers))),
                    (layers, True, set(), {net}, tuple(sorted(layers, reverse=True))),
                    (layers, False, {component}, {net}, ()),
                ]
                for style in styles * 3:
                    document.raster(dict(request, style=style))
                    actual = document.raster(dict(request, style=baseline))["image"]
                    self.assertEqual(actual, expected)
                    self.assertEqual(etree.tostring(document.root), original)
                    self.assertIsNone(document.selection_overlay)

    def test_measurement_centres_include_unconnected_copper_and_transform_exact_origins(
        self,
    ):
        document = GeometryDocument(
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
            GeometryDocument(render_file(FIXTURES / "demo.kicad_sch")).info()[
                "snap_points"
            ],
            [],
        )

    def test_layer_order_changes_crossing_paint_and_pick_but_preserves_drills(self):
        document = GeometryDocument(
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
                    document = GeometryDocument(
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
            document = GeometryDocument({"name": "component", "kind": kind, "svg": svg})
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
        document = GeometryDocument(
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
        document = GeometryDocument(render_file(FIXTURES / "demo.kicad_sch"))
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
        document = GeometryDocument(render_file(FIXTURES / "demo.kicad_sch"))
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
        document = GeometryDocument(render_file(FIXTURES / "legacy.sch"))
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
        document = GeometryDocument(
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

    def test_generated_altium_documents_use_the_same_compact_renderer(self):
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
            document = GeometryDocument(render_file(path))
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
            document = GeometryDocument(render_file(path))
            self.assertEqual(document.info()["kind"], "schematic")
            self.assertTrue(document.info()["nets"])

    def test_reference_raster_and_spatial_selection_respect_holes_layers_and_pours(self):
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

    def test_selection_style_is_local_and_does_not_change_source_or_geometry(self):
        path = FIXTURES / "demo.kicad_pcb"
        source = path.read_bytes()
        document = GeometryDocument(render_file(path))
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

    def test_tiny_compiler_text_is_outlined_without_zero_pixel_fonts(self):
        data = {
            "name": "tiny",
            "kind": "pcb",
            "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><g id="scene"><g id="layer-top"><text data-component="R1" x=".5" y=".5" font-size=".1">R1</text></g></g></svg>',
        }
        document = GeometryDocument(data)
        self.assertNotIn(b"<text", document.source)
        self.assertGreater(document.info()["component_bounds"]["R1"].width(), 0)
