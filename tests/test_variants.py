"""Project variant metadata and local project expansion use real Altium files."""

import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from altium_monkey import (
    AltiumPcbDoc, AltiumSchComponent, AltiumSchDesignator, AltiumSchDoc,
    SchRectMils, make_sch_rectangle,
)

from ecadview.cli import load_initial_documents
from ecadview.rendering import render_file
from ecadview.variants import project_metadata, resolve_document


FIXTURE = Path(__file__).parent / "fixtures/altium/variants.PrjPcb"


def save_documents(folder):
    schematic = AltiumSchDoc()
    component = AltiumSchComponent()
    component.unique_id = "RESISTOR"
    schematic.add_object(component)
    designator = AltiumSchDesignator()
    designator.text = "R1"
    schematic.add_object(designator, owner=component)
    schematic.add_object(make_sch_rectangle(bounds_mils=SchRectMils(100, 100, 200, 200)), owner=component)
    sheet = folder / "Schematics/Main.SchDoc"
    sheet.parent.mkdir()
    schematic.save(sheet)
    pcb = AltiumPcbDoc()
    pcb.add_component(designator="R99", footprint="R0603", position_mils=(100, 100))
    pcb.components[0].raw_record.update(SOURCEDESIGNATOR="R1", SOURCEUNIQUEID="CHANNELA\\RESISTOR", SOURCEHIERARCHICALPATH="Main")
    designator_text = pcb.add_text(text="R99", position_mils=(100, 200), height_mils=30, is_designator=True)
    designator_text.component_index = 0
    pad = pcb.add_pad(designator="1", position_mils=(100, 100), width_mils=40, height_mils=40)
    pad.component_index = 0
    layout = folder / "Board.PcbDoc"
    pcb.save(layout)
    return sheet, layout


