"""KiCad geometry, connectivity, safe SVG, and source-preservation coverage."""

import hashlib
import math
from pathlib import Path
import re
import tempfile
import unittest
import xml.etree.ElementTree as ET

import sexpdata
from shapely.geometry import Polygon

from pcbvisualizer.kicad_common import form, forms, load
from pcbvisualizer.kicad_schematic import Connectivity
from pcbvisualizer.rendering import render_file

FIXTURES = Path(__file__).parent / 'fixtures' / 'kicad'
NS = {'s': 'http://www.w3.org/2000/svg'}


def changed_document(extension, change):
    root = load(FIXTURES / f'demo.{extension}', extension)
    change(root)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f'changed.{extension}'
        path.write_text(sexpdata.dumps(root))
        return render_file(path)


def polygon_area(scene):
    return sum(Polygon(part['outline'], part['holes']).area for part in scene['board'])


class KiCadBoardTests(unittest.TestCase):
    def test_real_format_fixture_renders_all_views_and_preserves_source_bytes(self):
        path = FIXTURES / 'demo.kicad_pcb'
        original = hashlib.sha256(path.read_bytes()).digest()
        for side in ('all', 'top', 'bottom'):
            with self.subTest(side=side):
                data = render_file(path, side=side, clip=True)
                root = ET.fromstring(data['svg'])
                self.assertEqual(data['kind'], 'pcb')
                self.assertEqual(data['stats'], dict(components=2, pads=4, tracks=2, vias=1, polygons=1, regions=1))
                self.assertTrue(root.findall('.//s:clipPath', NS))
                if side != 'bottom':
                    self.assertIn('KiCad <&> demo', ''.join(root.itertext()))
                groups = root.findall('s:g/s:g', NS)
                names = {group.get('data-layer-token') for group in groups}
                self.assertIn('TOP' if side != 'bottom' else 'BOTTOM', names)
                if side != 'all':
                    self.assertNotIn('BOTTOM' if side == 'top' else 'TOP', names)
                self.assertEqual(root.find('s:g', NS).get('transform') is not None, side == 'bottom')
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)

    def test_pad_rotation_holes_net_pin_names_and_unconnected_pads(self):
        data = render_file(FIXTURES / 'demo.kicad_pcb')
        root = ET.fromstring(data['svg'])
        pads = [el for el in root.iter() if el.get('data-primitive') == 'pad']
        pad = next(el for el in pads if el.get('data-component') == 'R1' and el.get('data-pad-number') == '1')
        coords = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', pad.get('d'))]
        self.assertAlmostEqual(min(coords[0::2]), 9)
        self.assertAlmostEqual(max(coords[0::2]), 11)
        self.assertAlmostEqual(min(coords[1::2]), 11)
        self.assertAlmostEqual(max(coords[1::2]), 13)
        self.assertEqual(pad.get('data-net'), 'GND')
        unconnected = next(el for el in pads if el.get('data-pad-number') == 'A2')
        self.assertEqual(unconnected.get('data-component'), 'R2')
        self.assertIsNone(unconnected.get('data-net'))
        self.assertEqual(pad.get('fill-rule'), 'evenodd')
        self.assertEqual(data['layout_components'][0], {'name': 'R1', 'source_name': 'R1',
                          'source_id': '00000000-0000-0000-0000-000000000101'})

    def test_board_3d_contains_cutout_and_drilled_slots_in_mm(self):
        scene = render_file(FIXTURES / 'demo.kicad_pcb')['scene3d']
        self.assertEqual(scene['units'], 'mm')
        self.assertEqual(scene['thickness'], 1.6)
        self.assertEqual(len(scene['board']), 1)
        self.assertEqual(len(scene['board'][0]['holes']), 4)
        circle = lambda radius, n: n * radius * radius * math.sin(math.tau / n) / 2
        expected = 40*30 - circle(2, 96) - circle(0.4, 64)*2 - 0.8*0.8 - circle(0.35, 64)
        self.assertAlmostEqual(polygon_area(scene), expected, places=4)
        self.assertEqual(scene['bodies'], [])
        self.assertIn('external STEP/VRML', ' '.join(scene['notes']))

    def test_polygon_metadata_identifies_only_saved_pours(self):
        data = render_file(FIXTURES / 'demo.kicad_pcb', polygon_outlines=True)
        elements = {node.get('id'): node for node in ET.fromstring(data['svg']).iter() if node.get('id')}
        self.assertEqual(len(data['polygon_elements']), 2)
        self.assertEqual({elements[key].get('data-primitive') for key in data['polygon_elements']}, {'region', 'polygon-outline'})
        self.assertTrue(all(elements[key].get('data-net') == 'GND' for key in data['polygon_elements']))

    def test_zone_without_saved_fill_is_reported_and_keeps_its_outline(self):
        def change(root):
            zone = form(root, 'zone')
            zone[:] = [item for item in zone if not isinstance(item, list) or str(item[0]) != 'filled_polygon']
        data = changed_document('kicad_pcb', change)
        self.assertEqual(data['stats']['regions'], 0)
        self.assertEqual(len(data['polygon_elements']), 1)
        self.assertIn('Refill and save', ' '.join(data['warnings']))

    def test_open_outline_disables_3d_without_losing_2d(self):
        def change(root):
            rectangle = form(root, 'gr_rect'); rectangle[0] = sexpdata.Symbol('gr_line')
        data = changed_document('kicad_pcb', change)
        self.assertEqual(data['scene3d']['board'], [])
        self.assertIn('closed board outlines', ' '.join(data['scene3d']['notes']))
        self.assertIn('<svg', data['svg'])

    def test_outline_welds_tiny_converted_gaps_but_rejects_open_edges(self):
        for gap in (0.001, 0.02):
            with self.subTest(gap=gap):
                def change(root):
                    root.remove(form(root, 'gr_rect'))
                    for a, b in [((gap, 0), (40, 0)), ((40, 0), (40, 30)),
                                 ((40, 30), (0, 30)), ((0, 30), (0, 0))]:
                        root.append(sexpdata.loads(f'(gr_line (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (layer "Edge.Cuts"))'))
                data = changed_document('kicad_pcb', change)
                self.assertEqual(bool(data['scene3d']['board']), gap < 0.002)

    def test_modern_reference_properties_identify_footprint_pads(self):
        def change(root):
            footprint = form(root, 'footprint')
            reference = form(footprint, 'fp_text')
            reference[:] = sexpdata.loads('(property "Reference" "R99" (at 0 -2 90) (layer "F.SilkS"))')
        data = changed_document('kicad_pcb', change)
        self.assertEqual(data['layout_components'][0]['name'], 'R99')
        self.assertIn('data-component="R99"', data['svg'])

    def test_apertures_do_not_participate_in_electrical_pad_searches(self):
        root = ET.fromstring(render_file(FIXTURES / 'demo.kicad_pcb')['svg'])
        for group in root.findall('s:g/s:g', NS):
            if group.get('data-layer-role') in ('mask', 'paste'):
                for shape in group:
                    self.assertIsNone(shape.get('data-net'))
                    self.assertIsNone(shape.get('data-component'))

    def test_non_plated_holes_remove_board_material_without_copper(self):
        def change(root):
            form(root, 'footprint').append(sexpdata.loads('(pad "NP" np_thru_hole circle (at 5 5) (size 3 3) (drill 2) (layers "*.Cu" "*.Mask"))'))
        data = changed_document('kicad_pcb', change)
        self.assertNotIn('data-pad-number="NP"', data['svg'])
        self.assertEqual(len(data['scene3d']['board'][0]['holes']), 5)


