"""Retained geometry correctness and opt-in native OpenGL regressions.

Run live GPU checks separately with PCB_GPU_TESTS=1 QT_QPA_PLATFORM=cocoa.
The default tests compile small scenes without creating OpenGL contexts.
"""

import math
import os
import unittest
from array import array
from unittest.mock import Mock, patch

GPU_TESTS = os.environ.get("PCB_GPU_TESTS") == "1"
if not GPU_TESTS:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEventLoop, QPointF, QTimer
from PySide6.QtGui import QSurfaceFormat
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop.canvas import BoardCanvas
from pcbvisualizer.desktop.document import DocumentWorker, NativeDocument
from pcbvisualizer.desktop.gpu_scene import build_scene


def application():
    if existing := QApplication.instance():
        return existing
    if GPU_TESTS:
        surface = QSurfaceFormat()
        surface.setVersion(3, 2)
        surface.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
        QSurfaceFormat.setDefaultFormat(surface)
    return QApplication([])


def document(body=None):
    if body is None:
        body = """<g id="scene" transform="translate(2 3)">
          <g id="layer-top" data-layer-role="copper">
            <path id="pour" data-net="POUR" fill="#ff0000" fill-rule="evenodd"
              d="M2 2H14V12H2Z M6 5H10V9H6Z"/>
            <line id="route" data-net="A" data-component="CROSS"
              x1="2" y1="18" x2="34" y2="18" fill="none"
              stroke="#ff0000" stroke-width="2" stroke-linecap="round"/>
            <rect id="pad" data-primitive="pad" data-pad-number="1"
              data-net="PAD" data-component="U1" x="24" y="3"
              width="8" height="6" rx="2" fill="#ff0000"/>
            <circle id="via" data-primitive="via" data-net="A"
              cx="12" cy="22" r="1.8" fill="#00aa00"/>
            <ellipse id="translucent" data-net="ALPHA" cx="18" cy="3"
              rx="1.5" ry="1" fill="#00ff00" fill-opacity=".5"/>
          </g>
          <g id="layer-bottom" data-layer-role="copper">
            <line id="crossing" data-net="B" x1="20" y1="10" x2="20"
              y2="24" fill="none" stroke="#0000ff" stroke-width="2"/>
          </g>
          <g id="layer-polygons" data-layer-role="copper">
            <rect id="polygon" data-net="POLYGON" x="26" y="22"
              width="8" height="4" fill="#008000"/>
          </g>
          <g id="layer-drills" data-layer-role="drill">
            <circle data-hole-owner="via" data-primitive="via-hole"
              cx="12" cy="22" r=".6" fill="#1b1d21"/>
            <circle data-hole-owner="pad" data-primitive="pad-hole"
              cx="28" cy="6" r=".8" fill="#1b1d21"/>
            <circle data-hole-owner="via" data-primitive="via-hole"
              cx="30" cy="18" r=".6" fill="#1b1d21"/>
          </g>
        </g>"""
    return NativeDocument(
        {
            "name": "retained-scene",
            "kind": "pcb",
            "polygon_elements": ["polygon"],
            "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30">'
            + body
            + "</svg>",
        }
    )


def unpack(scene):
    vertices, indices = array("f"), array("I")
    vertices.frombytes(scene["vertices"])
    indices.frombytes(scene["indices"])
    return [
        vertices[index : index + 20] for index in range(0, len(vertices), 20)
    ], indices


class GpuSceneCompilationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = application()

    def test_buffers_preserve_metadata_and_evenodd_voids(self):
        source = document()
        scene = build_scene(source)
        self.assertTrue(scene["supported"], scene["reason"])
        self.assertEqual(scene["stride"], 80)
        rows, indices = unpack(scene)
        self.assertTrue(rows)
        self.assertTrue(all(math.isfinite(value) for row in rows for value in row))
        self.assertEqual(len(indices) % 3, 0)
        self.assertLess(max(indices), len(rows))
        self.assertEqual(scene["object_count"], len(source.primitives) + 1)
        ids = {
            primitive.id: index + 1 for index, primitive in enumerate(source.primitives)
        }
        self.assertIn(ids["route"], scene["object_nets"]["A"])
        self.assertEqual(scene["object_components"]["U1"], {ids["pad"]})
        self.assertIn("layer-drills", scene["drill_layers"])
        self.assertEqual(
            sum(entry["count"] for entry in scene["entries"]), len(indices)
        )

        def covered(x, y):
            for index in range(0, len(indices), 3):
                triangle = [rows[indices[index + corner]] for corner in range(3)]
                if int(triangle[0][13]) != ids["pour"]:
                    continue
                points = [
                    (row[0] + scene["origin"][0], row[1] + scene["origin"][1])
                    for row in triangle
                ]
                cross = [
                    (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
                    for a, b in zip(points, points[1:] + points[:1])
                ]
                if min(cross) >= -1e-6 or max(cross) <= 1e-6:
                    return True
            return False

        self.assertTrue(covered(6, 7), "outer copper must be triangulated")
        self.assertFalse(covered(10, 10), "even-odd copper void must stay empty")

    def test_nested_transforms_and_world_caption_and_hole_paths(self):
        source = document()
        scene = build_scene(source)
        self.assertEqual(len(scene["caption_paths"]), len(source.info()["captions"]))
        self.assertTrue(scene["caption_paths"][0].contains(QPointF(27, 9)))
        self.assertTrue(
            any(path.contains(QPointF(30, 9)) for _, path in scene["hole_paths"])
        )
        transformed = document("""<g id="scene"><g id="layer-top" data-layer-role="copper"
          transform="translate(10 10) rotate(90) scale(2 1)">
          <rect data-primitive="pad" data-pad-number="1" data-component="U1" x="0" y="0"
            width="4" height="2" fill="red"/>
          </g></g>""")
        result = build_scene(transformed)
        self.assertTrue(result["supported"], result["reason"])
        bounds = result["caption_paths"][0].boundingRect()
        for actual, expected in zip(
            (bounds.x(), bounds.y(), bounds.width(), bounds.height()),
            (8, 10, 2, 8),
            strict=True,
        ):
            self.assertAlmostEqual(actual, expected, places=6)

    def test_composition_requiring_svg_returns_explicit_complete_fallback(self):
        for attributes in (
            'opacity=".5"',
            'clip-path="url(#clip)"',
            'mask="url(#mask)"',
            'filter="url(#filter)"',
        ):
            with self.subTest(attributes=attributes):
                source = document(
                    f'<g id="scene"><g id="layer-top" {attributes}>'
                    '<rect width="20" height="20" fill="red"/>'
                    '<rect x="10" width="20" height="20" fill="blue"/>'
                    "</g></g>"
                )
                result = build_scene(source)
                self.assertFalse(result["supported"])
                self.assertTrue(result["reason"])
                self.assertEqual(
                    (result["vertices"], result["indices"], result["entries"]),
                    (b"", b"", []),
                )

    def test_driver_failure_after_scene_ready_restores_cpu_rendering(self):
        source = document()
        worker = DocumentWorker("unused")
        worker.document = source
        canvas = BoardCanvas(opengl=False)
        canvas.resize(400, 300)
        canvas.set_document(source.info())
        canvas.timer.stop()
        canvas.render_requested.connect(worker.render)
        worker.frame.connect(canvas.accept_frame)
        canvas.request_frame()
        self.assertIsNotNone(canvas.frame)
        self.assertTrue(hasattr(source, "pcb_raster"))
        canvas.opengl_view = Mock()
        worker.gpu_scene.connect(canvas.accept_gpu_scene)
        worker.build_gpu_scene()
        self.assertTrue(worker.retained_ready)
        self.assertIsNotNone(canvas.gpu_scene)
        self.assertIsNone(canvas.frame)
        self.assertFalse(hasattr(source, "pcb_raster"))
        with patch.object(source, "raster", wraps=source.raster) as raster:
            canvas.zoom_at(QPointF(200, 150), 1.5)
            canvas.request_frame()
            raster.assert_not_called()
            canvas.fallback_opengl("simulated driver failure after upload")
            canvas.timer.stop()
            canvas.request_frame()
            raster.assert_called_once()
        self.assertIsNone(canvas.gpu_scene)
        self.assertEqual(canvas.caption_paths, [])
        self.assertIsNotNone(canvas.frame)
        self.assertFalse(canvas.inflight)
        self.assertTrue(hasattr(source, "pcb_raster"))
        canvas.timer.stop()
        canvas.close()


@unittest.skipUnless(
    GPU_TESTS, "Set PCB_GPU_TESTS=1 on a live desktop for retained GL checks"
)
class RetainedSceneGpuTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = application()
        if cls.app.platformName() in {"offscreen", "minimal"}:
            raise RuntimeError("Retained GPU tests require a real desktop context")
        cls.quit_on_close = cls.app.quitOnLastWindowClosed()
        cls.app.setQuitOnLastWindowClosed(False)

    @classmethod
    def tearDownClass(cls):
        cls.app.setQuitOnLastWindowClosed(cls.quit_on_close)

    def wait_for(self, predicate):
        loop, poll, timeout = QEventLoop(), QTimer(), QTimer()
        poll.setInterval(10)
        poll.timeout.connect(lambda: loop.quit() if predicate() else None)
        timeout.setSingleShot(True)
        timeout.timeout.connect(loop.quit)
        poll.start()
        timeout.start(5000)
        try:
            if not predicate():
                loop.exec()
        finally:
            poll.stop()
            timeout.stop()
        self.assertTrue(predicate(), self.canvas.opengl_error)

    def setUp(self):
        self.document = document()
        self.scene = build_scene(self.document)
        self.assertTrue(self.scene["supported"], self.scene["reason"])
        self.canvas = BoardCanvas()
        self.addCleanup(self.canvas.close)
        self.addCleanup(self.canvas.timer.stop)
        self.canvas.resize(400, 300)
        self.canvas.set_document(dict(self.document.info(), captions=[]))
        self.canvas.camera, self.canvas.scale = QPointF(20, 15), 10
        self.canvas.accept_frame(
            self.document.raster(
                {
                    "token": 1,
                    "rect": self.canvas.viewport(),
                    "width": 400,
                    "height": 300,
                    "style": self.canvas.style_key(),
                }
            )
        )
        self.canvas.accept_gpu_scene(self.scene)
        self.canvas.timer.stop()
        self.canvas.setWindowTitle("PCBVisualizer — Retained geometry tests")
        self.canvas.show()
        self.view = self.canvas.opengl_view
        self.assertIsNotNone(self.view)
        self.wait_for(
            lambda: (
                getattr(self.view, "retained_renderer", None) is not None
                and self.view.retained_renderer.geometry_uploads == 1
            )
        )
        self.mesh = self.view.retained_renderer
        self.assertTrue(self.view.isValid(), self.canvas.opengl_error)
        self.assertTrue(self.view.gl_info.get("renderer"))
        if not getattr(type(self), "reported_context", False):
            print(
                f"\nRetained GPU context: {self.view.gl_info}; DPR={self.view.devicePixelRatioF()}",
                flush=True,
            )
            type(self).reported_context = True

    def tearDown(self):
        self.canvas.timer.stop()
        self.canvas.close()

    def assert_reference_pixels(self, points):
        self.canvas.update()
        actual = self.view.grabFramebuffer()
        self.assertFalse(actual.isNull())
        expected = self.document.raster(
            {
                "token": 2,
                "rect": self.canvas.viewport(),
                "width": actual.width(),
                "height": actual.height(),
                "style": self.canvas.style_key(),
            }
        )["image"]
        dpr = self.view.devicePixelRatioF()
        for world in points:
            point = self.canvas.to_screen(QPointF(*world))
            x, y = round(point.x() * dpr), round(point.y() * dpr)
            self.assertTrue(actual.rect().contains(x, y))
            for channel, reference in zip(
                actual.pixelColor(x, y).getRgb(),
                expected.pixelColor(x, y).getRgb(),
                strict=True,
            ):
                self.assertAlmostEqual(
                    channel, reference, delta=3, msg=f"world pixel {world}"
                )

    def test_camera_layers_pours_holes_and_selection_match_svg(self):
        points = [
            (6, 7),
            (10, 10),
            (20, 6),
            (8, 21),
            (22, 21),
            (27, 9),
            (30, 9),
            (14, 25),
            (15.2, 25),
            (32, 21),
            (30, 27),
        ]
        for components, nets in (
            (set(), set()),
            (set(), {"A"}),
            ({"U1"}, set()),
            ({"CROSS"}, {"A"}),
            (set(), {"POUR"}),
            (set(), set()),
        ):
            with self.subTest(components=components, nets=nets):
                self.canvas.components, self.canvas.nets = components, nets
                self.assert_reference_pixels(points)
        self.canvas.raise_layer("layer-top")
        self.assert_reference_pixels(points)
        self.canvas.visible.remove("layer-bottom")
        self.canvas.polygons = False
        self.assert_reference_pixels(points)
        self.canvas.camera += QPointF(1, 1)
        self.canvas.scale *= 1.1
        self.assert_reference_pixels([(8, 21), (22, 21), (30, 9), (32, 21)])
        self.assertEqual(self.mesh.geometry_uploads, 1)
        self.assertEqual(
            self.view.uploads, 0, "retained drawing must not upload board images"
        )

    def test_navigation_and_styles_only_update_uniforms_or_selection_lookup(self):
        requests = []
        self.canvas.render_requested.connect(requests.append)
        flags = self.mesh.selection_uploads
        with patch.object(
            self.document,
            "raster",
            side_effect=AssertionError("CPU refinement after retained upload"),
        ) as raster:
            for factor in (1.03, 0.8, 1.2):
                self.canvas.zoom_at(QPointF(200, 150), factor)
                self.canvas.camera += QPointF(0.5, -0.25)
                self.canvas.finish_navigation()
                self.view.grabFramebuffer()
            self.assertEqual(self.mesh.selection_uploads, flags)
            self.canvas.nets = {"A"}
            self.canvas.schedule()
            self.canvas.request_frame()
            self.view.grabFramebuffer()
            self.assertEqual(self.mesh.selection_uploads, flags + 1)
            self.canvas.polygons = False
            self.canvas.raise_layer("layer-top")
            self.canvas.visible.discard("layer-bottom")
            self.canvas.finish_navigation()
            self.view.grabFramebuffer()
            self.assertEqual(self.mesh.selection_uploads, flags + 1)
            raster.assert_not_called()
        self.assertEqual(requests, [])
        self.assertEqual(self.mesh.geometry_uploads, 1)
        self.assertEqual(self.view.uploads, 0)
        self.assertGreater(self.mesh.vertex_bytes, 0)
        self.assertGreater(self.mesh.index_bytes, 0)
        self.assertGreater(self.mesh.draw_calls, 0)
        self.canvas.release_graphics()
        self.assertEqual(
            (self.mesh.vertex_bytes, self.mesh.index_bytes, self.mesh.draw_calls),
            (0, 0, 0),
        )
        self.assertIsNone(self.mesh.vertex_buffer)
        self.assertIsNone(self.mesh.flags_texture)

    def test_subpixel_strokes_and_circles_preserve_integrated_coverage(self):
        source = NativeDocument(
            {
                "name": "subpixel-coverage",
                "kind": "pcb",
                "svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 -15 40 30">
                  <g id="scene"><g id="layer-top" data-layer-role="copper">
                    <line x1="-10" y1=".025" x2="10" y2=".025" stroke="red"
                      stroke-width=".005" stroke-linecap="butt"/>
                    <circle cx="15" cy=".025" r=".005" fill="red"/>
                  </g></g></svg>""",
            }
        )
        self.canvas.set_document(dict(source.info(), captions=[]))
        self.canvas.camera, self.canvas.scale = QPointF(), 10
        scene = build_scene(source)
        self.assertTrue(scene["supported"], scene["reason"])
        self.canvas.accept_gpu_scene(scene)
        self.canvas.timer.stop()
        actual = self.view.grabFramebuffer()
        self.assertIs(self.view.retained_renderer.scene, scene)
        expected = source.raster(
            {
                "token": 1,
                "rect": self.canvas.viewport(),
                "width": actual.width(),
                "height": actual.height(),
                "style": self.canvas.style_key(),
            }
        )["image"]
        dpr = self.view.devicePixelRatioF()
        middle = self.canvas.to_screen(QPointF(0, 0.025)) * dpr
        circle = self.canvas.to_screen(QPointF(15, 0.025)) * dpr
        line_columns = range(round(middle.x() - 80 * dpr), round(middle.x() + 80 * dpr))
        rows = range(round(middle.y()) - 5, round(middle.y()) + 6)

        def contrast(image, x, y):
            return max(0, (image.pixelColor(x, y).red() - 27) / 228)

        def coverage(image):
            line = sum(contrast(image, x, y) for x in line_columns for y in rows) / len(
                line_columns
            )
            area = sum(
                contrast(image, x, y)
                for x in range(round(circle.x()) - 10, round(circle.x()) + 11)
                for y in range(round(circle.y()) - 10, round(circle.y()) + 11)
            )
            return line, area

        for gpu, svg in zip(coverage(actual), coverage(expected), strict=True):
            self.assertGreater(svg, 0)
            self.assertAlmostEqual(gpu, svg, delta=0.02)


if __name__ == "__main__":
    unittest.main()
