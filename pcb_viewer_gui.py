#!/usr/bin/env python3
"""
Standalone Altium PCB viewer.

    python pcb_viewer_gui.py                 # starts a local server and opens Chrome
    python pcb_viewer_gui.py board.PcbDoc    # ...and loads this board straight away
    python pcb_viewer_gui.py --browser default

Pick .PcbDoc files with the "Open board" button (or drag & drop them onto the
page). Everything runs locally; the file is parsed by altium-monkey on your
machine and only the rendered SVG is sent to the browser tab.

Requires:  pip install altium-monkey   (Python 3.12+)
"""

import argparse
import json
import secrets
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from altium_monkey import AltiumPcbDoc, PcbSvgRenderOptions
    from altium_monkey.altium_pcb_surface import PCB_SurfaceSide
except ImportError:
    sys.exit("altium-monkey is not installed. Run:  pip install altium-monkey")


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render_file(path: Path, side: str = "all", clip: bool = False,
                pour_color: str | None = None, polygon_outlines: bool = False) -> dict:
    pcb = AltiumPcbDoc.from_file(path)
    options = PcbSvgRenderOptions(
        show_board_outline=True,
        clip_copper_to_board_outline=clip,
        polygon_overlay_color=pour_color or None,
        include_polygon_definition_overlays=polygon_outlines,
        svg_display_scale=4.0,
    )
    if side == "top":
        svg = pcb.to_surface_svg(PCB_SurfaceSide.TOP, options=options)
    elif side == "bottom":
        svg = pcb.to_surface_svg(PCB_SurfaceSide.BOTTOM, options=options)
    else:
        svg = pcb.to_svg(options=options)
    return {
        "svg": svg,
        "name": path.name,
        "stats": {
            "components": len(pcb.components),
            "pads": len(pcb.pads),
            "tracks": len(pcb.tracks),
            "vias": len(pcb.vias),
            "polygons": len(pcb.polygons),
            "regions": len(pcb.regions),
        },
    }


# ---------------------------------------------------------------------------
# Web page
# ---------------------------------------------------------------------------

PAGE = r"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PCB viewer</title>
<style>
  :root { color-scheme: dark;
          --bg: #1b1d21; --panel: #24272c; --line: #3a3e45; --text: #d8dbe0; --muted: #8b909a;
          --accent: #35c2d8; --accent-ink: #06262b; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
               font: 13px/1.45 "Segoe UI", system-ui, sans-serif; overflow: hidden; }
  #app { display: flex; height: 100%; }
  #panel { width: 270px; flex: none; background: var(--panel); border-right: 1px solid var(--line);
           display: flex; flex-direction: column; box-sizing: border-box; }
  #panel > * { padding: 10px 12px; border-bottom: 1px solid var(--line); }
  #panel > :last-child { border-bottom: 0; }
  #layers-wrap { flex: 1; overflow-y: auto; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
  #filename { color: var(--muted); font-size: 12px; word-break: break-all; min-height: 1.4em; }
  button { background: #3a3e45; color: var(--text); border: 1px solid #4a4f58; border-radius: 4px;
           padding: 5px 8px; cursor: pointer; font: inherit; }
  button:hover { background: #474c56; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; width: 100%; }
  button.primary:hover { filter: brightness(1.1); }
  button.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .row button { flex: 1; }
  .opt { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .opt select, .opt input[type=text] { flex: 1; background: #1b1d21; color: var(--text); border: 1px solid var(--line);
                                       border-radius: 4px; padding: 3px 6px; font: inherit; }
  #layers label { display: flex; align-items: center; gap: 6px; padding: 3px 2px; cursor: pointer;
                  border-radius: 3px; user-select: none; }
  #layers label:hover { background: #2e3238; }
  .swatch { width: 12px; height: 12px; border-radius: 2px; flex: none; border: 1px solid #0006; }
  .count { margin-left: auto; color: var(--muted); font-size: 11px; }
  #stats { color: var(--muted); font-size: 12px; white-space: pre-line; }
  #readout { font: 12px/1.5 ui-monospace, Consolas, monospace; color: #bbb; white-space: pre;
             background: #1b1d21; border-radius: 4px; padding: 6px; margin-top: 6px; min-height: 3.6em; }
  .hint { color: var(--muted); font-size: 11px; }
  #view { flex: 1; overflow: hidden; cursor: grab; position: relative; }
  #view:active { cursor: grabbing; }
  #view.measuring, #view.measuring:active { cursor: crosshair; }
  #view.drop { outline: 3px dashed var(--accent); outline-offset: -3px; }
  #view svg { width: 100%; height: 100%; display: block; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           color: var(--muted); font-size: 15px; text-align: center; pointer-events: none; }
  #measure line, #measure circle { vector-effect: non-scaling-stroke; stroke: var(--accent); stroke-width: 1.5; fill: none; }
  #measure-label { position: absolute; pointer-events: none; background: var(--accent); color: var(--accent-ink);
                   font: 12px ui-monospace, Consolas, monospace; padding: 2px 6px; border-radius: 3px;
                   transform: translate(-50%, -130%); white-space: nowrap; display: none; }
  #toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); background: #b23b3b; color: #fff;
           padding: 8px 14px; border-radius: 6px; display: none; max-width: 70%; }
  #busy { position: absolute; inset: 0; background: #0008; display: none; align-items: center; justify-content: center; }
