#!/usr/bin/env python3
"""
Standalone Altium PCB viewer.

    python pcb_viewer_gui.py                 # starts a local server and opens Chrome
    python pcb_viewer_gui.py board.PcbDoc    # ...and loads this board straight away
    python pcb_viewer_gui.py --browser default

Pick .PcbDoc files with the "Open boards" button (or drag & drop them onto the
page). Each board opens in its own tab. Everything runs locally; the file is parsed by altium-monkey on your
machine and only the rendered SVG is sent to the browser tab.

Requires:  pip install altium-monkey   (Python 3.12+)
"""

import argparse
import base64
from dataclasses import replace
from io import BytesIO
import json
import secrets
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import freetype
    from altium_monkey import AltiumPcbDoc, PcbSvgRenderOptions
    from altium_monkey.altium_pcb_surface import PCB_SurfaceSide
    from altium_monkey.altium_ttf_metrics import get_font_path_with_style
except ImportError:
    sys.exit("altium-monkey is not installed. Run:  pip install altium-monkey")


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def prepare_embedded_fonts(pcb: AltiumPcbDoc) -> list[str]:
    """Replace fonts FreeType cannot read in the parsed copy of the board."""
    fonts, warnings = [], []
    for font in pcb.embedded_fonts:
        try:
            freetype.Face(BytesIO(font.decompress()))
        except freetype.FT_Exception:
            style = f"{font.name} {font.style}".lower()
            font_path = get_font_path_with_style(
                font.name, bold="bold" in style,
                italic="italic" in style or "oblique" in style,
            )
            if not font_path:
                raise RuntimeError(f'Embedded font "{font.name}" is unreadable and no replacement font is available.')
            try:
                replacement = Path(font_path).read_bytes()
                freetype.Face(BytesIO(replacement))
            except (OSError, freetype.FT_Exception) as exc:
                raise RuntimeError(f'Could not load a replacement for unreadable embedded font "{font.name}".') from exc
            fonts.append(replace(font, compressed_data=zlib.compress(replacement), raw_data=b""))
            warnings.append(
                f'Embedded font "{font.name}" could not be read; using "{Path(font_path).stem}". '
                'Text shape and spacing may differ.'
            )
        else:
            fonts.append(font)
    pcb.embedded_fonts = fonts
    return warnings


