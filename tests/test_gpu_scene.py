"""Offscreen compilation of retained WebGL geometry, metadata and fallback."""

import math
import os
import unittest
from array import array

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPointF
from PySide6.QtGui import QGuiApplication
from pcbvisualizer.geometry.document import GeometryDocument
from pcbvisualizer.geometry.gpu_scene import build_scene

def application():
    return QGuiApplication.instance() or QGuiApplication([])


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
    return GeometryDocument(
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