class KiCadSchematicTests(unittest.TestCase):
    def test_embedded_symbols_selection_terminals_and_source_bytes(self):
        path = FIXTURES / 'demo.kicad_sch'; original = path.read_bytes()
        data = render_file(path)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(data['stats'], {'components': 2, 'wires': 2, 'net_labels': 2})
        self.assertEqual(data['kind'], 'schematic')
        self.assertEqual([row['name'] for row in data['selection']['components']], ['R1', 'R2'])
        nets = {net['name']: net for net in data['selection']['nets']}
        self.assertEqual(nets['GND']['terminals'], [{'component': 'R1', 'pin': '1'}])
        self.assertEqual(nets['SIGNAL']['terminals'], [{'component': 'R1', 'pin': '2'}, {'component': 'R2', 'pin': '1'}])
        self.assertIn('Net-(R2-Pad2)', nets)
        ids = {el.get('id') for el in ET.fromstring(data['svg']).iter()}
        for net in nets.values():
            self.assertTrue(set(net['elements']).issubset(ids))

    def test_mirroring_is_applied_after_symbol_rotation(self):
        def change(root):
            symbol = forms(root, 'symbol')[0]
            form(symbol, 'at')[3] = 270
            symbol.append([sexpdata.Symbol('mirror'), sexpdata.Symbol('x')])
        data = changed_document('kicad_sch', change)
        pin_id = next(net for net in data['selection']['nets'] if {'component': 'R1', 'pin': '1'} in net['terminals'])['elements'][0]
        # Locate the pin independently of generated element ordering.
        elements = {el.get('id'): el for el in ET.fromstring(data['svg']).iter() if el.get('id')}
        pin = elements[pin_id]
        self.assertEqual(pin.find('s:path', NS).get('d'), 'M50 55 L50 52')

    def test_bare_crossings_stay_separate_but_explicit_junctions_connect(self):
        for junction in (False, True):
            with self.subTest(junction=junction):
                graph = Connectivity()
                graph.wire([(0, 5), (10, 5)], 'horizontal')
                graph.wire([(5, 0), (5, 10)], 'vertical')
                if junction:
                    graph.add((5, 5), 'junction')
                self.assertEqual(len(graph.nets()), 1 if junction else 2)

    def test_wire_endpoints_pin_anchors_and_equal_labels_merge_nets(self):
        graph = Connectivity()
        graph.wire([(0, 0), (10, 0)], 'first')
        graph.wire([(5, 0), (5, 5)], 'branch')
        graph.wire([(50, 0), (60, 0)], 'remote')
        graph.add((0, 0), 'label-a', 'GND')
        graph.add((60, 0), 'label-b', 'GND')
        graph.add((5, 5), 'pin', terminal=('R1', '1'))
        nets = graph.nets()
        self.assertEqual(len(nets), 1)
        self.assertEqual(nets[0]['name'], 'GND')
        self.assertEqual(nets[0]['terminals'], [{'component': 'R1', 'pin': '1'}])
        self.assertTrue({'first', 'branch', 'remote', 'pin'}.issubset(nets[0]['elements']))

    def test_hierarchical_sheets_are_reported_without_reading_external_files(self):
        def change(root):
            root.append(sexpdata.loads('(sheet (at 10 10) (size 20 10) (property "Sheet file" "../private.kicad_sch" (at 10 21)))'))
        data = changed_document('kicad_sch', change)
        self.assertIn('Open child .kicad_sch sheets individually', ' '.join(data['warnings']))

    def test_sheet_pin_names_do_not_merge_unconnected_parent_nets(self):
        def change(root):
            for x in (10, 20):
                root.append(sexpdata.loads(f'(sheet (at {x} 10) (size 5 5) (pin "IN" input (at {x} 12 0)))'))
        data = changed_document('kicad_sch', change)
        elements = {el.get('id') for el in ET.fromstring(data['svg']).iter() if el.get('id', '').startswith('kc-sheet-pin-')}
        nets = [net for net in data['selection']['nets'] if elements.intersection(net['elements'])]
        self.assertEqual(len(nets), 2)

    def test_power_symbols_merge_remote_pins_and_hidden_pins_keep_connectivity(self):
        def change(root):
            library = forms(form(root, 'lib_symbols'), 'symbol')[0]
            library.append([sexpdata.Symbol('power')])
            for part in forms(library, 'symbol'):
                for pin in forms(part, 'pin'):
                    pin[1] = sexpdata.Symbol('power_in')
                    pin.append(sexpdata.Symbol('hide'))
            for symbol in forms(root, 'symbol'):
                next(prop for prop in forms(symbol, 'property') if prop[1] == 'Value')[2] = 'VCC'
            root[:] = [item for item in root if not isinstance(item, list) or str(item[0]) not in ('label', 'global_label', 'wire')]
        data = changed_document('kicad_sch', change)
        self.assertEqual(len(data['selection']['nets']), 1)
        self.assertEqual(data['selection']['nets'][0]['name'], 'VCC')
        self.assertEqual(len(data['selection']['nets'][0]['terminals']), 4)