def render_file(path: Path, side: str = "all", clip: bool = False,
                pour_color: str | None = None, polygon_outlines: bool = False) -> dict:
    pcb = AltiumPcbDoc.from_file(path)
    warnings = prepare_embedded_fonts(pcb)
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
        "warnings": warnings,
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
  #warnings { color: #efc578; font-size: 12px; white-space: pre-line; margin-top: 6px; }
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
  #workspace { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  #tabs { display: flex; flex: none; overflow-x: auto; background: var(--panel); border-bottom: 1px solid var(--line); }
  #tabs:empty { display: none; }
  .tab { display: flex; align-items: center; flex: none; border-right: 1px solid var(--line); }
  .tab.active { background: var(--bg); box-shadow: inset 0 2px var(--accent); }
  .tab button { background: transparent; border: 0; border-radius: 0; }
  .tab button:hover { background: #474c56; }
  .tab-name { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 9px 12px; }
  .tab-close { margin-right: 4px; }
  #view { flex: 1; min-height: 0; overflow: hidden; cursor: grab; position: relative; }
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
      <input id="file" type="file" accept=".PcbDoc,.pcbdoc" multiple hidden>
      <button class="primary" id="open">Open boards…</button>
      <div id="filename">No board loaded</div>
      <div id="warnings" role="status" hidden></div>
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
  <div id="workspace">
    <div id="tabs" role="tablist" aria-label="Open boards"></div>
    <div id="view" role="tabpanel" aria-label="Board view">
      <div id="empty">Open .PcbDoc files<br>or drop them here</div>
      <div id="measure-label"></div>
      <div id="toast"></div>
      <div id="busy">Rendering…</div>
    </div>
  </div>
</div>
<script>
(function () {
  const $ = id => document.getElementById(id);
  const view = $('view'), layersEl = $('layers'), readout = $('readout'), label = $('measure-label');
  const NS = 'http://www.w3.org/2000/svg';
  let svg = null, groups = [], vb = null, home = null;
  const boards = [];
  let activeBoard = null, nextBoardId = 1;

  // ------------------------------------------------------------ board tabs / loading
  const defaultOptions = () => ({ side: 'all', clip: false, outlines: false, pour: '' });
  function readOptions() {
    return { side: $('side').value, clip: $('clip').checked,
             outlines: $('outlines').checked, pour: $('pour').value };
  }
  function saveBoard() {
    if (!activeBoard) return;
    Object.assign(activeBoard, { svg, groups, vb, home, unit, measuring, pts, hover, mg, options: readOptions() });
  }
  function createBoard(file, name = file.name) {
    const board = { id: nextBoardId++, file, name, stats: null, warnings: [], options: defaultOptions(),
                    svg: null, groups: [], vb: null, home: null, unit: 'mm', measuring: false,
                    pts: [], hover: null, mg: null, loading: false, request: 0 };
    boards.push(board);
    return board;
  }
  function updateTabs() {
    $('tabs').replaceChildren();
    for (const board of boards) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (board === activeBoard ? ' active' : '');
      const button = document.createElement('button');
      button.className = 'tab-name'; button.id = 'board-tab-' + board.id;
      button.textContent = board.name + (board.loading ? ' …' : ''); button.title = board.name;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'view');
      button.setAttribute('aria-selected', String(board === activeBoard));
      button.tabIndex = board === activeBoard ? 0 : -1;
      button.onclick = () => activateBoard(board);
      button.onkeydown = e => {
        const index = boards.indexOf(board);
        let target;
        if (e.key === 'ArrowRight') target = boards[(index + 1) % boards.length];
        if (e.key === 'ArrowLeft') target = boards[(index + boards.length - 1) % boards.length];
        if (e.key === 'Home') target = boards[0];
        if (e.key === 'End') target = boards[boards.length - 1];
        if (e.key === 'Delete') { e.preventDefault(); closeBoard(board); }
        if (target) { e.preventDefault(); activateBoard(target); $('board-tab-' + target.id).focus(); }
      };
      const close = document.createElement('button');
      close.className = 'tab-close'; close.textContent = '×';
      close.setAttribute('aria-label', 'Close ' + board.name);
      close.onclick = () => closeBoard(board);
      tab.append(button, close); $('tabs').append(tab);
    }
  }
  function activateBoard(board) {
    saveBoard();
    mountBoard(board);
  }
  function mountBoard(board) {
    if (svg) svg.remove();
    activeBoard = board; drag = null;
    ({ svg, groups, vb, home, unit, measuring, pts, hover, mg } = board || {
      svg: null, groups: [], vb: null, home: null, unit: 'mm', measuring: false, pts: [], hover: null, mg: null,
    });
    const options = board ? board.options : defaultOptions();
    $('side').value = options.side; $('clip').checked = options.clip;
    $('outlines').checked = options.outlines; $('pour').value = options.pour;
    $('filename').textContent = board ? board.name : 'No board loaded';
    $('warnings').textContent = board ? board.warnings.join('\n') : '';
    $('warnings').hidden = !$('warnings').textContent;
    const s = board && board.stats;
    $('stats').textContent = s ? `${s.components} components, ${s.pads} pads, ${s.tracks} tracks, ${s.vias} vias\n${s.polygons} polygons, ${s.regions} poured regions` : '';
    $('empty').style.display = board ? 'none' : '';
    $('busy').style.display = board && board.loading ? 'flex' : 'none';
    label.style.display = 'none'; readout.textContent = '';
    $('measure-btn').classList.toggle('on', measuring); view.classList.toggle('measuring', measuring);
    document.querySelectorAll('.unit').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
    layersEl.replaceChildren();
    if (svg) { view.prepend(svg); buildLayers(); apply(); }
    updateTabs();
    if (board) $('view').setAttribute('aria-labelledby', 'board-tab-' + board.id);
    else $('view').removeAttribute('aria-labelledby');
  }
  function closeBoard(board) {
    const index = boards.indexOf(board);
    if (index < 0) return;
    board.controller?.abort();
    boards.splice(index, 1);
    if (board === activeBoard) mountBoard(boards[Math.min(index, boards.length - 1)] || null);
    else updateTabs();
    if (activeBoard) $('board-tab-' + activeBoard.id).focus();
  }
  function openFiles(files) {
    for (const file of files) {
      const board = createBoard(file);
      activateBoard(board);
      renderBoard(board);
    }
  }
  async function renderBoard(board) {
    if (board === activeBoard) saveBoard();
    board.controller?.abort();
    const controller = new AbortController(); board.controller = controller;
    const request = ++board.request;
    const options = board.options;
    const q = new URLSearchParams({ side: options.side, clip: options.clip ? 1 : 0,
                                   outlines: options.outlines ? 1 : 0, pour: options.pour.trim() });
    board.loading = true;
    updateTabs();
    if (board === activeBoard) $('busy').style.display = 'flex';
    try {
      const r = await fetch('/render?' + q, { method: 'POST', headers: { 'X-Filename': encodeURIComponent(board.file.name) }, body: board.file, signal: controller.signal });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      if (boards.includes(board) && request === board.request) show(board, data);
    } catch (e) {
      if (e.name !== 'AbortError' && boards.includes(board) && request === board.request) {
        toast('Could not render ' + board.name + ': ' + e.message);
        if (!board.svg) closeBoard(board);
      }
    } finally {
      if (boards.includes(board) && request === board.request) {
        board.loading = false; updateTabs();
        if (board === activeBoard) $('busy').style.display = 'none';
      }
    }
  }

  function show(board, data) {
    const tpl = document.createElement('div'); tpl.innerHTML = data.svg;
    const rendered = tpl.querySelector('svg');
    if (!rendered) throw new Error('The renderer did not return an SVG.');
    if (board === activeBoard) saveBoard();
    const b = rendered.viewBox.baseVal;
    const origin = { x: b.x, y: b.y, w: b.width, h: b.height };
    const previousLayers = new Map(board.groups.map(g => [g.id, g.style.display]));
    for (const g of rendered.querySelectorAll('#scene > g')) {
      g.style.display = previousLayers.has(g.id) ? previousLayers.get(g.id) : defaultLayerVisible(g) ? '' : 'none';
    }
    const measure = document.createElementNS(NS, 'g'); measure.id = 'measure'; rendered.append(measure);
    Object.assign(board, { svg: rendered, name: data.name, stats: data.stats, warnings: data.warnings || [], groups: [],
                           home: origin, vb: { ...origin }, pts: [], hover: null, mg: measure });
    if (board === activeBoard) mountBoard(board);
  }

  $('open').onclick = () => $('file').click();
  $('file').onchange = e => { openFiles(e.target.files); e.target.value = ''; };
  $('rerender').onclick = () => activeBoard ? renderBoard(activeBoard) : toast('Open a board first.');
  ['side', 'clip', 'outlines'].forEach(id => $(id).onchange = () => activeBoard && renderBoard(activeBoard));
  view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('drop'); });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('drop'); openFiles(e.dataTransfer.files); });

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 5000); }

  // ------------------------------------------------------------ layers
  function defaultLayerVisible(g) {
    const { layerRole: role, layerFamily: family, layerToken: token } = g.dataset;
    if (g.id === 'board-outline' || role === 'copper' || role === 'drill' ||
        family === 'signal' || family === 'internal_plane') return true;
    // Tokens stay stable even when the board gives layers custom display names.
    if (token) return /^(TOP|BOTTOM|MID\d+|PLANE\d+|TOPOVERLAY|DRILLS|DRILLDRAWING|DRILLGUIDE|MULTILAYER)$/i.test(token);
    return /^(layer-)?(top|bottom|mid\d+|plane\d+|topoverlay|drills|drilldrawing|drillguide|multilayer)$/i.test(g.id) ||
      /^(top copper|bottom copper|top overlay)$/i.test(g.dataset.layerName || '');
  }
  function buildLayers() {
    layersEl.innerHTML = '';
    // Keep the sidebar in renderer order even after changing SVG paint order.
    if (!groups.length) groups = [...svg.querySelectorAll('#scene > g')];
    for (const g of groups) {
      const name = g.dataset.layerDisplayName || g.dataset.layerName || g.id.replace(/^layer-/, '');
      const color = g.dataset.color || (g.id === 'board-outline' ? '#C0A000' : '#888');
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = g.style.display !== 'none';
      cb.onchange = () => {
        g.style.display = cb.checked ? '' : 'none';
        // SVG paints later siblings on top; retain the scene's transforms and clipping.
        if (cb.checked) g.parentNode.append(g);
      };
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
  fetch('/initial').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.svg) return;
    const file = new File([Uint8Array.from(atob(d.source), c => c.charCodeAt(0))], d.name);
    const board = createBoard(file);
    show(board, d);
    if (!activeBoard) activateBoard(board);
    else updateTabs();
  }).catch(e => toast('Could not load the initial board: ' + e.message));
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
        Handler.initial = {**render_file(args.pcbdoc),
                           "source": base64.b64encode(args.pcbdoc.read_bytes()).decode("ascii")}

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
