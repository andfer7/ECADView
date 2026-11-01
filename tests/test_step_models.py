"""Real embedded STEP assets, placements, deduplication and external references."""

import base64
from pathlib import Path
import tempfile
import unittest
import zlib

import numpy as np
from altium_monkey import AltiumPcbDoc
from altium_monkey.altium_board import AltiumBoardOutline
from altium_monkey.altium_pcb_enums import PcbBodyProjection

from ecadview.rendering import render_file
from ecadview.scene3d import build_scene, MIL_MM
from ecadview.step_models import asset, local_step, MAX_MODEL_BYTES

BOX = Path(__file__).parent / "fixtures/step/box.step"


class StepModelsTests(unittest.TestCase):
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
