"""Project chooser isolation, HTTP access control, and referenced-file loading."""

import base64
import hashlib
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import quote

from altium_monkey import AltiumPcbDoc, AltiumSchDoc, SchPointMils, make_sch_wire

from ecadview.project_picker import ProjectPicker, worker
from ecadview.server import Handler, ViewerServer


class ChooserWorkerTests(unittest.TestCase):
    def run_worker(self, *, accepted=True, error=None, name=""):
        dialog = Mock()
        dialog.exec.return_value = int(accepted)
        dialog.exec.side_effect = error
        dialog.selectedFiles.return_value = ["/project with spaces/électron.PrjPcb"]
        dialog_class = Mock(return_value=dialog)
        dialog_class.FileMode.ExistingFile = 1
        dialog_class.AcceptMode.AcceptOpen = 0
        application = Mock()
        application.instance.return_value = None
        widgets = SimpleNamespace(QApplication=application, QFileDialog=dialog_class,
                                  QDialog=SimpleNamespace(DialogCode=SimpleNamespace(Accepted=1)))
        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict(sys.modules, {"PySide6.QtWidgets": widgets}), \
                patch.dict(os.environ, {"QT_QPA_PLATFORM": ""}), patch.object(sys, "platform", "darwin"):
            output = Path(temporary) / "selection.json"
            worker(str(output), name)
            return json.loads(output.read_text()), dialog

    def test_native_selection_and_cancellation_write_results(self):
        result, dialog = self.run_worker()
        self.assertEqual(result, {"path": "/project with spaces/électron.PrjPcb"})
        self.assertIn("*.PrjPcb", dialog.setNameFilter.call_args.args[0])
        self.assertIn("*.prjpcb", dialog.setNameFilter.call_args.args[0])
        dialog.selectFile.assert_not_called()
        cancelled, dialog = self.run_worker(accepted=False)
        self.assertEqual(cancelled, {"path": None})
        dialog.selectedFiles.assert_not_called()

    def test_dropped_project_name_is_preselected_in_the_native_dialog(self):
        _, dialog = self.run_worker(name="électron board.PrjPcb")
        dialog.setWindowTitle.assert_called_once_with("Locate électron board.PrjPcb")
        dialog.selectFile.assert_called_once_with("électron board.PrjPcb")

    def test_dialog_errors_and_missing_display_are_reported(self):
        result, _ = self.run_worker(error=RuntimeError("Native dialog failed"))
        self.assertEqual(result, {"error": "Native dialog failed"})
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"QT_QPA_PLATFORM": "offscreen"}):
            output = Path(temporary) / "selection.json"
            worker(str(output))
            self.assertIn("desktop display is required", json.loads(output.read_text())["error"])


class ChooserProcessTests(unittest.TestCase):
    def test_filename_hint_is_passed_as_an_argument_to_the_worker(self):
        real_popen, launches = subprocess.Popen, []
        name = "électron board.PrjPcb"
        def launch(command, **options):
            launches.append(command)
            return real_popen([sys.executable, "-c",
                               "import json,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(json.dumps({'path':sys.argv[2]}))",
                               *command[-2:]], **options)
        with patch("ecadview.project_picker.subprocess.Popen", side_effect=launch):
            self.assertEqual(ProjectPicker().choose(name=name), Path(name))
        self.assertEqual(launches[0][-1], name)
        self.assertEqual(launches[0][1:4], ["-m", "ecadview.cli", "--project-picker-worker"])
        self.assertFalse(Path(launches[0][-2]).parent.exists())

    def test_selection_cancel_and_error_cross_the_process_boundary(self):
        real_popen = subprocess.Popen
        for payload, expected in (({"path": "/circuit files/électron.PrjPcb"}, Path("/circuit files/électron.PrjPcb")),
                                  ({"path": None}, None), ({"error": "Display unavailable"}, RuntimeError)):
            with self.subTest(payload=payload):
                launches = []
                def launch(command, **options):
                    launches.append(command)
                    return real_popen([sys.executable, "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])",
                                       command[-1], json.dumps(payload)], **options)
                picker = ProjectPicker()
                with patch("ecadview.project_picker.subprocess.Popen", side_effect=launch):
                    if expected is RuntimeError:
                        with self.assertRaisesRegex(RuntimeError, "Display unavailable"):
                            picker.choose()
                    else:
                        self.assertEqual(picker.choose(), expected)
                self.assertEqual(launches[0][1:4], ["-m", "ecadview.cli", "--project-picker-worker"])
                self.assertFalse(Path(launches[0][-1]).parent.exists(), "temporary chooser results are removed")
                picker.close()

    def test_crashed_worker_is_an_error_not_a_cancellation(self):
        real_popen = subprocess.Popen
        def launch(command, **options):
            return real_popen([sys.executable, "-c", "import sys; sys.stderr.write('Qt display failure'); sys.exit(1)"], **options)
        with patch("ecadview.project_picker.subprocess.Popen", side_effect=launch):
            with self.assertRaisesRegex(RuntimeError, "Qt display failure"):
                ProjectPicker().choose()

    def test_close_terminates_and_reaps_an_open_dialog(self):
        real_popen = subprocess.Popen
        started, results, children = threading.Event(), [], []
        picker = ProjectPicker()
        def launch(command, **options):
            child = real_popen([sys.executable, "-c", "import time; time.sleep(60)"], **options)
            children.append(child)
            started.set()
            return child
        def choose():
            try:
                results.append(picker.choose())
            except Exception as error:
                results.append(error)
        with patch("ecadview.project_picker.subprocess.Popen", side_effect=launch):
            thread = threading.Thread(target=choose, daemon=True)
            thread.start()
            try:
                self.assertTrue(started.wait(2))
                picker.close()
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(results, [None])
                self.assertIsNotNone(children[0].returncode)
                self.assertIsNone(picker.choose(), "a stopped picker cannot create another dialog")
            finally:
                picker.close()
                thread.join(timeout=3)