class KiCadInputTests(unittest.TestCase):
    def test_legacy_board_atoms_keep_lisp_punctuation_literal(self):
        source = (FIXTURES / 'demo.kicad_pcb').read_text().replace('(footprint ', '(module ')
        for name in ('K_[1', 'K_]1', "K_'1", "'quoted", 'R;1', r'R\1'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'old.kicad_pcb'
                path.write_text(source.replace('reference "R1"', f'reference {name}'))
                data = render_file(path)
                self.assertEqual(data['layout_components'][0]['name'], name)
                self.assertEqual(data['stats']['components'], 2)
                self.assertTrue(data['scene3d']['board'])

    def test_atom_normalization_preserves_quoted_strings_and_parentheses(self):
        source = r'''(kicad_pcb (net 1 "Net-(K_[1-Pad4)") (gr_text "quoted \"[;']\" \\ path"))'''
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'quoted.kicad_pcb'; path.write_text(source)
            root = load(path, 'kicad_pcb')
            self.assertEqual(form(root, 'net')[2], 'Net-(K_[1-Pad4)')
            self.assertEqual(form(root, 'gr_text')[1], 'quoted "[;\']" \\ path')

    def test_comment_lines_are_not_mistaken_for_legacy_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'comments.kicad_pcb'
            path.write_text('(kicad_pcb\n # comment [\n ;; comment ]\n (net 1 "#literal;name"))')
            self.assertEqual(form(load(path, 'kicad_pcb'), 'net')[2], '#literal;name')

    def test_malformed_content_and_wrong_document_type_are_clear_errors(self):
        for content, message in [('(kicad_pcb (version 1)', 'Invalid KiCad'), ('(kicad_sch)', 'Expected a KiCad kicad_pcb')]:
            with self.subTest(content=content), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'broken.kicad_pcb'; path.write_text(content)
                with self.assertRaisesRegex(ValueError, message):
                    render_file(path)

    def test_text_is_escaped_and_never_becomes_svg_markup(self):
        def change(root):
            form(root, 'gr_text')[1] = '<script>alert("bad")</script> & text'
        data = changed_document('kicad_pcb', change)
        root = ET.fromstring(data['svg'])
        self.assertFalse(root.findall('.//s:script', NS))
        self.assertIn('<script>alert("bad")</script> & text', ''.join(root.itertext()))

    def test_extensions_are_case_insensitive_and_bom_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            for extension in ('kicad_pcb', 'kicad_sch'):
                path = Path(tmp) / ('board.' + extension.upper())
                path.write_bytes(b'\xef\xbb\xbf' + (FIXTURES / f'demo.{extension}').read_bytes())
                self.assertIn('<svg', render_file(path)['svg'])


class LegacyKiCadSchematicTests(unittest.TestCase):
    def test_fields_wires_labels_and_component_positions_without_library_guesses(self):
        path = FIXTURES / 'legacy.sch'
        original = path.read_bytes()
        data = render_file(path)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(data['kind'], 'schematic')
        self.assertEqual(data['stats'], {'components': 2, 'wires': 3, 'net_labels': 2})
        self.assertIn('symbol graphics and pin connectivity are unavailable', data['warnings'][0])
        self.assertIn('Open child .sch sheets individually', ' '.join(data['warnings']))
        self.assertIn('bus-member connectivity is not expanded', ' '.join(data['warnings']))
        root = ET.fromstring(data['svg'])
        placeholders = root.findall('.//s:g[@data-symbol-preview="placeholder"]', NS)
        self.assertEqual(len(placeholders), 2)
        text = ''.join(root.itertext())
        self.assertIn('R1', text)
        self.assertIn('1k', text)
        self.assertNotIn('Hidden footprint', text)
        self.assertIn('Legacy <&> notesecond line', text)
        self.assertTrue(root.findall('.//s:text[@transform="rotate(-90 81.28 50.8)"]', NS))
        self.assertEqual(data['selection']['components'][0]['id'], '5AAB499C')
        # Standard power anchors and equal labels join wires, but unknown symbol
        # pins are never synthesized into the cross-probing terminal map.
        net = next(net for net in data['selection']['nets'] if net['name'] == 'GND')
        self.assertEqual(net['aliases'], ['RETURN'])
        self.assertEqual(net['terminals'], [])

    def test_legacy_units_are_mils_converted_to_mm(self):
        data = render_file(FIXTURES / 'legacy.sch')
        root = ET.fromstring(data['svg'])
        wire = root.find('.//s:g[@id="kc-wire-5"]/s:path', NS)
        self.assertEqual(wire.get('d'), 'M25.4 50.8 L50.8 50.8')

    def test_other_sch_formats_and_truncated_legacy_sheets_are_clear_errors(self):
        source = (FIXTURES / 'legacy.sch').read_text()
        for content, error in [('not a KiCad sheet', 'Expected a KiCad legacy'),
                               (source.replace('$EndSCHEMATC', ''), 'missing \\$EndSCHEMATC'),
                               (source.replace('$EndComp', '', 1), 'expected \\$EndComp')]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'bad.sch'; path.write_text(content)
                with self.assertRaisesRegex(ValueError, error):
                    render_file(path)

    def test_legacy_uppercase_and_bom_are_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'legacy.SCH'
            path.write_bytes(b'\xef\xbb\xbf' + (FIXTURES / 'legacy.sch').read_bytes())
            self.assertEqual(render_file(path)['stats']['components'], 2)
