"""Local HTTP endpoints for the viewer and document uploads."""

from http.server import BaseHTTPRequestHandler
from importlib.resources import files
import json
from pathlib import Path
import tempfile
import urllib.parse

from .rendering import render_file


# Explicit routes keep package resources private unless listed here.
STATIC_ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/static/viewer.css": ("viewer.css", "text/css; charset=utf-8"),
    "/static/viewer.js": ("viewer.js", "text/javascript; charset=utf-8"),
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
        if url.path != "/render":
            self._send(404, b"not found", "text/plain")
            return
        q = urllib.parse.parse_qs(url.query)
        get = lambda k, d="": q.get(k, [d])[0]
        name = urllib.parse.unquote(self.headers.get("X-Filename", "board.PcbDoc"))
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / (Path(name).name or "board.PcbDoc")
                path.write_bytes(body)
                data = render_file(
                    path,
                    side=get("side", "all"),
                    clip=get("clip") == "1",
                    pour_color=get("pour") or None,
                    polygon_outlines=get("outlines") == "1",
                )
            self._json(200, data)
        except Exception as exc:  # report parser/renderer errors to the page
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})
