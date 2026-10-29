"""Integration coverage for HTTP routes and both supported Python launch commands."""

import base64
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from importlib.resources import files
import json
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote, urlsplit

from altium_monkey import AltiumSchDoc, SchPointMils, make_sch_wire

from pcbvisualizer.server import Handler


ROOT = Path(__file__).resolve().parents[1]


def schematic_bytes():
    schematic = AltiumSchDoc()
    schematic.add_object(make_sch_wire(points_mils=[SchPointMils(100, 100), SchPointMils(400, 100)]))
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "sheet.SchDoc"
        schematic.save(path)
        return path.read_bytes()


class ServerTests(unittest.TestCase):
    def setUp(self):
        Handler.initial = None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        Handler.initial = None

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection(*self.server.server_address, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_frontend_resources_have_correct_content_and_types(self):
        for route, filename, content_type in (
            ("/", "index.html", "text/html"),
            ("/static/viewer.css", "viewer.css", "text/css"),
            ("/static/viewer.js", "viewer.js", "text/javascript"),
            ("/static/net-labels.js", "net-labels.js", "text/javascript"),
            ("/static/viewer-3d.js", "viewer-3d.js", "text/javascript"),
            ("/static/layout-webgl.js", "layout-webgl.js", "text/javascript"),
            ("/static/layout-shaders.js", "layout-shaders.js", "text/javascript"),
            ("/static/schematic-style.js", "schematic-style.js", "text/javascript"),
            ("/static/measurement-tools.js", "measurement-tools.js", "text/javascript"),
            ("/static/rectangle-selection.js", "rectangle-selection.js", "text/javascript"),
            ("/static/three.module.min.js", "three.module.min.js", "text/javascript"),
            ("/static/three.core.min.js", "three.core.min.js", "text/javascript"),
            ("/static/OrbitControls.js", "OrbitControls.js", "text/javascript"),
            ("/static/THREE-LICENSE.txt", "THREE-LICENSE.txt", "text/plain"),
        ):
            with self.subTest(route=route):
                status, headers, body = self.request("GET", route + "?version=test")
                self.assertEqual(status, 200)
                self.assertEqual(body, files("pcbvisualizer").joinpath("static", filename).read_bytes())
                self.assertEqual(headers["Content-Type"], content_type + "; charset=utf-8")
                self.assertEqual(int(headers["Content-Length"]), len(body))
        html = self.request("GET", "/")[2].decode()
        self.assertIn('href="/static/viewer.css"', html)
        self.assertIn('src="/static/viewer.js"', html)

    def test_unknown_and_unlisted_resource_paths_return_404(self):
        for path in ("/missing", "/static/../rendering.py", "/static/%2e%2e/server.py", "/static/index.html"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("POST", "/missing", body=b"")[0], 404)

    def test_initial_document_is_served_once(self):
        initial = {"name": "board.PcbDoc", "svg": "<svg/>"}
        Handler.initial = initial
        self.assertEqual(json.loads(self.request("GET", "/initial")[2]), initial)
        self.assertEqual(json.loads(self.request("GET", "/initial")[2]), {})

    def test_upload_renders_a_schematic(self):
        name = "sheet with spaces.SchDoc"
        status, _, body = self.request("POST", "/render", schematic_bytes(), {"X-Filename": quote(name)})
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["kind"], "schematic")
        self.assertEqual(data["name"], name)
        self.assertEqual(data["stats"], {"components": 0, "wires": 1, "net_labels": 0})
        self.assertIn("<svg", data["svg"])

    def test_upload_renders_kicad_pcb_and_schematic_files(self):
        for extension, kind in (("kicad_pcb", "pcb"), ("kicad_sch", "schematic")):
            with self.subTest(extension=extension):
                source = (ROOT / "tests" / "fixtures" / "kicad" / f"demo.{extension}").read_bytes()
                status, _, body = self.request("POST", "/render", source,
                                               {"X-Filename": quote(f"KiCad board.{extension}")})
                data = json.loads(body)
                self.assertEqual(status, 200)
                self.assertEqual(data["kind"], kind)
                self.assertEqual(data["stats"]["components"], 2)
                self.assertEqual(data["name"], f"KiCad board.{extension}")
                self.assertIn("<svg", data["svg"])

    def test_upload_renders_legacy_kicad_sheets_with_incomplete_preview_notice(self):
        source = (ROOT / "tests" / "fixtures" / "kicad" / "legacy.sch").read_bytes()
        status, _, body = self.request("POST", "/render", source, {"X-Filename": "legacy.sch"})
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(data["kind"], "schematic")
        self.assertEqual(data["stats"]["components"], 2)
        self.assertIn("pin connectivity are unavailable", data["warnings"][0])

    def test_malformed_kicad_upload_returns_an_error_and_keeps_serving(self):
        status, _, body = self.request("POST", "/render", b"(kicad_pcb", {"X-Filename": "broken.kicad_pcb"})
        self.assertEqual(status, 500)
        self.assertIn("Invalid KiCad", json.loads(body)["error"])
        self.assertEqual(self.request("GET", "/")[0], 200)

    def test_upload_passes_render_options_and_removes_temporary_file(self):
        with patch("pcbvisualizer.server.render_file", return_value={"svg": "<svg/>"}) as render:
            status, _, body = self.request("POST", "/render?side=bottom&clip=1&pour=%23ff0000&outlines=1",
                                           b"board data", {"X-Filename": "board.PcbDoc"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"svg": "<svg/>"})
        self.assertEqual(render.call_args.args[0].name, "board.PcbDoc")
        self.assertEqual(render.call_args.kwargs, {
            "side": "bottom", "clip": True, "pour_color": "#ff0000", "polygon_outlines": True,
        })
        self.assertFalse(render.call_args.args[0].exists())

    def test_unsupported_upload_returns_json_error(self):
        status, headers, body = self.request("POST", "/render", b"text", {"X-Filename": "notes.txt"})
        self.assertEqual(status, 500)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertRegex(json.loads(body)["error"], r"ValueError: .*PcbDoc.*SchDoc")

    def test_webgl_upload_requests_compact_geometry_metadata(self):
        with patch("pcbvisualizer.server.render_file", return_value={"svg": "<svg/>"}) as render:
            status, _, body = self.request("POST", "/render", b"board", {"X-WebGL": "1"})
        self.assertEqual(status, 200)
        self.assertTrue(render.call_args.kwargs["native"])
        self.assertTrue(json.loads(body)["webgl"])

    def test_geometry_response_busy_and_error_routes(self):
        with patch("pcbvisualizer.server.prepare_geometry", return_value=b"binary") as prepare:
            status, headers, body = self.request("POST", "/geometry", b"{}")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertEqual(body, b"binary")
        prepare.assert_called_once_with(b"{}")
        with patch("pcbvisualizer.server.prepare_geometry", return_value=None):
            self.assertEqual(self.request("POST", "/geometry", b"{}")[0], 503)
        with patch("pcbvisualizer.server.prepare_geometry", side_effect=ValueError("Unsupported")):
            status, _, body = self.request("POST", "/geometry", b"{}")
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(body), {"error": "Unsupported"})
        self.assertEqual(self.request("POST", "/geometry", b"")[0], 413)