class OpenProjectServerTests(unittest.TestCase):
    def setUp(self):
        self.server = ViewerServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        chooser_patch = patch.object(self.server.project_picker, "choose", return_value=None)
        self.choose = chooser_patch.start()
        self.addCleanup(chooser_patch.stop)
        host = f"127.0.0.1:{self.server.server_address[1]}"
        self.headers = {"Host": host, "Origin": f"http://{host}", "Sec-Fetch-Site": "same-origin",
                        "X-Viewer-Request": "open-project"}

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, *, path="/open-project", headers=None, body=b""):
        connection = HTTPConnection(*self.server.server_address, timeout=15)
        try:
            connection.request("POST", path, body=body, headers=self.headers if headers is None else headers)
            response = connection.getresponse()
            self.assertEqual(response.getheader("Content-Type"), "application/json")
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_only_the_viewer_can_launch_the_native_chooser(self):
        invalid = ({"Origin": "https://example.com"}, {"Origin": "null"}, {"Host": "example.com"},
                   {"Host": "127.0.0.1:1"}, {"Sec-Fetch-Site": "cross-site"}, {"X-Viewer-Request": "shutdown"})
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assertEqual(self.request(headers={**self.headers, **changes})[0], 403)
        for missing in ("Origin", "X-Viewer-Request"):
            self.assertEqual(self.request(headers={key: value for key, value in self.headers.items() if key != missing})[0], 403)
        self.choose.assert_not_called()

    def test_paths_and_request_bodies_are_not_accepted(self):
        for request in ({"path": "/open-project?path=/private/circuit.PrjPcb"},
                        {"body": b'{"path":"/private/circuit.PrjPcb"}'},
                        {"headers": {**self.headers, "Transfer-Encoding": "chunked"}}):
            with self.subTest(request=request):
                self.assertEqual(self.request(**request)[0], 400)
        self.choose.assert_not_called()

    def test_dropped_project_headers_require_a_safe_name_and_checksum_pair(self):
        valid = {"X-Project-Name": "board.PrjPcb", "X-Project-SHA256": "a" * 64}
        invalid = [
            {"X-Project-Name": "board.PrjPcb"}, {"X-Project-SHA256": "a" * 64},
            {**valid, "X-Project-Name": "%FF.PrjPcb"}, {**valid, "X-Project-Name": "%invalid.PrjPcb"},
            *({**valid, "X-Project-SHA256": value} for value in ("", "a" * 63, "g" * 64)),
            *({**valid, "X-Project-Name": quote(name, safe="")} for name in
              ("", ".prjpcb", "board.PcbDoc", "/private/board.PrjPcb", "../board.PrjPcb", "C:board.PrjPcb",
               "folder\\board.PrjPcb", "board\0.PrjPcb", "board\n.PrjPcb")),
        ]
        for headers in invalid:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers={**self.headers, **headers})[0], 400)
        self.choose.assert_not_called()

    def test_dropped_project_cancel_preserves_the_ordinary_cancel_response(self):
        name = "électron board.PrjPcb"
        with patch("ecadview.cli.load_initial_documents") as load:
            response = self.request(headers={**self.headers, "X-Project-Name": quote(name), "X-Project-SHA256": "a" * 64})
        self.assertEqual(response, (200, {"cancelled": True}))
        self.choose.assert_called_once_with(name=name)
        load.assert_not_called()

    def test_a_different_project_selection_is_rejected_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as temporary, patch("ecadview.cli.load_initial_documents", return_value=[]) as load:
            folder = Path(temporary)
            expected = b"[Design]\n"
            project = folder / "Board.PRJPCB"
            headers = {**self.headers, "X-Project-Name": "board.PrjPcb", "X-Project-SHA256": hashlib.sha256(expected).hexdigest().upper()}
            self.choose.return_value = project
            project.write_bytes(b"[Design]\nCurrentVariant=Other\n")
            status, result = self.request(headers=headers)
            self.assertEqual(status, 422)
            self.assertIn("does not match", result["error"])
            different_name = folder / "Other.PrjPcb"
            different_name.write_bytes(expected)
            self.choose.return_value = different_name
            self.assertEqual(self.request(headers=headers)[0], 422)
            load.assert_not_called()
            project.write_bytes(expected)
            self.choose.return_value = project
            self.assertEqual(self.request(headers=headers), (200, {"documents": []}))
            load.assert_called_once_with([project])

    def test_cancellation_does_not_load_documents_and_localhost_is_supported(self):
        with patch("ecadview.cli.load_initial_documents") as load:
            self.assertEqual(self.request(), (200, {"cancelled": True}))
            host = f"localhost:{self.server.server_address[1]}"
            self.assertEqual(self.request(headers={**self.headers, "Host": host, "Origin": f"http://{host}"}),
                             (200, {"cancelled": True}))
        load.assert_not_called()

    def test_a_second_open_cannot_launch_a_concurrent_chooser(self):
        entered, released, responses = threading.Event(), threading.Event(), []
        def choose():
            entered.set()
            self.assertTrue(released.wait(3))
            return None
        self.choose.side_effect = choose
        first = threading.Thread(target=lambda: responses.append(self.request()), daemon=True)
        first.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.request()[0], 409)
            self.choose.assert_called_once()
        finally:
            released.set()
            first.join(timeout=3)
        self.assertEqual(responses, [(200, {"cancelled": True})])

    def test_errors_release_the_picker_for_another_open(self):
        self.choose.side_effect = [RuntimeError("No display"), None]
        self.assertEqual(self.request(), (500, {"error": "No display"}))
        self.assertEqual(self.request(), (200, {"cancelled": True}))

    def test_unsupported_or_missing_selection_is_not_loaded(self):
        with tempfile.TemporaryDirectory() as temporary, patch("ecadview.cli.load_initial_documents") as load:
            unsupported = Path(temporary) / "notes.txt"
            unsupported.write_text("notes")
            for path in (unsupported, Path(temporary) / "missing.PrjPcb"):
                self.choose.return_value = path
                status, result = self.request()
                self.assertEqual(status, 500)
                self.assertIn("existing Altium .PrjPcb", result["error"])
            load.assert_not_called()

    def test_selected_project_loads_real_referenced_schematic_and_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            sheet = folder / "Main sheet.SchDoc"
            schematic = AltiumSchDoc()
            schematic.add_object(make_sch_wire(points_mils=[SchPointMils(100, 100), SchPointMils(400, 100)]))
            schematic.save(sheet)
            layout = folder / "Board.PcbDoc"
            board = AltiumPcbDoc()
            board.add_pad(designator="1", position_mils=(100, 100), width_mils=40, height_mils=40)
            board.save(layout)
            project = folder / "Selected project.prjpcb"
            project.write_text("[Design]\n[Document1]\nDocumentPath=Main sheet.SchDoc\n"
                               "[Document2]\nDocumentPath=Board.PcbDoc\n"
                               "[Document3]\nDocumentPath=Missing.SchDoc\n")
            original = {path: path.read_bytes() for path in (project, sheet, layout)}
            self.choose.return_value = project
            hinted = {**self.headers, "X-Project-Name": quote(project.name),
                      "X-Project-SHA256": hashlib.sha256(original[project]).hexdigest()}
            for headers in (self.headers, hinted):
                with self.subTest(dropped_project="X-Project-Name" in headers):
                    status, response = self.request(headers=headers)
                    self.assertEqual(status, 200, response)
                    documents = response["documents"]
                    self.assertEqual([row["kind"] for row in documents], ["project", "schematic", "pcb"])
                    self.assertEqual([row["name"] for row in documents], [path.name for path in (project, sheet, layout)])
                    self.assertEqual([base64.b64decode(row["source"]) for row in documents], list(original.values()))
                    self.assertTrue(all(row["webgl"] for row in documents[1:]))
                    self.assertTrue(all(row["project_key"] == documents[0]["project_key"] for row in documents[1:]))
                    self.assertIn("Missing.SchDoc", documents[0]["warnings"][0])
            self.assertEqual({path: path.read_bytes() for path in original}, original)

    def test_shutdown_marks_picker_unavailable(self):
        self.server.project_picker.close()
        self.assertEqual(self.request()[0], 503)
        self.choose.assert_not_called()


if __name__ == "__main__":
    unittest.main()
