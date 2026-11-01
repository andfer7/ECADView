"""Retained path triangles agree with Qt's SVG paint at non-edge samples."""

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtCore import QRectF
from PySide6.QtGui import QImage, QPainter
from PySide6.QtGui import QGuiApplication

from ecadview.geometry.document import GeometryDocument
from ecadview.geometry.gpu_scene import build_scene


class RetainedPathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def test_spaced_linear_pours_match_general_parser_exactly(self):
        graphics = ('<path id="p" data-net="GND" fill="red" fill-rule="evenodd" '
                    'd="M 0 0 L 30 0 L 30 30 L 0 30 Z M 5 5 L 25 5 L 25 25 L 5 25 Z"/>')
        data = {'name': 'linear', 'svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
                '<g id="scene"><g id="layer-top">' + graphics + '</g></g></svg>'}
        optimized = build_scene(GeometryDocument(data))
        with patch('ecadview.geometry.gpu_scene._spaced_linear_path', return_value=None):
            reference = build_scene(GeometryDocument(data))
        self.assertTrue(optimized['supported'])
        for key in ('vertices', 'indices', 'entries', 'object_nets'):
            self.assertEqual(optimized[key], reference[key], key)
        from ecadview.geometry.gpu_scene import parse_path, UnsupportedScene
        for invalid in ('M 0 0 L 1e999 2 Z', 'M 0 0 L 4 Z', 'M 0 0 L 1.2.3 2'):
            with self.subTest(invalid=invalid), self.assertRaises(UnsupportedScene):
                parse_path(invalid)

    def assert_svg_coverage(self, graphic, inside, outside):
        document = GeometryDocument(
            {
                "name": "curves",
                "svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
                '<g id="scene"><g id="layer-top" data-layer-role="copper">'
                + graphic
                + "</g></g></svg>",
            }
        )
        scene = build_scene(document)
        self.assertTrue(scene["supported"], scene.get("reason"))
        vertices = np.frombuffer(scene["vertices"], dtype="<f4").reshape((-1, 20))
        indices = np.frombuffer(scene["indices"], dtype="<u4").reshape((-1, 3))
        self.assertTrue(len(indices), "The tested path must emit triangles")
        self.assertTrue(np.all(vertices[:, 12] == 0), "These paths use fill triangles")
        triangles = (vertices[:, :2] + np.asarray(scene["origin"]))[indices]

        raster = QImage(400, 400, QImage.Format.Format_ARGB32_Premultiplied)
        raster.fill(0)
        painter = QPainter(raster)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        document.renderer.render(painter, QRectF(0, 0, 400, 400))
        painter.end()

        def cross(a, b):
            return a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]

        a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
        nondegenerate = np.abs(cross(b - a, c - a)) > 1e-10
        for expected, points in ((True, inside), (False, outside)):
            for point in points:
                with self.subTest(point=point, expected=expected):
                    qt_coverage = (
                        raster.pixelColor(
                            round(point[0] * 10), round(point[1] * 10)
                        ).alpha()
                        > 128
                    )
                    self.assertEqual(qt_coverage, expected, "Choose a clear SVG sample")
                    p = np.asarray(point)
                    sides = np.column_stack(
                        (cross(b - a, p - a), cross(c - b, p - b), cross(a - c, p - c))
                    )
                    mesh_coverage = bool(
                        np.any(
                            nondegenerate
                            & (
                                np.all(sides >= -1e-9, axis=1)
                                | np.all(sides <= 1e-9, axis=1)
                            )
                        )
                    )
                    self.assertEqual(mesh_coverage, qt_coverage)

    def test_arc_cubic_smooth_and_quadratic_smooth_match_svg(self):
        cases = (
            (
                "M8 20 A12 12 0 0 1 32 20 L32 32 H8 Z",
                [(20, 12), (20, 24), (10, 28)],
                [(5, 20), (20, 5), (35, 25), (20, 35)],
            ),
            (
                "M5 20 C5 5 15 5 20 20 S35 35 35 20 L35 38 H5 Z",
                [(10, 25), (20, 35), (30, 36)],
                [(10, 5), (27, 20), (38, 30)],
            ),
            (
                "M5 20 q7.5 -24 15 0 t15 0 L35 38 H5 Z",
                [(10, 25), (20, 35), (30, 36)],
                [(10, 5), (27, 20), (38, 30)],
            ),
        )
        for path, inside, outside in cases:
            with self.subTest(path=path):
                self.assert_svg_coverage(
                    f'<path data-net="N" d="{path}" fill="red"/>', inside, outside
                )

    def test_relative_dashed_stroke_preserves_dash_offset_and_round_caps(self):
        self.assert_svg_coverage(
            '<path data-net="N" d="m4 20 h32" fill="none" stroke="red" '
            'stroke-width="2" stroke-linecap="round" stroke-dasharray="4 3" '
            'stroke-dashoffset="1"/>',
            [(5.5, 20), (11.5, 20), (18.5, 20), (25.5, 20), (32.5, 20)],
            [(8.5, 20), (15.5, 20), (22.5, 20), (29.5, 20), (12, 16), (12, 24)],
        )

    def test_evenodd_and_nonzero_nested_rings_preserve_holes_and_islands(self):
        outer = "M4 4 H36 V36 H4 Z "
        clockwise = "M12 12 H28 V28 H12 Z "
        counterclockwise = "M12 12 V28 H28 V12 Z "
        island = "M17 17 H23 V23 H17 Z"
        cases = (
            ("evenodd", clockwise, [(7, 7), (20, 20)], [(14, 20), (2, 20)]),
            ("nonzero", clockwise, [(7, 7), (14, 20), (20, 20)], [(2, 20)]),
            ("nonzero", counterclockwise, [(7, 7), (20, 20)], [(14, 20), (2, 20)]),
        )
        for rule, inner, inside, outside in cases:
            with self.subTest(rule=rule, inner=inner):
                self.assert_svg_coverage(
                    f'<path data-net="N" d="{outer + inner + island}" '
                    f'fill="red" fill-rule="{rule}"/>',
                    inside,
                    outside,
                )


if __name__ == "__main__":
    unittest.main()