class ProjectMetadataTests(unittest.TestCase):
    def test_real_project_lists_documents_dnp_alternate_and_parameter_only_changes(self):
        original = FIXTURE.read_bytes()
        data = render_file(FIXTURE)
        self.assertEqual(data["kind"], "project")
        self.assertEqual(data["documents"], ["Schematics/Main.SchDoc", "Board.PcbDoc"])
        self.assertEqual(data["current_variant"], "Economy")
        economy, premium = data["variants"]
        self.assertEqual(economy["parameters"], {"Assembly": "Economy"})
        resistor, alternate, capacitor = economy["components"]
        self.assertEqual(resistor, {"designator": "R1", "unique_id": "CHANNELA\\RESISTOR", "kind": "not_fitted",
                                    "parameters": {"Comment": "10k"}, "alternate_part": ""})
        self.assertEqual(alternate["kind"], "alternate")
        self.assertEqual(alternate["alternate_part"], "LM358B")
        self.assertEqual(alternate["parameters"], {"Comment": "LM358B"})
        self.assertEqual(capacitor["kind"], "fitted")
        self.assertEqual(capacitor["parameters"], {"Manufacturer": ""})
        self.assertEqual(premium["components"][0]["parameters"], {"Comment": "1%"})
        self.assertEqual(FIXTURE.read_bytes(), original)

    def test_metadata_never_opens_referenced_documents(self):
        with patch("ecadview.variants.resolve_document", side_effect=AssertionError("must not follow file references")):
            data = project_metadata(FIXTURE)
        self.assertEqual(len(data["variants"]), 2)
        self.assertEqual(data["warnings"], [])

    def test_mixed_case_fields_merge_parameters_without_changing_fitted_state(self):
        text = """[Design]
CurrentVariant=ECONOMY
[ProjectVariant1]
Description=Economy
VariationCount=2
Variation1=designator=r1|uniqueid=Channel\\RESISTOR|kind=0|alternatepart=
Variation2=Designator=R1|UniqueId=CHANNEL\\resistor|Kind=1|AlternatePart=
ParameterCount=2
Parameter1=name=Assembly|value=first
Parameter2=NAME=assembly|VALUE=
ParamVariationCount=2
ParamVariation1=parametername=Comment|variantvalue=10k
ParamDesignator1=r1
ParamVariation2=ParameterName=comment|VariantValue=
ParamDesignator2=R1
"""
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "case.PrjPcb"
            project.write_text(text)
            data = project_metadata(project)
        self.assertEqual(data["current_variant"], "Economy")
        variant, = data["variants"]
        self.assertEqual(variant["parameters"], {"Assembly": ""})
        component, = variant["components"]
        self.assertEqual(component["kind"], "not_fitted")
        self.assertEqual(component["parameters"], {"Comment": ""})

    def test_no_variants_and_stale_current_variant_use_base_design(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "empty.PrjPcb"
            project.write_text("[Design]\nCurrentVariant=Deleted\n")
            data = project_metadata(project)
        self.assertEqual(data["variants"], [])
        self.assertIsNone(data["current_variant"])


class ProjectLaunchTests(unittest.TestCase):
    def test_cli_expands_project_and_deduplicates_explicit_document_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            sheet, layout = save_documents(folder)
            project = folder / FIXTURE.name
            project.write_bytes(FIXTURE.read_bytes())
            original = {path: path.read_bytes() for path in (project, sheet, layout)}
            data = load_initial_documents([layout, project, sheet])
            self.assertEqual([row["kind"] for row in data], ["project", "pcb", "schematic"])
            self.assertEqual(len(data), 3)
            for row in data[1:]:
                self.assertEqual(row["project_name"], FIXTURE.name)
                self.assertEqual(row["project_key"], data[0]["project_key"])
                self.assertEqual(base64.b64decode(row["source"]), original[folder / row["project_path"]])
            component, = data[1]["layout_components"]
            self.assertEqual(component["name"], "R99")
            self.assertEqual(component["source_name"], "R1")
            self.assertEqual(component["source_id"], "RESISTOR")
            self.assertEqual(component["source_path"], "CHANNELA\\RESISTOR")
            self.assertEqual(component["source_sheet"], "Main")
            for path, contents in original.items():
                self.assertEqual(path.read_bytes(), contents)

    def test_cli_projects_with_identical_names_have_distinct_memberships(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for name in ("one", "two"):
                folder = Path(tmp) / name
                folder.mkdir()
                save_documents(folder)
                project = folder / FIXTURE.name
                project.write_bytes(FIXTURE.read_bytes())
                paths.append(project)
            data = load_initial_documents(paths)
            reopened = load_initial_documents([paths[1]])
        first, second = data[:2]
        self.assertNotEqual(first["project_key"], second["project_key"])
        self.assertNotEqual(first["project_label"], second["project_label"])
        self.assertEqual(first["name"], second["name"])
        self.assertEqual(reopened[0]["project_key"], second["project_key"], 'project identity is stable across separate opens')
        self.assertEqual([row["project_key"] for row in data[2:]],
                         [first["project_key"], first["project_key"], second["project_key"], second["project_key"]])

    def test_cli_keeps_project_metadata_and_reports_missing_documents(self):
        data = load_initial_documents([FIXTURE])
        project, = data
        self.assertEqual(project["kind"], "project")
        self.assertEqual(len(project["warnings"]), 2)
        self.assertIn("Schematics/Main.SchDoc", project["warnings"][0])
        self.assertIn("Board.PcbDoc", project["warnings"][1])

    def test_resolves_case_and_backslashes_without_ambiguous_filename_guessing(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "Schematics").mkdir()
            sheet = folder / "Schematics/Main.SchDoc"
            sheet.write_bytes(b"test")
            self.assertTrue(resolve_document(folder / "board.PrjPcb", "schematics\\MAIN.SCHDOC").samefile(sheet))
            with self.assertRaises(ValueError):
                resolve_document(folder / "board.PrjPcb", "C:\\Other\\Main.SchDoc")
            with self.assertRaises(ValueError):
                resolve_document(folder / "board.PrjPcb", "https://example.com/Main.SchDoc")


if __name__ == "__main__":
    unittest.main()
