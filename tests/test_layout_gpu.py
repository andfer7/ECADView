"""CPU fallback checks and opt-in live-desktop layout OpenGL regressions.

Run GPU checks separately: PCB_GPU_TESTS=1 QT_QPA_PLATFORM=cocoa
python -B -m unittest tests.test_layout_gpu -v. Offscreen results cannot
demonstrate GPU acceleration.
"""

import os
import time
import unittest
from unittest.mock import Mock, patch

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt
from PySide6.QtGui import (
    QColor,
    QImage,
    QNativeGestureEvent,
    QPainter,
    QPointingDevice,
    QSurfaceFormat,
)
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop.canvas import BoardCanvas

GPU_TESTS = os.environ.get("PCB_GPU_TESTS") == "1"


def application():
    existing = QApplication.instance()
    if existing is not None:
        return existing
    if GPU_TESTS:
        surface = QSurfaceFormat()
        surface.setVersion(3, 2)
        surface.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
        QSurfaceFormat.setDefaultFormat(surface)
    return QApplication([])


def info(kind="pcb"):
    return {
        "kind": kind,
        "home": QRectF(-10, -10, 20, 20),
        "layers": [{"id": "top", "visible": True}],
        "captions": [],
        "snap_points": [(QPointF(-1, -0.5), frozenset({"top"}))],
    }


def image(color="red", width=400, height=300):
    result = QImage(width, height, QImage.Format.Format_ARGB32_Premultiplied)
    result.fill(QColor(color))
    return result


def frame(canvas, pixels, rect=None):
    return {
        "image": pixels,
        "rect": QRectF(-10, -7.5, 20, 15) if rect is None else rect,
        "style": canvas.style_key(),
    }


class LayoutFallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = application()

    def setUp(self):
        self.canvas = BoardCanvas(opengl=False)
        self.canvas.resize(400, 300)
        self.canvas.set_document(info())
        self.canvas.timer.stop()
        self.canvas.camera, self.canvas.scale = QPointF(), 20
        self.canvas.frame = frame(self.canvas, image("#a03020"))

    def tearDown(self):
        self.canvas.timer.stop()
        self.canvas.close()

    def test_disabled_and_headless_platforms_keep_the_cpu_canvas(self):
        self.assertIsNone(self.canvas.opengl_view)
        for platform in ("offscreen", "minimal"):
            with self.subTest(platform=platform):
                self.canvas._opengl_requested = True
                with patch.object(QApplication, "platformName", return_value=platform):
                    self.canvas.enable_opengl()
                self.assertIsNone(self.canvas.opengl_view)
        target = image("black")
        painter = QPainter(target)
        self.canvas.render(painter, QPoint())
        painter.end()
        self.assertEqual(target.pixelColor(40, 40), QColor("#a03020"))

    def test_graphics_failure_keeps_document_state_and_releases_resources(self):
        canvas = self.canvas
        canvas.components, canvas.nets = {"U1"}, {"N"}
        canvas.measurements = [(QPointF(-1, 0), QPointF(1, 0))]
        original = canvas.frame
        broken_view = Mock()
        canvas.opengl_view = broken_view
        canvas.fallback_opengl("driver initialization failed")
        self.assertIsNone(canvas.opengl_view)
        self.assertEqual(canvas.opengl_error, "driver initialization failed")
        self.assertEqual(canvas.camera, QPointF())
        self.assertEqual(canvas.scale, 20)
        self.assertEqual((canvas.components, canvas.nets), ({"U1"}, {"N"}))
        self.assertEqual(len(canvas.measurements), 1)
        self.assertIs(canvas.frame, original)
        broken_view.hide.assert_called_once()
        broken_view.cleanup.assert_called_once()
        broken_view.deleteLater.assert_called_once()
        target = image("black")
        painter = QPainter(target)
        canvas.render(painter, QPoint())
        painter.end()
        self.assertEqual(target.pixelColor(40, 40), QColor("#a03020"))
        self.assertGreater(target.pixelColor(200, 150).red(), 240)

    def test_invalid_context_and_constructor_failure_fall_back(self):
        canvas = self.canvas
        invalid = Mock()
        invalid.isVisible.return_value = True
        invalid.isValid.return_value = False
        canvas.opengl_view = invalid
        canvas.check_opengl()
        self.assertIsNone(canvas.opengl_view)
        self.assertIn("context", canvas.opengl_error)
        canvas._opengl_requested = True
        with (
            patch.object(QApplication, "platformName", return_value="cocoa"),
            patch(
                "pcbvisualizer.desktop.opengl.LayoutOpenGLView",
                side_effect=RuntimeError("unavailable driver"),
            ),
        ):
            canvas.enable_opengl()
        self.assertIsNone(canvas.opengl_view)
        self.assertIn("unavailable driver", canvas.opengl_error)
        canvas.set_document(info("schematic"))
        self.assertIsNone(canvas.opengl_view)


