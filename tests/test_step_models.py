"""Real embedded STEP assets, placements, deduplication and external references."""

import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zlib

import numpy as np
import sexpdata
import zstandard
from altium_monkey import AltiumPcbDoc
from altium_monkey.altium_board import AltiumBoardOutline
from altium_monkey.altium_pcb_enums import PcbBodyProjection

from ecadview.rendering import render_file
from ecadview.scene3d import build_scene, MIL_MM
from ecadview.kicad_common import load, form, forms
from ecadview.step_models import asset, kicad_models, local_step, MAX_MODEL_BYTES

BOX = Path(__file__).parent / "fixtures/step/box.step"
EMBEDDED = Path(__file__).parent / "fixtures/kicad/embedded-step.kicad_pcb"


def embedded_record(name, data, **compression):
    encoded = base64.b64encode(zstandard.ZstdCompressor(**compression).compress(data)).decode()
    return sexpdata.loads(f'(file (name "{name}") (type model) (data |{encoded}|))')


class StepModelsTests(unittest.TestCase):
    def test_kicad_embedded_fixture_resolves_uri_and_filename_and_preserves_source(self):
        before = EMBEDDED.read_bytes()
        scene = render_file(EMBEDDED)["scene3d"]
        self.assertEqual(EMBEDDED.read_bytes(), before)
        self.assertEqual(len(scene["bodies"]), 2)
        self.assertEqual(len(scene["step_models"]), 1)
        key, entry = next(iter(scene["step_models"].items()))
        self.assertTrue(entry["compressed"])
        self.assertEqual(zlib.decompress(base64.b64decode(entry["data"])), BOX.read_bytes())
        self.assertTrue(all(body["model"] == key for body in scene["bodies"]))
        top, bottom = [np.array(body["matrix"]).reshape(4, 4, order="F") for body in scene["bodies"]]
        np.testing.assert_allclose(top @ [1, 2, 3, 1], [-11, -2, 3.8, 1])
        np.testing.assert_allclose(bottom @ [1, 2, 3, 1], [13, 4, -3.8, 1])

    def test_kicad_external_files_take_precedence_over_filename_fallback(self):
        root = load(EMBEDDED, 'kicad_pcb')
        form(forms(root, 'footprint')[1], 'model')[1] = 'box.step'
        with tempfile.TemporaryDirectory() as tmp:
            external = BOX.read_bytes().replace(b'ECADView test fixture', b'External test fixture')
            Path(tmp, 'box.step').write_bytes(external)
            assets, bodies, missing = kicad_models(root, tmp, (0, 0), 1.6)
        self.assertEqual(missing, 0)
        self.assertNotEqual(bodies[0]['model'], bodies[1]['model'])
        entry = assets[bodies[1]['model']]
        self.assertEqual(base64.b64decode(entry['data']), external)

    def test_kicad_embedded_footprint_scope_shadows_board_files(self):
        root = load(EMBEDDED, 'kicad_pcb')
        footprint = forms(root, 'footprint')[1]
        form(footprint, 'model')[1] = 'kicad-embed://box.step'
        own = BOX.read_bytes().replace(b'ECADView test fixture', b'Footprint test fixture')
        footprint.append([sexpdata.Symbol('embedded_files'), embedded_record('box.step', own)])
        assets, bodies, missing = kicad_models(root, None, (0, 0), 1.6)
        self.assertEqual(missing, 0)
        self.assertNotEqual(bodies[0]['model'], bodies[1]['model'])
        self.assertEqual(zlib.decompress(base64.b64decode(assets[bodies[1]['model']]['data'])), own)

    def test_kicad_embedded_fallback_is_unambiguous_and_explicit_uris_are_exact(self):
        root = load(EMBEDDED, 'kicad_pcb')
        files = form(root, 'embedded_files')
        form(files[1], 'name')[1] = 'one/box.step'
        files.append(embedded_record('two/box.step', BOX.read_bytes()))
        form(forms(root, 'footprint')[0], 'model')[1] = 'kicad-embed://one/box.step'
        assets, bodies, missing = kicad_models(root, None, (0, 0), 1.6)
        self.assertEqual(missing, 1)
        self.assertIn('data', assets[bodies[0]['model']])
        self.assertNotIn('data', assets[bodies[1]['model']])
        form(forms(root, 'footprint')[0], 'model')[1] = 'kicad-embed://missing/box.step'
        _, _, missing = kicad_models(root, None, (0, 0), 1.6)
        self.assertEqual(missing, 2)

    def test_kicad_invalid_embedded_files_do_not_drop_valid_models_or_2d(self):
        for payload in ('|%%%|', '|YWJj|', '|' + base64.b64encode(zstandard.ZstdCompressor().compress(b'not STEP')).decode() + '|'):
            with self.subTest(payload=payload):
                root = load(EMBEDDED, 'kicad_pcb')
                files = form(root, 'embedded_files')
                form(files[1], 'data')[:] = [sexpdata.Symbol('data'), sexpdata.Symbol(payload)]
                files.append(embedded_record('valid.step', BOX.read_bytes()))
                form(forms(root, 'footprint')[1], 'model')[1] = 'kicad-embed://valid.step'
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp, 'invalid.kicad_pcb'); path.write_text(sexpdata.dumps(root))
                    data = render_file(path)
                self.assertIn('<svg', data['svg'])
                assets, bodies = data['scene3d']['step_models'], data['scene3d']['bodies']
                self.assertNotIn('data', assets[bodies[0]['model']])
                self.assertIn('data', assets[bodies[1]['model']])

    def test_kicad_embedded_size_limits_cover_known_unknown_and_total_sizes(self):
        root = load(EMBEDDED, 'kicad_pcb')
        with patch('ecadview.step_models.MAX_MODEL_BYTES', len(BOX.read_bytes()) - 1):
            self.assertEqual(kicad_models(root, None, (0, 0), 1.6)[2], 2)
        form(root, 'embedded_files')[1] = embedded_record('box.step', BOX.read_bytes(), write_content_size=False)
        self.assertEqual(kicad_models(root, None, (0, 0), 1.6)[2], 0)
        with patch('ecadview.step_models.MAX_MODEL_BYTES', len(BOX.read_bytes()) - 1):
            self.assertEqual(kicad_models(root, None, (0, 0), 1.6)[2], 2)
        form(root, 'embedded_files').append(embedded_record('other.step', BOX.read_bytes() + b'\n'))
        form(forms(root, 'footprint')[1], 'model')[1] = 'kicad-embed://other.step'
        with patch('ecadview.step_models.MAX_EMBEDDED_BYTES', len(BOX.read_bytes()) + 1):
            assets, bodies, missing = kicad_models(root, None, (0, 0), 1.6)
            self.assertEqual(missing, 1)
            self.assertIn('data', assets[bodies[0]['model']])
            self.assertNotIn('data', assets[bodies[1]['model']])
        form(root, 'embedded_files')[-1] = embedded_record('other.step', BOX.read_bytes())
        with patch('ecadview.step_models.MAX_EMBEDDED_BYTES', len(BOX.read_bytes())):
            assets, bodies, missing = kicad_models(root, None, (0, 0), 1.6)
            self.assertEqual(missing, 0, 'identical files share the decoded-content budget')
            self.assertEqual(len(assets), 1)

    def test_invalid_step_placement_keeps_the_2d_board_available(self):
        source = (Path(__file__).parent / "fixtures/kicad/demo.kicad_pcb").read_text().strip()
        source = source[:-1] + '''(footprint "TEST" (layer "F.Cu") (at 10 10)
          (model "box.step" (rotate (xyz 0 0 nan)))) )'''
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "invalid-model.kicad_pcb"; path.write_text(source)
            data = render_file(path)
            self.assertIn("<svg", data["svg"])
            self.assertIn("STEP placements could not be read", " ".join(data["scene3d"]["notes"]))
            self.assertEqual(path.read_text(), source)

    def test_embedded_step_assets_round_trip_and_reuse_placements_on_both_sides(self):
        pcb = AltiumPcbDoc()
        pcb.set_board_outline(AltiumBoardOutline.from_points_mils([(0, 0), (2000, 0), (2000, 1000), (0, 1000)]))
        for index in range(2):
            # Different Altium IDs may carry the same STEP bytes.
            model = pcb.add_embedded_model(name="box.step", model_data=BOX.read_bytes())
            body = pcb.add_embedded_3d_model(model, location_mils=(500 + index * 1000, 500),
                bounds_mils=(400 + index * 1000, 400, 600 + index * 1000, 600),
                overall_height_mils=100, rotation_z_degrees=90, standoff_height_mils=20,
                side=PcbBodyProjection.BOTTOM if index else PcbBodyProjection.TOP)
            # Saved body placement is authoritative, not Models/Data defaults.
            body.model_3d_rotx = 0
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "models.PcbDoc"; pcb.save(path)
            before = path.read_bytes()
            scene = render_file(path)["scene3d"]
            self.assertEqual(before, path.read_bytes())
        self.assertEqual(len(scene["bodies"]), 2, "Do not duplicate the shape-based body stream")
        self.assertEqual(len(scene["step_models"]), 1, "Repeated STEP payloads share one asset")
        key, = scene["step_models"]
        entry = scene["step_models"][key]
        self.assertEqual(zlib.decompress(base64.b64decode(entry["data"])), BOX.read_bytes())
        self.assertTrue(entry["compressed"])
        top, bottom = [np.array(body["matrix"]).reshape(4, 4, order="F") for body in scene["bodies"]]
        np.testing.assert_allclose(top @ [2, 1, 2, 1], [-500*MIL_MM - 1, 2, scene["thickness"]/2 + 20*MIL_MM + 2, 1])
        np.testing.assert_allclose(bottom @ [2, 1, 2, 1], [500*MIL_MM - 1, -2, -scene["thickness"]/2 - 20*MIL_MM - 2, 1])
        self.assertTrue(all(body["model"] == key for body in scene["bodies"]))

    def test_step_without_usable_extrusion_still_has_an_identity_and_placement(self):
        pcb = AltiumPcbDoc()
        pcb.set_board_outline(AltiumBoardOutline.from_points_mils([(0, 0), (1000, 0), (1000, 1000), (0, 1000)]))
        model = pcb.add_embedded_model(name="BOX.STP", model_data=BOX.read_bytes())
        body = pcb.add_embedded_3d_model(model, bounds_mils=(100, 100, 200, 200), overall_height_mils=0)
        body.outline = []
        scene = build_scene(pcb)
        self.assertEqual(len(scene["bodies"]), 1)
        self.assertNotIn("outline", scene["bodies"][0])
        self.assertIn(scene["bodies"][0]["model"], scene["step_models"])

    def test_local_step_resolves_project_paths_and_rejects_non_step_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "box.step").write_bytes(BOX.read_bytes())
            for reference in ("box.step", "${KIPRJMOD}/box.step"):
                self.assertEqual(local_step(reference, directory), BOX.read_bytes())
            self.assertIsNone(local_step("${UNDEFINED_PCB_STEP_ROOT}/box.step", directory))
            self.assertIsNone(local_step("https://example.com/box.step", directory))
            (directory / "invalid.step").write_text("not a STEP file")
            self.assertIsNone(local_step("invalid.step", directory))
            self.assertIsNone(local_step("missing.stp", directory))
        with self.assertRaises(ValueError):
            asset(b"x" * (MAX_MODEL_BYTES + 1), "large.step")

    def test_kicad_local_step_and_missing_reference_preserve_scale_rotation_and_side(self):
        board = '''(kicad_pcb (version 20240108) (generator ecadview)
          (general (thickness 1.6)) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
          (gr_rect (start 0 0) (end 40 30) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
          (footprint "TEST" (layer "F.Cu") (at 10 10 90) (property "Reference" "U1")
            (model "${KIPRJMOD}/box.step" (offset (xyz 1 2 3)) (scale (xyz 2 1 1)) (rotate (xyz 0 0 90))))
          (footprint "TEST" (layer "B.Cu") (at 30 20 90) (property "Reference" "U2")
            (model "missing.step" (offset (xyz 1 2 3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))
        )'''
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "models.kicad_pcb"; path.write_text(board)
            (path.parent / "box.step").write_bytes(BOX.read_bytes())
            scene = render_file(path)["scene3d"]
            self.assertEqual(path.read_text(), board)
        self.assertEqual(len(scene["bodies"]), 2)
        top, bottom = scene["bodies"]
        self.assertIn("data", scene["step_models"][top["model"]])
        self.assertNotIn("data", scene["step_models"][bottom["model"]])
        a, b = [np.array(body["matrix"]).reshape(4, 4, order="F") for body in (top, bottom)]
        np.testing.assert_allclose(a @ [1, 0, 0, 1], [-10, 6, 3.8, 1], atol=1e-12)
        np.testing.assert_allclose(b @ [0, 0, 1, 1], [12, -4, -4.8, 1], atol=1e-12)
