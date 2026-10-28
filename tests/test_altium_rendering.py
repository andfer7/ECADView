"""Optimized Altium rendering must preserve the upstream SVG exactly."""

import hashlib
import inspect
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from altium_monkey import AltiumPcbDoc, PcbSvgRenderOptions
from altium_monkey.altium_board import AltiumBoardOutline
from altium_monkey.altium_pcb_svg_renderer import PcbSvgRenderer

from pcbvisualizer.altium_rendering import IndexedPcbSvgRenderer
from pcbvisualizer.rendering import prepare_embedded_fonts, resolve_polygon_nets


class IndexedAltiumRenderingTests(unittest.TestCase):
    def board(self):
        pcb = AltiumPcbDoc()
        pcb.set_board_outline(
            AltiumBoardOutline.from_points_mils(
                [(0, 0), (2000, 0), (2000, 2000), (0, 2000)]
            )
        )
        for layer in ("TOP", "MID1", "BOTTOM", "MECHANICAL17"):
            for index in range(10):
                pcb.add_track(
                    (100, 100 + index * 25),
                    (800, 100 + index * 25),
                    width_mils=10,
                    layer=layer,
                    net="SIG",
                )
            pcb.add_arc(
                center_mils=(800, 800),
                radius_mils=100,
                start_angle_degrees=0,
                end_angle_degrees=180,
                width_mils=10,
                layer=layer,
                net="SIG",
            )
            pcb.add_fill((1000, 1000), (1100, 1100), layer=layer, net="SIG")
            pcb.add_region(
                outline_points_mils=[(1200, 1200), (1300, 1200), (1300, 1300)],
                layer=layer,
                net="SIG",
            )
        pcb.add_pad(
            designator="1",
            position_mils=(500, 500),
            width_mils=80,
            height_mils=80,
            layer="MULTILAYER",
            net="SIG",
        )
        pcb.add_via(
            position_mils=(600, 500), diameter_mils=40, hole_size_mils=20, net="SIG"
        )
        pcb.add_text(text="REFERENCE", position_mils=(400, 1200), height_mils=50)
        return pcb

    def test_exact_svg_including_v7_layers_multilayer_copper_and_original_ids(self):
        pcb = self.board()
        for options in (
            PcbSvgRenderOptions(),
            PcbSvgRenderOptions(
                visible_layers=["BOTTOM", "TOP", "MECHANICAL17"],
                layer_render_order=["MECHANICAL17", "BOTTOM", "TOP"],
            ),
            PcbSvgRenderOptions(
                clip_copper_to_board_outline=True, include_metadata=False
            ),
        ):
            with self.subTest(options=options):
                expected = PcbSvgRenderer(options).render_board(pcb)
                actual = IndexedPcbSvgRenderer(pcb, options).render_board(pcb)
                self.assertEqual(actual, expected)

    def test_signature_discovery_does_not_scale_with_primitive_and_layer_count(self):
        pcb = self.board()
        with patch("inspect.signature", wraps=inspect.signature) as signature:
            svg = IndexedPcbSvgRenderer(pcb, PcbSvgRenderOptions()).render_board(pcb)
        self.assertIn('data-primitive="track"', svg)
        self.assertLess(signature.call_count, len(pcb.tracks))

    @unittest.skipUnless(
        os.environ.get("PERF_TEST_FILE"),
        "Set PERF_TEST_FILE for the large reference board",
    )
    def test_reference_board_is_identical_to_upstream_and_source_is_unchanged(self):
        path = Path(os.environ["PERF_TEST_FILE"])
        original = hashlib.sha256(path.read_bytes()).digest()
        pcb = AltiumPcbDoc.from_file(path)
        prepare_embedded_fonts(pcb)
        resolve_polygon_nets(pcb)
        options = PcbSvgRenderOptions(svg_display_scale=4.0)
        expected = hashlib.sha256(
            PcbSvgRenderer(options).render_board(pcb).encode()
        ).digest()
        actual = hashlib.sha256(
            IndexedPcbSvgRenderer(pcb, options).render_board(pcb).encode()
        ).digest()
        self.assertEqual(actual, expected)
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)