</style></head><body>
<div id="app">
  <div id="panel">
    <div>
      <h1>PCB viewer</h1>
      <input id="file" type="file" accept=".PcbDoc,.pcbdoc" hidden>
      <button class="primary" id="open">Open board…</button>
      <div id="filename">No board loaded</div>
    </div>
    <div>
      <div class="opt"><span>View</span>
        <select id="side"><option value="all">All layers</option><option value="top">Top side</option><option value="bottom">Bottom side</option></select></div>
      <div class="opt"><input type="checkbox" id="outlines"><label for="outlines">Polygon outlines</label></div>
      <div class="opt"><input type="checkbox" id="clip"><label for="clip">Clip copper to board outline</label></div>
      <div class="opt"><span>Pour colour</span><input type="text" id="pour" placeholder="layer colour" size="8"></div>
      <div class="row"><button id="rerender">Re-render</button></div>
    </div>
    <div id="layers-wrap">
      <div class="row" style="margin:0 0 6px"><button id="all">Show all</button><button id="none">Hide all</button></div>
      <div id="layers"></div>
    </div>
    <div>
      <div class="row" style="margin:0"><button id="measure-btn">Measure (M)</button>
        <button data-unit="mm" class="on unit">mm</button><button data-unit="mil" class="unit">mil</button><button data-unit="in" class="unit">in</button></div>
      <div id="readout"></div>
      <div class="hint">Scroll to zoom, drag to pan, double-click to reset. Measure: click two points, Esc clears.</div>
    </div>
    <div id="stats"></div>
  </div>
  <div id="view">
    <div id="empty">Open a .PcbDoc file<br>or drop one here</div>
    <div id="measure-label"></div>
    <div id="toast"></div>
    <div id="busy">Rendering…</div>
  </div>
