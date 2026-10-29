"""Physical geometry and end-to-end parser coverage for the simplified 3D scene."""

from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import xml.etree.ElementTree as ET
from unittest.mock import patch

from altium_monkey import AltiumPcbDoc
from altium_monkey.altium_board import AltiumBoardOutline, BoardOutlineVertex
from altium_monkey.altium_pcb_enums import PcbBodyProjection, PcbIpc4761ViaType
from shapely.geometry import Point, Polygon

from pcbvisualizer.rendering import render_file
from pcbvisualizer.scene3d import build_scene, contour, MIL_MM


def board():
    pcb = AltiumPcbDoc()
    pcb.set_board_outline(AltiumBoardOutline.from_points_mils([(0, 0), (2000, 0), (2000, 1000), (0, 1000)]))
    return pcb


def area(scene):
    return sum(Polygon(part['outline'], part['holes']).area for part in scene['board'])


class Scene3DTests(unittest.TestCase):
    def test_surface_origin_aligns_svg_pads_with_the_3d_board(self):
        pcb = board()
        pcb.add_pad(designator='1', position_mils=(1000, 500), width_mils=60, height_mils=60)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'surface.PcbDoc'; pcb.save(path)
            original = path.read_bytes()
            data = render_file(path, native=True)
            self.assertEqual(path.read_bytes(), original)
        root = ET.fromstring(data['svg'])
        pad = next(element for element in root.iter() if element.get('data-primitive') == 'pad')
        x, y = data['scene3d']['surface_origin']
        self.assertAlmostEqual(float(pad.get('x')) + float(pad.get('width')) / 2, x, places=3)
        self.assertAlmostEqual(float(pad.get('y')) + float(pad.get('height')) / 2, y, places=3)
        self.assertEqual(data['scene3d']['origin'], [1000 * MIL_MM, 500 * MIL_MM])

    def test_round_trip_retains_cutouts_dimensions_body_heights_and_source_file(self):
        pcb = board()
        pcb.add_region(outline_points_mils=[(900, 400), (1100, 400), (1100, 600), (900, 600)],
                       is_board_cutout=True)
        pcb.add_extruded_3d_body(outline_points_mils=[(100, 100), (300, 100), (300, 300), (100, 300)],
                                 overall_height_mils=100, standoff_height_mils=20, body_color_3d=0x0000FF)
        pcb.add_extruded_3d_body(outline_points_mils=[(500, 100), (700, 100), (700, 300), (500, 300)],
                                 overall_height_mils=200, standoff_height_mils=30, side=PcbBodyProjection.BOTTOM)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'geometry.PcbDoc'
            pcb.save(path)
            original = path.read_bytes()
            scene = render_file(path)['scene3d']
            self.assertEqual(path.read_bytes(), original)
        self.assertEqual(scene['units'], 'mm')
        self.assertAlmostEqual(area(scene), (2000 * 1000 - 200 * 200) * MIL_MM ** 2, places=4)
        self.assertEqual(len(scene['bodies']), 2, 'standard and shape-based copies must not both render')
        top, bottom = scene['bodies']
        self.assertAlmostEqual(top['height'], 80 * MIL_MM)
        self.assertAlmostEqual(top['z'], scene['thickness'] / 2 + 20 * MIL_MM)
        self.assertEqual(top['color'], 0xFF0000, 'native Win32 BGR must become RGB')
        self.assertAlmostEqual(bottom['z'], -scene['thickness'] / 2 - 200 * MIL_MM)
        self.assertAlmostEqual(bottom['z'] + bottom['height'], -scene['thickness'] / 2 - 30 * MIL_MM)

    def test_drills_are_merged_clipped_and_respect_slot_rotation(self):
        pcb = board()
        pcb.add_pad(designator='1', position_mils=(1000, 500), width_mils=200, height_mils=200,
                    hole_size_mils=100, slot_length_mils=400, slot_rotation_degrees=90)
        # A duplicate drill must not create a second nested hole.
        pcb.add_pad(designator='2', position_mils=(1000, 500), width_mils=200, height_mils=200,
                    hole_size_mils=100, slot_length_mils=400, slot_rotation_degrees=90)
        # A drill centred on the edge becomes a notch; outside geometry is ignored.
        pcb.add_pad(designator='3', position_mils=(0, 500), width_mils=200, height_mils=200, hole_size_mils=100)
        pcb.add_pad(designator='4', position_mils=(3000, 500), width_mils=200, height_mils=200, hole_size_mils=100)
        scene = build_scene(pcb)
        self.assertEqual(len(scene['board']), 1)
        part = scene['board'][0]
        self.assertEqual(len(part['holes']), 1)
        slot = Polygon(part['holes'][0])
        x0, y0, x1, y1 = slot.bounds
        self.assertAlmostEqual(x1 - x0, 100 * MIL_MM)
        self.assertAlmostEqual(y1 - y0, 400 * MIL_MM)
        profile = Polygon(part['outline'], part['holes'])
        self.assertFalse(profile.covers(Point(-1000 * MIL_MM, 0)))
        self.assertFalse(profile.covers(Point(0, 0)))
        self.assertTrue(profile.is_valid)

    def test_only_open_through_vias_cut_through_the_board(self):
        pcb = board()
        pcb.add_via(position_mils=(200, 200), diameter_mils=80, hole_size_mils=40)
        pcb.add_via(position_mils=(400, 200), diameter_mils=80, hole_size_mils=40,
                    ipc4761_via_type=PcbIpc4761ViaType.TYPE_5_FILLING)
        pcb.add_via(position_mils=(600, 200), diameter_mils=80, hole_size_mils=40, layer_end=2)
        scene = build_scene(pcb)
        self.assertEqual(len(scene['board'][0]['holes']), 1)
        self.assertIn('Blind and buried', ' '.join(scene['notes']))

    def test_curved_outline_sampling_uses_arc_direction(self):
        vertices = [BoardOutlineVertex.arc(100, 0, center_mils=(0, 0), radius_mils=100,
                                          start_angle_degrees=0, end_angle_degrees=180),
                    BoardOutlineVertex.line(-100, 0), BoardOutlineVertex.line(0, -100)]
        points = contour(vertices)
        self.assertGreater(len(points), 30)
        self.assertAlmostEqual(max(y for x, y in points), 100 * MIL_MM)
        self.assertAlmostEqual(min(y for x, y in points), -100 * MIL_MM)

    def test_missing_outline_and_unknown_thickness_are_explicit(self):
        self.assertEqual(build_scene(AltiumPcbDoc())['board'], [])
        with patch('pcbvisualizer.scene3d.resolved_layer_stack_from_pcbdoc',
                   return_value=SimpleNamespace(substacks=[])):
            scene = build_scene(board())
        self.assertEqual(scene['thickness'], 1.6)
        self.assertIn('1.6 mm', ' '.join(scene['notes']))

    def test_components_without_bodies_and_shapebased_fallback(self):
        pcb = board()
        pcb.add_component(designator='R1', footprint='TEST', position_mils=(100, 100))
        pcb.add_component(designator='R2', footprint='TEST', position_mils=(500, 100))
        body = pcb.add_extruded_3d_body(outline_points_mils=[(100, 100), (300, 100), (300, 300), (100, 300)],
                                      overall_height_mils=100)
        body.component_index = 0
        # Simulate an input with only the shape-based stream available.
        pcb.shapebased_component_bodies = [body]
        pcb.component_bodies = []
        scene = build_scene(pcb)
        self.assertEqual(scene['bodies'][0]['name'], 'R1')
        self.assertIn('1 component(s)', ' '.join(scene['notes']))

    def test_unsupported_3d_geometry_preserves_2d_rendering(self):
        pcb = board()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'unsupported.PcbDoc'
            pcb.save(path)
            with patch('pcbvisualizer.rendering.build_scene', side_effect=ValueError('unsupported body')):
                data = render_file(path)
        self.assertIn('<svg', data['svg'])
        self.assertEqual(data['scene3d']['board'], [])
        self.assertIn('unsupported body', data['scene3d']['notes'][0])

    def test_body_identity_groups_split_solids_and_distinguishes_duplicate_names(self):
        pcb = board()
        pcb.add_extruded_3d_body(outline_points_mils=[(100, 100), (300, 300), (100, 300), (300, 100)],
                                 overall_height_mils=100, name='Body')
        pcb.add_extruded_3d_body(outline_points_mils=[(500, 100), (700, 100), (700, 300), (500, 300)],
                                 overall_height_mils=100, name='Body')
        scene = build_scene(pcb)
        self.assertEqual(len(scene['bodies']), 3)
        self.assertEqual([body['id'] for body in scene['bodies']], ['body-0', 'body-0', 'body-1'])
        self.assertEqual({body['name'] for body in scene['bodies']}, {'Body'})
        self.assertEqual(build_scene(pcb)['bodies'], scene['bodies'])