@unittest.skipUnless(
    GPU_TESTS, "Set PCB_GPU_TESTS=1 on a live desktop for real GL checks"
)
class LayoutGpuTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = application()
        if cls.app.platformName() in {"offscreen", "minimal"}:
            raise RuntimeError("GPU checks require a live desktop Qt platform")

    def setUp(self):
        self.canvas = BoardCanvas()
        self.canvas.resize(400, 300)
        self.canvas.set_document(info())
        self.canvas.camera, self.canvas.scale = QPointF(), 20
        self.canvas.frame = frame(self.canvas, image())
        self.canvas.show()
        self.view = self.canvas.opengl_view
        self.assertIsNotNone(self.view)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            self.app.processEvents()
            if self.view.gl_info and self.view.paint_count:
                break
            QTest.qWait(10)
        self.canvas.timer.stop()
        self.assertTrue(self.view.isValid(), self.canvas.opengl_error)
        self.assertTrue(self.view.gl_info, self.canvas.opengl_error)
        self.assertTrue(self.view.renderer)
        self.assertGreater(self.view.paint_count, 0)
        if not getattr(type(self), "_reported_context", False):
            print(f"\nLayout GPU context: {self.view.gl_info}", flush=True)
            type(self)._reported_context = True

    def tearDown(self):
        self.canvas.timer.stop()
        self.canvas.release_graphics()
        self.canvas.close()
        self.app.processEvents()

    def snapshot(self):
        self.canvas.update()
        result = self.view.grabFramebuffer()
        self.assertFalse(result.isNull())
        return result

    def assert_cpu_samples(self, points):
        actual = self.snapshot()
        expected = QImage(actual.size(), QImage.Format.Format_ARGB32_Premultiplied)
        expected.setDevicePixelRatio(self.view.devicePixelRatioF())
        expected.fill(QColor("#1b1d21"))
        painter = QPainter(expected)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        for item in self.canvas.display_frames():
            rect = item["rect"]
            painter.drawImage(
                QRectF(
                    self.canvas.to_screen(rect.topLeft()),
                    self.canvas.to_screen(rect.bottomRight()),
                ),
                item["image"],
            )
        painter.end()
        dpr = self.view.devicePixelRatioF()
        for x, y in points:
            a = actual.pixelColor(round(x * dpr), round(y * dpr)).getRgb()
            b = expected.pixelColor(round(x * dpr), round(y * dpr)).getRgb()
            for channel, reference in zip(a, b, strict=True):
                self.assertAlmostEqual(
                    channel, reference, delta=2, msg=f"pixel {(x, y)}"
                )

    def test_texture_orientation_alpha_anchor_pan_and_overview_match_cpu(self):
        pixels = image()
        painter = QPainter(pixels)
        for rect, color in (
            (QRectF(0, 0, 200, 150), "#d03020"),
            (QRectF(200, 0, 200, 150), "#20b040"),
            (QRectF(0, 150, 200, 150), "#2040c0"),
            (QRectF(200, 150, 200, 150), "#e0b020"),
        ):
            painter.fillRect(rect, QColor(color))
        painter.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        painter.fillRect(QRectF(140, 100, 60, 60), QColor(200, 100, 50, 128))
        painter.end()
        self.canvas.frame = frame(self.canvas, pixels)
        points = [(40, 40), (350, 40), (40, 250), (350, 250), (165, 120)]
        self.assert_cpu_samples(points)
        anchor = QPointF(300, 80)
        world = self.canvas.to_world(anchor)
        self.canvas.zoom_at(anchor, 1.4)
        self.canvas.timer.stop()
        self.assertLess((self.canvas.to_world(anchor) - world).manhattanLength(), 1e-9)
        self.assert_cpu_samples(points)
        self.canvas.camera += QPointF(2, -1)
        self.canvas.schedule(navigation=True)
        self.canvas.timer.stop()
        self.assert_cpu_samples(points)
        self.canvas.camera, self.canvas.scale = QPointF(), 20
        self.canvas.overview = frame(self.canvas, image("purple"))
        self.canvas.frame = frame(
            self.canvas, image("cyan", 120, 80), QRectF(-3, -2, 6, 4)
        )
        self.assert_cpu_samples([(200, 150), (40, 40), (350, 250)])

    def test_navigation_reuses_textures_and_replacement_and_cleanup_are_bounded(self):
        self.snapshot()
        uploads = self.view.uploads
        for _ in range(4):
            self.canvas.zoom_at(QPointF(230, 100), 1.01)
            self.canvas.timer.stop()
            self.snapshot()
        self.canvas.frame = dict(
            self.canvas.frame, image=QImage(self.canvas.frame["image"])
        )
        self.canvas.resize(440, 320)
        self.canvas.timer.stop()
        self.snapshot()
        self.assertEqual(self.view.uploads, uploads)
        self.canvas.overview = self.canvas.frame
        for color in ("blue", "green", "yellow"):
            self.canvas.frame = frame(self.canvas, image(color), QRectF(-3, -2, 6, 4))
            self.snapshot()
            uploads += 1
            self.assertEqual(self.view.uploads, uploads)
            self.assertEqual(self.view.texture_count, 2)
            self.assertLessEqual(self.view.texture_bytes, 2 * 4096 * 4096 * 4)
        self.canvas.release_graphics()
        self.assertIsNone(self.canvas.opengl_view)
        self.assertEqual(self.view.texture_count, 0)
        self.assertEqual(self.view.texture_bytes, 0)

    def test_gpu_child_preserves_input_and_draws_measurement_and_caption_overlays(self):
        canvas = self.canvas
        self.assertIs(self.app.widgetAt(canvas.mapToGlobal(QPoint(200, 150))), canvas)
        event = QNativeGestureEvent(
            Qt.NativeGestureType.ZoomNativeGesture,
            QPointingDevice.primaryPointingDevice(),
            2,
            QPointF(200, 150),
            QPointF(200, 150),
            QPointF(canvas.mapToGlobal(QPoint(200, 150))),
            0.1,
            QPointF(),
            1,
        )
        before = canvas.scale
        self.app.sendEvent(self.view, event)
        self.assertAlmostEqual(canvas.scale, before * 1.1)
        canvas.timer.stop()
        metadata = info()
        metadata["captions"] = [
            (QRectF(-0.4, 0.3, 0.8, 0.8), "1", "N", "top", False, "U1")
        ]
        canvas.set_document(metadata)
        canvas.timer.stop()
        canvas.camera, canvas.scale = QPointF(), 100
        canvas.frame = frame(canvas, image("#604020"), canvas.viewport())
        canvas.measurements = [(QPointF(-1, -0.5), QPointF(1, -0.5))]
        target, snapped = canvas.measurement_position(QPointF(104, 100), True)
        self.assertTrue(snapped)
        self.assertEqual(target, QPointF(-1, -0.5))
        result = self.snapshot()
        dpr = self.view.devicePixelRatioF()
        stroke = result.pixelColor(round(200 * dpr), round(100 * dpr))
        self.assertGreater(min(stroke.getRgb()[:3]), 240)
        self.assertNotEqual(
            result.pixelColor(round(200 * dpr), round(220 * dpr)), QColor("#604020")
        )
        for left, top, right, bottom in ((150, 50, 250, 95), (185, 195, 215, 245)):
            white_pixels = sum(
                min(result.pixelColor(x, y).getRgb()[:3]) > 220
                for x in range(round(left * dpr), round(right * dpr))
                for y in range(round(top * dpr), round(bottom * dpr))
            )
            self.assertGreater(white_pixels, 10, "GPU text glyphs must be visible")
        marker = result.pixelColor(round(100 * dpr), round(110 * dpr))
        self.assertGreater(min(marker.getRgb()[:3]), 240)
        canvas.measurements = [(QPointF(-1, -0.5), QPointF(1, 0.5))]
        canvas.selected_measurement = 0
        result = self.snapshot()
        white_dashes = sum(
            min(result.pixelColor(round(x * dpr), round(100 * dpr)).getRgb()[:3]) > 220
            for x in range(150, 250)
        )
        self.assertGreater(white_dashes, 10, "selected X/Y leg must be visible")
        self.assertLess(white_dashes, 90, "selected X/Y leg must retain its dashes")


if __name__ == "__main__":
    unittest.main()