class LaunchTests(unittest.TestCase):
    def test_web_startup_opens_multiple_documents_in_one_session(self):
        paths = [ROOT / "tests/fixtures/kicad" / name for name in ("demo.kicad_pcb", "demo.kicad_sch")]
        process = subprocess.Popen([sys.executable, "-B", "-u", str(ROOT / "pcb_viewer_gui.py"), "--web", "--no-open", *map(str, paths)],
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        output = queue.Queue()
        def read_output():
            for line in process.stdout:
                output.put(line)
            output.put(None)
        reader = threading.Thread(target=read_output, daemon=True); reader.start()
        try:
            while True:
                line = output.get(timeout=20)
                self.assertIsNotNone(line, "Viewer exited before startup")
                match = re.search(r"http://127\.0\.0\.1:\d+/", line)
                if match:
                    break
            url = urlsplit(match[0])
            connection = HTTPConnection(url.hostname, url.port, timeout=10)
            try:
                connection.request("GET", "/initial")
                documents = json.loads(connection.getresponse().read())["documents"]
                self.assertEqual([data["kind"] for data in documents], ["pcb", "schematic"])
                self.assertEqual([data["name"] for data in documents], [path.name for path in paths])
                self.assertEqual([base64.b64decode(data["source"]) for data in documents], [path.read_bytes() for path in paths])
                connection.request("GET", "/initial")
                self.assertEqual(json.loads(connection.getresponse().read()), {})
            finally:
                connection.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
            reader.join(timeout=5); process.stdout.close()

    def test_kicad_startup_document_is_available_without_a_kicad_installation(self):
        command = [sys.executable, "-B", "-u", str(ROOT / "pcb_viewer_gui.py"),
                   str(ROOT / "tests" / "fixtures" / "kicad" / "demo.kicad_pcb"), "--no-open"]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            output = queue.Queue()
            def read_output():
                for line in process.stdout:
                    output.put(line)
                output.put(None)
            reader = threading.Thread(target=read_output, daemon=True); reader.start()
            while True:
                line = output.get(timeout=20)
                self.assertIsNotNone(line, "Viewer exited before startup")
                match = re.search(r"http://127\.0\.0\.1:\d+/", line)
                if match:
                    break
            url = urlsplit(match[0])
            connection = HTTPConnection(url.hostname, url.port, timeout=10)
            try:
                connection.request("GET", "/initial")
                data = json.loads(connection.getresponse().read())
                self.assertEqual(data["name"], "demo.kicad_pcb")
                self.assertEqual(data["kind"], "pcb")
                self.assertEqual(data["stats"]["components"], 2)
                self.assertEqual(base64.b64decode(data["source"]), (ROOT / "tests" / "fixtures" / "kicad" / "demo.kicad_pcb").read_bytes())
            finally:
                connection.close()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
            reader.join(timeout=5); process.stdout.close()

    def test_launch_commands_load_initial_document_and_packaged_assets(self):
        data = schematic_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "initial.SchDoc"
            path.write_bytes(data)
            commands = (
                ([sys.executable, "-B", "-u", str(ROOT / "pcb_viewer_gui.py")], tmp),
                ([sys.executable, "-B", "-u", "-m", "pcbvisualizer", "--web"], ROOT),
            )
            for command, cwd in commands:
                with self.subTest(command=command):
                    process = subprocess.Popen(command + [str(path), "--no-open"], cwd=cwd,
                                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                    try:
                        output = queue.Queue()
                        def read_output():
                            for line in process.stdout:
                                output.put(line)
                            output.put(None)
                        reader = threading.Thread(target=read_output, daemon=True)
                        reader.start()
                        lines = []
                        while True:
                            line = output.get(timeout=20)
                            self.assertIsNotNone(line, "Viewer exited before startup: " + "".join(lines))
                            lines.append(line)
                            match = re.search(r"http://127\.0\.0\.1:\d+/", line)
                            if match:
                                break
                        url = urlsplit(match[0])
                        connection = HTTPConnection(url.hostname, url.port, timeout=10)
                        try:
                            for route in ("/", "/static/viewer.css", "/static/viewer.js"):
                                connection.request("GET", route)
                                response = connection.getresponse()
                                self.assertEqual(response.status, 200)
                                self.assertTrue(response.read())
                            connection.request("GET", "/initial")
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200)
                            initial = json.loads(response.read())
                            self.assertEqual(initial["name"], path.name)
                            self.assertEqual(initial["kind"], "schematic")
                            self.assertEqual(base64.b64decode(initial["source"]), data)
                            connection.request("GET", "/initial")
                            self.assertEqual(json.loads(connection.getresponse().read()), {})
                        finally:
                            connection.close()
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                        reader.join(timeout=5)
                        process.stdout.close()
