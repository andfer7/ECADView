"""Local HTTP endpoints for the viewer and document uploads."""

from http.server import BaseHTTPRequestHandler
from importlib.resources import files
import json
from pathlib import Path
import tempfile
import urllib.parse

from .rendering import render_file
from .web_geometry import MAX_INPUT, prepare_geometry


# Explicit routes keep package resources private unless listed here.
STATIC_ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/static/viewer.css": ("viewer.css", "text/css; charset=utf-8"),
    "/static/viewer.js": ("viewer.js", "text/javascript; charset=utf-8"),
    "/static/net-labels.js": ("net-labels.js", "text/javascript; charset=utf-8"),
    "/static/viewer-3d.js": ("viewer-3d.js", "text/javascript; charset=utf-8"),
    "/static/layout-webgl.js": ("layout-webgl.js", "text/javascript; charset=utf-8"),
    "/static/layout-shaders.js": ("layout-shaders.js", "text/javascript; charset=utf-8"),
    "/static/three.module.min.js": ("three.module.min.js", "text/javascript; charset=utf-8"),
    "/static/three.core.min.js": ("three.core.min.js", "text/javascript; charset=utf-8"),
    "/static/OrbitControls.js": ("OrbitControls.js", "text/javascript; charset=utf-8"),
    "/static/THREE-LICENSE.txt": ("THREE-LICENSE.txt", "text/plain; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    initial: dict | None = None  # board given on the command line, served once

    def log_message(self, *_):  # keep the console quiet
        pass

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj: dict) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json")

    def do_GET(self) -> None:
        url = urllib.parse.urlparse(self.path)
        if url.path in STATIC_ROUTES:
            filename, content_type = STATIC_ROUTES[url.path]
            body = files("pcbvisualizer").joinpath("static", filename).read_bytes()
            self._send(200, body, content_type)
        elif url.path == "/initial":
            data, Handler.initial = Handler.initial, None
            self._json(200, data or {})
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:
        url = urllib.parse.urlparse(self.path)
        if url.path == "/geometry":
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= MAX_INPUT:
                    self.close_connection = True
                    self._json(413, {"error": "Invalid layout geometry request size"})
                    return
                geometry = prepare_geometry(self.rfile.read(length))
                if geometry is None:
                    self._json(503, {"error": "Another layout is being prepared"})
                else:
                    self._send(200, geometry, "application/octet-stream")
            except (BrokenPipeError, ConnectionResetError):
                pass  # The tab was closed while its isolated compiler finished.
            except Exception as exc:
                self._json(422, {"error": str(exc)})
            return
        if url.path != "/render":
            self._send(404, b"not found", "text/plain")
            return
        q = urllib.parse.parse_qs(url.query)
        get = lambda k, d="": q.get(k, [d])[0]
        name = urllib.parse.unquote(self.headers.get("X-Filename", "board.PcbDoc"))
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            webgl = self.headers.get("X-WebGL") == "1"
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / (Path(name).name or "board.PcbDoc")
                path.write_bytes(body)
                data = render_file(
                    path,
                    side=get("side", "all"),
                    clip=get("clip") == "1",
                    pour_color=get("pour") or None,
                    polygon_outlines=get("outlines") == "1",
                    **({"native": True} if webgl else {}),
                )
            if webgl:
                data["webgl"] = True
            self._json(200, data)
        except Exception as exc:  # report parser/renderer errors to the page
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})
