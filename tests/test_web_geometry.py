"""Browser transport, isolated Qt preparation and shader parity."""

import json
from pathlib import Path
import struct
import subprocess
import unittest
from unittest.mock import patch

from pcbvisualizer.web_geometry import encode_scene, prepare_geometry, _compiler


class WebGeometryTests(unittest.TestCase):
    def test_binary_header_and_buffers_are_aligned(self):
        data = encode_scene({"supported": True, "vertices": b"v" * 80,
                             "indices": b"i" * 12, "object_nets": {"A": {3, 1}}})
        length, = struct.unpack_from("<I", data)
        self.assertEqual(length % 4, 0)
        header = json.loads(data[4:4 + length])
        self.assertEqual(header["object_nets"], {"A": [1, 3]})
        self.assertEqual(header["vertex_bytes"], 80)
        self.assertEqual(data[4 + length:], b"v" * 80 + b"i" * 12)

    def test_isolated_worker_compiles_and_preserves_selection(self):
        result = prepare_geometry(json.dumps({"svg": '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
          <g id="scene"><g id="layer-top" data-layer-role="copper">
          <rect data-net="GND" data-component="U1" data-primitive="pad" width="10" height="10" fill="red"/>
          </g></g></svg>'''}).encode())
        length, = struct.unpack_from("<I", result)
        header = json.loads(result[4:4 + length])
        self.assertTrue(header["supported"], header.get("reason"))
        self.assertTrue(header["object_nets"]["GND"])
        self.assertEqual(header["object_nets"]["GND"], header["object_components"]["U1"])
        self.assertEqual(list(header["caption_bounds"].values()), [[0.0, 0.0, 10.0, 10.0]])
        self.assertEqual(header["snap_points"], [{"x": 5.0, "y": 5.0, "layers": ["layer-top"]}])
        self.assertGreater(header["vertex_bytes"], 0)
        self.assertEqual(len(result), 4 + length + header["vertex_bytes"] + header["index_bytes"])

    def test_unsupported_composition_returns_explicit_fallback(self):
        result = prepare_geometry(json.dumps({"svg": '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
          <g id="scene" opacity=".5"><rect width="10" height="10"/></g></svg>'''}).encode())
        length, = struct.unpack_from("<I", result)
        header = json.loads(result[4:4 + length])
        self.assertFalse(header["supported"])
        self.assertTrue(header["reason"])
        self.assertEqual(header["vertex_bytes"], 0)

    def test_preparation_is_bounded_and_recovers_after_timeout(self):
        with _compiler:
            self.assertIsNone(prepare_geometry(b"{}"))
        with patch("pcbvisualizer.web_geometry.subprocess.run", side_effect=subprocess.TimeoutExpired("worker", 90)):
            with self.assertRaisesRegex(ValueError, "timed out"):
                prepare_geometry(b"{}")
        self.assertTrue(_compiler.acquire(blocking=False))
        _compiler.release()

    def test_webgl_shader_matches_native_coverage(self):
        from pcbvisualizer.desktop.gpu_mesh import VERTEX_SHADER, FRAGMENT_SHADER
        source = (Path(__file__).resolve().parents[1] / "pcbvisualizer/static/layout-shaders.js").read_text()
        for shader in (VERTEX_SHADER, FRAGMENT_SHADER):
            converted = shader.replace("#version 150", "#version 300 es\nprecision highp float;\nprecision highp int;")
            converted = converted.replace("vec3(57.0, 224.0, 243.0)", "vec3(104.0, 224.0, 255.0)")
            self.assertIn(converted, source)


if __name__ == "__main__":
    unittest.main()
