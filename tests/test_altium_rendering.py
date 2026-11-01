"""Optimized Altium rendering must preserve the upstream SVG exactly."""

import hashlib
import inspect
import os
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

from altium_monkey import AltiumPcbDoc, PcbSvgRenderOptions
from altium_monkey.altium_board import AltiumBoardOutline
from altium_monkey.altium_pcb_svg_renderer import PcbSvgRenderer

from ecadview.altium_rendering import IndexedPcbSvgRenderer
from ecadview.rendering import prepare_embedded_fonts, resolve_polygon_nets


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

    def test_layer_stack_is_resolved_once_per_render_and_refreshed_for_the_next_render(self):
        pcb = self.board()
        renderer = IndexedPcbSvgRenderer(pcb, PcbSvgRenderOptions())
        with patch.object(PcbSvgRenderer, '_resolved_layer_stack_safe',
                          wraps=PcbSvgRenderer._resolved_layer_stack_safe) as resolve:
            first = renderer.render_board(pcb)
            self.assertEqual(resolve.call_count, 1)
            stack = renderer.resolved_stack
            self.assertIsNotNone(stack)
            second = renderer.render_board(pcb)
            self.assertEqual(resolve.call_count, 2)
        self.assertEqual(second, first)
        self.assertIsNot(renderer.resolved_stack, stack)

    def test_native_drill_batching_preserves_slots_plating_and_blind_vias(self):
        pcb = self.board()
        pcb.add_pad(
            designator="SLOT",
            position_mils=(1400, 500),
            width_mils=200,
            height_mils=400,
            hole_size_mils=80,
            slot_length_mils=300,
            slot_rotation_degrees=45,
            layer="MULTILAYER",
            net="SIG",
        )
        pcb.add_pad(
            designator="NPTH",
            position_mils=(1400, 1000),
            width_mils=150,
            height_mils=150,
            hole_size_mils=100,
            plated=False,
            layer="MULTILAYER",
        )
        pcb.add_via(
            position_mils=(600, 900),
            diameter_mils=40,
            hole_size_mils=20,
            layer_start="TOP",
            layer_end="MID1",
            net="BLIND",
        )
        pcb.add_via(
            position_mils=(600, 1100),
            diameter_mils=40,
            hole_size_mils=20,
            layer_start="MID1",
            layer_end="MID2",
            net="BURIED",
        )

        def physical_holes(svg):
            root = ET.fromstring(svg)
            drill = root.find(".//*[@id='layer-DRILLS']")
            if drill is None:
                return set(), 0
            items = set()
            count = 0

            def visit(node, owner="", transforms=()):
                nonlocal count
                if match := re.match(r"pcb-(pad|via)-(\d+)-", node.get("id", "")):
                    owner = match.groups()
                if node.get("transform"):
                    transforms = (*transforms, node.get("transform"))
                if node.tag.rsplit("}", 1)[-1] in {
                    "circle",
                    "rect",
                    "path",
                    "line",
                    "ellipse",
                }:
                    geometry = tuple(
                        sorted(
                            (name, value)
                            for name, value in node.attrib.items()
                            if name != "id" and not name.startswith("data-")
                        )
                    )
                    items.add((owner, geometry, transforms))
                    count += 1
                for child in node:
                    visit(child, owner, transforms)

            visit(drill)
            return items, count

        for mode in ("knockout", "overlay", "none"):
            with self.subTest(mode=mode):
                options = PcbSvgRenderOptions(drill_hole_mode=mode)
                expected, before = physical_holes(
                    PcbSvgRenderer(options).render_board(pcb)
                )
                actual, after = physical_holes(
                    IndexedPcbSvgRenderer(
                        pcb, options, compact_metadata=True
                    ).render_board(pcb)
                )
                self.assertEqual(actual, expected)
                if mode == "knockout":
                    self.assertGreater(len(actual), 4)
                    self.assertLess(after, before)

    def test_compact_native_svg_preserves_geometry_and_inherited_relationships(self):
        pcb = self.board()

        def graphics(svg):
            items = []
            holes = set()

            def visit(element, inherited):
                metadata = inherited | {
                    name: value
                    for name, value in element.attrib.items()
                    if name.startswith("data-") and name != "data-primitive-count"
                }
                kind = element.tag.rsplit("}", 1)[-1]
                if kind in {
                    "path",
                    "line",
                    "rect",
                    "circle",
                    "ellipse",
                    "polygon",
                    "polyline",
                    "text",
                }:
                    geometry = {
                        name: value
                        for name, value in element.attrib.items()
                        if not name.startswith("data-")
                    }
                    if metadata.get("data-primitive") in {"via-hole", "pad-hole"}:
                        owner = re.sub(r"-L\d+-hole$", "", geometry.get("id", ""))
                        if owner in holes:
                            return
                        holes.add(owner)
                    if (
                        kind == "path"
                        and metadata.get("data-primitive") == "text"
                        and geometry.get("fill") == "none"
                    ):
                        path = geometry.get("d", "")
                        segments = re.findall(r"M (\S+) (\S+) L (\S+) (\S+)", path)
                        self.assertTrue(segments)
                        style = {
                            name: value
                            for name, value in geometry.items()
                            if name != "d"
                        }
                        for x1, y1, x2, y2 in segments:
                            items.append(
                                (
                                    "line",
                                    {"x1": x1, "y1": y1, "x2": x2, "y2": y2, **style},
                                    metadata,
                                )
                            )
                        return
                    items.append((kind, geometry, metadata))
                for child in element:
                    visit(child, metadata)

            visit(ET.fromstring(svg), {})
            return items

        for clip in (False, True):
            with self.subTest(clip=clip):
                options = PcbSvgRenderOptions(clip_copper_to_board_outline=clip)
                expected = PcbSvgRenderer(options).render_board(pcb)
                compact = IndexedPcbSvgRenderer(
                    pcb, options, compact_metadata=True
                ).render_board(pcb)
                self.assertEqual(graphics(compact), graphics(expected))
                self.assertLess(len(compact), len(expected) * 0.7)

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