</div>
<script>
(function () {
  const $ = id => document.getElementById(id);
  const view = $('view'), layersEl = $('layers'), readout = $('readout'), label = $('measure-label');
  const NS = 'http://www.w3.org/2000/svg';
  let svg = null, groups = [], vb = null, home = null, lastFile = null;

  // ------------------------------------------------------------ loading
  async function loadFile(file) {
    if (!file) return;
    lastFile = file;
    const q = new URLSearchParams({
      side: $('side').value, clip: $('clip').checked ? 1 : 0,
      outlines: $('outlines').checked ? 1 : 0, pour: $('pour').value.trim(),
    });
    $('busy').style.display = 'flex';
    try {
      const r = await fetch('/render?' + q, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(file.name) }, body: file });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      show(data);
    } catch (e) {
      toast('Could not render this file: ' + e.message);
    } finally {
      $('busy').style.display = 'none';
    }
  }

  function show(data) {
    if (svg) svg.remove();
    $('empty').style.display = 'none';
    const tpl = document.createElement('div'); tpl.innerHTML = data.svg;
    svg = tpl.querySelector('svg'); view.prepend(svg);
    $('filename').textContent = data.name;
    const s = data.stats;
    $('stats').textContent = `${s.components} components, ${s.pads} pads, ${s.tracks} tracks, ${s.vias} vias\n${s.polygons} polygons, ${s.regions} poured regions`;
    buildLayers(); setupView(); setupMeasureLayer(); pts = []; draw();
  }

  $('open').onclick = () => $('file').click();
  $('file').onchange = e => loadFile(e.target.files[0]);
  $('rerender').onclick = () => lastFile ? loadFile(lastFile) : toast('Open a board first.');
  ['side', 'clip', 'outlines'].forEach(id => $(id).onchange = () => lastFile && loadFile(lastFile));
  view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('drop'); });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('drop'); loadFile(e.dataTransfer.files[0]); });

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 5000); }

  // ------------------------------------------------------------ layers
  function buildLayers() {
    layersEl.innerHTML = '';
    groups = [...svg.querySelectorAll('#scene > g')];
    for (const g of groups) {
      const name = g.dataset.layerDisplayName || g.dataset.layerName || g.id.replace(/^layer-/, '');
      const color = g.dataset.color || (g.id === 'board-outline' ? '#C0A000' : '#888');
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
      cb.onchange = () => { g.style.display = cb.checked ? '' : 'none'; };
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color;
      lab.append(cb, sw, document.createTextNode(name));
      if (g.dataset.primitiveCount !== undefined) { const c = document.createElement('span'); c.className = 'count'; c.textContent = g.dataset.primitiveCount; lab.append(c); }
      layersEl.append(lab); g._cb = cb;
    }
  }
  const setAll = v => groups.forEach(g => { g._cb.checked = v; g.style.display = v ? '' : 'none'; });
  $('all').onclick = () => setAll(true);
  $('none').onclick = () => setAll(false);

  // ------------------------------------------------------------ pan / zoom
  function setupView() {
    const b = svg.viewBox.baseVal;
    home = { x: b.x, y: b.y, w: b.width, h: b.height }; vb = { ...home }; apply();
  }
  function apply() { if (svg) { svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); draw(); } }
  view.addEventListener('wheel', e => {
    if (!svg) return; e.preventDefault();
    const r = view.getBoundingClientRect();
    const px = vb.x + (e.clientX - r.left) / r.width * vb.w, py = vb.y + (e.clientY - r.top) / r.height * vb.h;
    const k = Math.exp(e.deltaY * 0.0015);
    vb = { x: px - (px - vb.x) * k, y: py - (py - vb.y) * k, w: vb.w * k, h: vb.h * k }; apply();
  }, { passive: false });
  let drag = null;
  view.addEventListener('mousedown', e => { if (svg && (!measuring || e.button === 1)) drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; });
  window.addEventListener('mousemove', e => {
    if (!drag) return; const r = view.getBoundingClientRect();
    vb.x = drag.vx - (e.clientX - drag.x) / r.width * vb.w; vb.y = drag.vy - (e.clientY - drag.y) / r.height * vb.h; apply();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  view.addEventListener('dblclick', () => { if (svg && !measuring) { vb = { ...home }; apply(); } });

  // ------------------------------------------------------------ measuring (SVG units are mm)
  const UNITS = { mm: { f: 1, d: 3 }, mil: { f: 1000 / 25.4, d: 1 }, in: { f: 1 / 25.4, d: 4 } };
  let unit = 'mm', measuring = false, pts = [], hover = null, mg = null;
  const fmt = v => (v * UNITS[unit].f).toFixed(UNITS[unit].d) + ' ' + unit;
  function setupMeasureLayer() { mg = document.createElementNS(NS, 'g'); mg.id = 'measure'; svg.append(mg); }
  const toSvg = e => { const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse()); return { x: p.x, y: p.y }; };
  const toScreen = p => { const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM()); const r = view.getBoundingClientRect(); return { x: q.x - r.left, y: q.y - r.top }; };
  function dot(p) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 0.3); return c; }
  function draw() {
    if (!mg) return;
    mg.innerHTML = ''; label.style.display = 'none';
    const a = pts[0], b = pts[1] || (pts[0] && hover);
    if (!a) { readout.textContent = measuring && hover ? `cursor  ${fmt(hover.x)}, ${fmt(-hover.y)}` : ''; return; }
    mg.append(dot(a));
    if (!b) { readout.textContent = `A  ${fmt(a.x)}, ${fmt(-a.y)}`; return; }
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y); mg.append(l, dot(b));
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    const m = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    label.textContent = fmt(d); label.style.left = m.x + 'px'; label.style.top = m.y + 'px'; label.style.display = 'block';
    readout.textContent = `dist ${fmt(d)}\ndx   ${fmt(Math.abs(dx))}\ndy   ${fmt(Math.abs(dy))}\nang  ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°`;
  }
  function setMeasuring(v) {
    measuring = v; $('measure-btn').classList.toggle('on', v); view.classList.toggle('measuring', v);
    if (!v) { pts = []; hover = null; draw(); }
  }
  $('measure-btn').onclick = () => setMeasuring(!measuring);
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'm' || e.key === 'M') setMeasuring(!measuring);
    if (e.key === 'Escape') { pts = []; draw(); }
  });
  document.querySelectorAll('.unit').forEach(b => b.onclick = () => {
    unit = b.dataset.unit; document.querySelectorAll('.unit').forEach(x => x.classList.toggle('on', x === b)); draw();
  });
  view.addEventListener('click', e => { if (!svg || !measuring) return; if (pts.length === 2) pts = []; pts.push(toSvg(e)); draw(); });
  view.addEventListener('mousemove', e => { if (svg && measuring) { hover = toSvg(e); if (pts.length !== 2) draw(); } });

  // ------------------------------------------------------------ board passed on the command line
  fetch('/initial').then(r => r.ok ? r.json() : null).then(d => { if (d && d.svg) show(d); }).catch(() => {});
})();
</script>
</body></html>
"""


# ---------------------------------------------------------------------------
# Local HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    initial: dict | None = None  # board given on the command line, served once
    token: str = ""

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
        if url.path == "/":
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
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


def open_in_browser(url: str, browser: str = "chrome") -> None:
    if browser == "default":
        webbrowser.open(url)
        return
    for name in (browser, f"{browser}.exe", f"google-{browser}", f"{browser}-browser"):
        try:
            webbrowser.get(name).open(url)
            return
        except webbrowser.Error:
            pass
    if sys.platform == "darwin":
        app = {"chrome": "Google Chrome", "firefox": "Firefox", "safari": "Safari"}.get(browser, browser)
        if subprocess.run(["open", "-a", app, url]).returncode == 0:
            return
    elif sys.platform == "win32" and browser == "chrome":
        for exe in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
            if Path(exe).is_file():
                subprocess.Popen([exe, url])
                return
    print(f"Could not find {browser}; opening with the system default browser instead.")
    webbrowser.open(url)


def main() -> None:
    ap = argparse.ArgumentParser(description="Standalone Altium PCB viewer")
    ap.add_argument("pcbdoc", nargs="?", type=Path, help="optional .PcbDoc to load at startup")
    ap.add_argument("--port", type=int, default=0, help="port to listen on (default: random free port)")
    ap.add_argument("--browser", default="chrome", help="chrome (default), firefox, safari, default, ...")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser, just print the URL")
    args = ap.parse_args()

    if args.pcbdoc:
        if not args.pcbdoc.is_file():
            sys.exit(f"File not found: {args.pcbdoc}")
        print(f"Loading {args.pcbdoc.name} ...")
        Handler.initial = render_file(args.pcbdoc)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"PCB viewer running at {url}   (Ctrl+C to stop)")

    if not args.no_open:
        threading.Timer(0.3, open_in_browser, args=(url, args.browser)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
