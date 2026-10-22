#!/usr/bin/env python3
"""
Standalone Altium PCB and schematic viewer.

    python pcb_viewer_gui.py                 # starts a local server and opens Chrome
    python pcb_viewer_gui.py board.PcbDoc    # ...and loads this board straight away
    python pcb_viewer_gui.py sheet.SchDoc    # ...or loads a schematic sheet
    python pcb_viewer_gui.py --browser default

Pick .PcbDoc or .SchDoc files with the "Open files" button (or drag & drop them onto the
page). Each document opens in its own tab. Everything runs locally; the file is parsed by altium-monkey on your
machine and only the rendered SVG is sent to the browser tab.

To cross-probe, open a schematic and its PCB, select components or nets, then
choose the target document and press "Show in layout" or "Show in schematic".

Requires:  pip install altium-monkey   (Python 3.12+)
"""

import argparse
import base64
from dataclasses import replace
from io import BytesIO
import json
import re
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
    from altium_monkey import AltiumDesign, AltiumPcbDoc, AltiumSchDoc, PcbSvgRenderOptions, SchSvgRenderOptions
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


def resolve_polygon_nets(pcb: AltiumPcbDoc) -> None:
    """Give poured copper its parent polygon's net in the parsed rendering copy."""
    def valid_index(index: int | None, size: int) -> bool:
        return isinstance(index, int) and 0 <= index < size and index not in (0xFFFF, 0xFFFFFFFF)

    for collection in ("regions", "shapebased_regions", "tracks", "arcs", "fills"):
        for primitive in getattr(pcb, collection, []):
            if valid_index(primitive.net_index, len(pcb.nets)):
                continue
            polygon_index = getattr(primitive, "polygon_index", None)
            if not valid_index(polygon_index, len(pcb.polygons)):
                continue
            net_index = pcb.polygons[polygon_index].net
            if valid_index(net_index, len(pcb.nets)):
                primitive.net_index = net_index


def schematic_selection(schematic: AltiumSchDoc) -> dict:
    """Link selectable source components and compiled nets to their SVG groups."""
    components = [
        {"id": component.record.unique_id, "name": component.designator or component.record.unique_id,
         "elements": [component.record.unique_id],
         "body_elements": [graphic.unique_id for graphic in component.record.graphics]}
        for component in schematic.get_components()
    ]
    nets = []
    # Logical nets retain wire-only and single-pin networks that manufacturing
    # netlist output may omit. Each tab contains one source sheet.
    for net in AltiumDesign(schdocs=[schematic]).compile().nets:
        if net.scope != "logical_local":
            continue
        elements = {item.element_id for item in net.items if not item.removed}
        nets.append({"id": f"net-{len(nets)}", "name": net.name, "elements": sorted(elements - {""}),
                     "aliases": list(net.aliases),
                     "terminals": [{"component": terminal.designator, "pin": terminal.pin} for terminal in net.terminals]})
    return {"components": components, "nets": nets}


def polygon_element_ids(pcb: AltiumPcbDoc, svg: str) -> list[str]:
    """Identify polygon pours without confusing unlinked regions with custom pads.

    The renderer's deterministic IDs encode primitive kind and collection index;
    one source primitive can appear on several layers in a surface rendering.
    Read IDs without reserializing SVG (including its embedded fonts and styles).
    """
    linked = set()
    for collection, kind in (("regions", "region"), ("shapebased_regions", "shapebased-region"),
                             ("tracks", "track"), ("arcs", "arc"), ("fills", "fill")):
        for index, primitive in enumerate(getattr(pcb, collection, [])):
            polygon_index = getattr(primitive, "polygon_index", None)
            if (isinstance(polygon_index, int) and 0 <= polygon_index < len(pcb.polygons)
                    and polygon_index not in (0xFFFF, 0xFFFFFFFF)):
                linked.add((kind, index))
    pattern = r'\bid="(pcb-(shapebased-region|region|track|arc|fill)-(\d+)(?:-[^"]*)?)"'
    return [element_id for element_id, kind, index in re.findall(pattern, svg) if (kind, int(index)) in linked]


def render_file(path: Path, side: str = "all", clip: bool = False,
                pour_color: str | None = None, polygon_outlines: bool = False) -> dict:
    if path.suffix.lower() == ".schdoc":
        schematic = AltiumSchDoc(path)
        return {
            "svg": schematic.to_svg(options=SchSvgRenderOptions(embed_bundled_fallback_fonts=True)),
            "name": path.name,
            "kind": "schematic",
            "selection": schematic_selection(schematic),
            "warnings": [],
            "stats": {
                "components": len(schematic.components),
                "wires": len(schematic.wires),
                "net_labels": len(schematic.net_labels),
            },
        }
    if path.suffix.lower() != ".pcbdoc":
        raise ValueError("Open an Altium .PcbDoc or .SchDoc file.")
    pcb = AltiumPcbDoc.from_file(path)
    warnings = prepare_embedded_fonts(pcb)
    resolve_polygon_nets(pcb)
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
        "kind": "pcb",
        "polygon_elements": polygon_element_ids(pcb, svg),
        "layout_components": [
            {"name": component.designator, "source_name": component.source_designator,
             "source_id": component.source_unique_id_segments[-1] if component.source_unique_id_segments else ""}
            for component in pcb.components
        ],
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
<html><head><meta charset="utf-8"><title>PCB &amp; schematic viewer</title>
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
  #component-query { min-width: 0; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text);
                     border: 1px solid var(--line); border-radius: 4px; padding: 5px; font: inherit; }
  #view svg.layout-selection #scene > :not(#component-highlight):not(#net-highlight) { filter: opacity(0.15); }
  #view svg.hide-polygons .polygon-copper { display: none !important; }
  button { background: #3a3e45; color: var(--text); border: 1px solid #4a4f58; border-radius: 4px;
           padding: 5px 8px; cursor: pointer; font: inherit; }
  button:hover { background: #474c56; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; width: 100%; }
  button.primary:hover { filter: brightness(1.1); }
  button.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .row button { flex: 1; }
  #layers label { display: flex; align-items: center; gap: 6px; padding: 3px 2px; cursor: pointer;
                  border-radius: 3px; user-select: none; }
  #layers label:hover { background: #2e3238; }
  .swatch { width: 12px; height: 12px; border-radius: 2px; flex: none; border: 1px solid #0006; }
  .count { margin-left: auto; color: var(--muted); font-size: 11px; }
  #net-query { min-width: 0; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text);
                     border: 1px solid var(--line); border-radius: 4px; padding: 5px; font: inherit; }
  #scene .sch-component-match [stroke]:not([stroke="none"]):not(.sch-hit) { stroke: #bd6100 !important; stroke-width: 2px !important; }
  #scene .sch-component-match text { fill: #bd6100 !important; }
  #scene .sch-net-match [stroke]:not([stroke="none"]):not(.sch-hit) { stroke: #007f9d !important; stroke-width: 3px !important; }
  #scene .sch-net-match [fill]:not([fill="none"]):not(.sch-hit) { fill: #007f9d !important; }
  #scene .sch-hit { stroke: transparent; fill: none; stroke-width: 10px; vector-effect: non-scaling-stroke; pointer-events: stroke; }
  #scene .sch-component-hit { fill: transparent; stroke: none; pointer-events: all; }
  #schematic-selection-status { white-space: pre-line; overflow-wrap: anywhere; margin-bottom: 6px; }
  #probe-layout, #probe-schematic { box-sizing: border-box; width: 100%; margin: 4px 0 6px; background: var(--bg); color: var(--text); padding: 4px; }
  #probe-status, #probe-schematic-status, #probe-result-status { white-space: pre-line; overflow-wrap: anywhere; margin-top: 6px; }
  #panel { overflow-y: auto; }
  #panel > * { flex-shrink: 0; }
  #layers-wrap { min-height: 160px; }
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
  #view svg { width: 100%; height: 100%; display: block; user-select: none; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           color: var(--muted); font-size: 15px; text-align: center; pointer-events: none; }
  #measure { pointer-events: none; }
  #measure line, #measure circle { vector-effect: non-scaling-stroke; stroke: var(--accent); stroke-width: 1.5; fill: none; }
  .measure-label { position: absolute; pointer-events: none; background: var(--accent); color: var(--accent-ink);
                   font: 12px ui-monospace, Consolas, monospace; padding: 2px 6px; border-radius: 3px;
                   transform: translate(-50%, -130%); white-space: nowrap; }
  #toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); background: #b23b3b; color: #fff;
           padding: 8px 14px; border-radius: 6px; display: none; max-width: 70%; }
  #busy { position: absolute; inset: 0; background: #0008; display: none; align-items: center; justify-content: center; }
</style></head><body>
<div id="app">
  <div id="panel">
    <div>
      <h1>PCB &amp; schematic viewer</h1>
      <input id="file" type="file" accept=".PcbDoc,.pcbdoc,.SchDoc,.schdoc" multiple hidden>
      <button class="primary" id="open">Open files…</button>
      <div class="row"><button id="zoom-out" aria-label="Zoom out" disabled>−</button><button id="zoom-in" aria-label="Zoom in" disabled>+</button><button id="view-fit" aria-label="Fit document" title="Fit document" disabled>Fit</button></div>
      <div id="filename">No document loaded</div>
      <div id="warnings" role="status" hidden></div>
    </div>
    <div data-pcb-only>
      <label for="component-query">Find component</label>
      <input id="component-query" type="search" list="component-options" placeholder="Designator, e.g. R12" title="Search by designator or click a component. Escape clears the selection." autocomplete="off" disabled>
      <datalist id="component-options"></datalist>
      <div class="row"><button id="component-clear">Clear</button><button id="component-fit" disabled>Fit matches</button></div>
      <button id="component-reveal" hidden>Show matching layers</button>
      <div id="component-status" class="hint" role="status"></div>
    </div>
    <div data-pcb-only>
      <label for="net-query">Find net</label>
      <input id="net-query" type="search" list="net-options" placeholder="Net name, e.g. GND" autocomplete="off" disabled>
      <datalist id="net-options"></datalist>
      <div class="row"><button id="net-clear">Clear</button><button id="net-fit" disabled>Fit matches</button></div>
      <button id="net-reveal" hidden>Show matching layers</button>
      <div id="net-status" class="hint" role="status"></div>
    </div>
    <div id="layers-wrap" data-pcb-only>
      <div class="row" style="margin:0 0 6px"><button id="all">Show all</button><button id="none">Hide all</button></div>
      <button id="polygons-toggle" aria-pressed="false" disabled>Hide polygons</button>
      <div id="layers"></div>
    </div>
    <div data-pcb-only>
      <div class="row" style="margin:0"><button id="measure-btn">Measure (M)</button>
        <button data-unit="mm" class="on unit">mm</button><button data-unit="mil" class="unit">mil</button><button data-unit="in" class="unit">in</button></div>
      <div id="readout"></div>
      <div class="hint">Click copper to select a net. Scroll with two fingers or drag to pan. Pinch or Ctrl+scroll to zoom. Double-click to reset. Measure: click two points. Esc exits measurement mode and deselects the net; Shift+C clears all measurements.</div>
    </div>
    <div id="schematic-selection" hidden>
      <label>Selection</label>
      <div id="schematic-selection-status" role="status"></div>
      <button id="schematic-clear" disabled>Clear selection (Esc)</button>
      <label for="probe-layout" style="display:block;margin-top:10px">Layout</label>
      <select id="probe-layout" disabled></select>
      <button id="probe-layout-btn" disabled>Show in layout</button>
      <div id="probe-status" class="hint" role="status"></div>
    </div>
    <div data-pcb-only>
      <label for="probe-schematic">Schematic</label>
      <select id="probe-schematic" disabled></select>
      <button id="probe-schematic-btn" disabled>Show in schematic</button>
      <div id="probe-schematic-status" class="hint" role="status"></div>
    </div>
    <div id="probe-result" hidden>
      <div id="probe-result-status" role="status"></div>
      <button id="probe-back">Back to schematic</button>
    </div>
    <div id="schematic-hint" class="hint" hidden>Click a component or net to select it. Shift-click to add to the selection. Esc clears the selection. Scroll with two fingers or drag to pan. Pinch or Ctrl+scroll to zoom. Double-click to reset.</div>
    <div id="stats"></div>
  </div>
  <div id="workspace">
    <div id="tabs" role="tablist" aria-label="Open documents"></div>
    <div id="view" role="tabpanel" aria-label="Document view">
      <div id="empty">Open .PcbDoc or .SchDoc files<br>or drop them here</div>
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
  function saveBoard() {
    if (!activeBoard) return;
    Object.assign(activeBoard, { svg, groups, vb, home, unit, measuring, pts, measurements, hover, mg });
  }
  function createBoard(file, name = file.name) {
    const board = { id: nextBoardId++, file, name, stats: null, warnings: [],
                    svg: null, groups: [], vb: null, home: null, unit: 'mm', measuring: false,
                    pts: [], measurements: [], hover: null, mg: null, loading: false, request: 0 };
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
    updateProbeTargets();
    updateProbeResult();
  }
  function activateBoard(board) {
    saveBoard();
    mountBoard(board);
  }
  function mountBoard(board) {
    cancelViewUpdate();
    if (svg) svg.remove();
    activeBoard = board; drag = null; gestureScale = null;
    ({ svg, groups, vb, home, unit, measuring, pts, measurements, hover, mg } = board || {
      svg: null, groups: [], vb: null, home: null, unit: 'mm', measuring: false, pts: [], measurements: [], hover: null, mg: null,
    });
    $('filename').textContent = board ? board.name : 'No document loaded';
    for (const id of ['zoom-in', 'zoom-out', 'view-fit']) $(id).disabled = !svg;
    const schematic = board?.kind === 'schematic';
    document.querySelectorAll('[data-pcb-only]').forEach(el => { el.hidden = schematic; });
    $('schematic-selection').hidden = !schematic;
    $('schematic-hint').hidden = !schematic;
    $('warnings').textContent = board ? board.warnings.join('\n') : '';
    $('warnings').hidden = !$('warnings').textContent;
    const s = board && board.stats;
    $('stats').textContent = !s ? '' : schematic ?
      `${s.components} components, ${s.wires} wires, ${s.net_labels} net labels` :
      `${s.components} components, ${s.pads} pads, ${s.tracks} tracks, ${s.vias} vias\n${s.polygons} polygons, ${s.regions} poured regions`;
    $('empty').style.display = board ? 'none' : '';
    $('busy').style.display = board && board.loading ? 'flex' : 'none';
    label.replaceChildren(); readout.textContent = '';
    $('measure-btn').classList.toggle('on', measuring); view.classList.toggle('measuring', measuring);
    document.querySelectorAll('.unit').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
    layersEl.replaceChildren();
    if (svg) {
      view.prepend(svg);
      if (schematic) buildSchematicComponentTargets(board);
      else buildLayers();
      apply();
    }
    updatePolygonControl();
    mountNetSearch();
    updateTabs();
    mountComponentSearch();
    updateSchematicSelection();
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
    board.loading = true;
    updateTabs();
    if (board === activeBoard) $('busy').style.display = 'flex';
    try {
      const r = await fetch('/render', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(board.file.name) }, body: board.file, signal: controller.signal });
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
    // Schematic groups are drawing containers, not PCB layers.
    const kind = data.kind || 'pcb';
    const polygonIds = new Set(data.polygon_elements || []);
    if (kind === 'pcb') for (const el of rendered.querySelectorAll('#scene [id], #scene [data-primitive]')) {
      if (polygonIds.has(el.id) || ['polygon-outline', 'polygon-cutout'].includes(el.dataset.primitive)) el.classList.add('polygon-copper');
    }
    for (const g of kind === 'pcb' ? rendered.querySelectorAll('#scene > g') : []) {
      g.style.display = previousLayers.has(g.id) ? previousLayers.get(g.id) : defaultLayerVisible(g) ? '' : 'none';
    }
    const measure = document.createElementNS(NS, 'g'); measure.id = 'measure'; rendered.append(measure);
    Object.assign(board, { svg: rendered, name: data.name, kind, stats: data.stats, warnings: data.warnings || [], groups: [],
                           layoutComponents: data.layout_components || [],
                           home: origin, vb: { ...origin }, pts: [], measurements: [], hover: null, mg: measure });
    if (kind === 'schematic') prepareSchematicSelection(board, data.selection);
    if (board === activeBoard) mountBoard(board);
  }

  $('open').onclick = () => $('file').click();
  $('file').onchange = e => { openFiles(e.target.files); e.target.value = ''; };
  view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('drop'); });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('drop'); openFiles(e.dataTransfer.files); });

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 5000); }

  // ------------------------------------------------------------ schematic selection
  function prepareSchematicSelection(board, selection = {}) {
    // Resolve IDs within this SVG only. Source IDs and names need no CSS escaping.
    const elements = new Map([...board.svg.querySelectorAll('#scene [id]')].map(el => [el.id, el]));
    function index(rows, attribute) {
      const result = new Map();
      for (const row of rows || []) {
        const targets = row.elements.map(id => elements.get(id)).filter(Boolean);
        if (!targets.length) continue;
        result.set(row.id, { name: row.name, elements: targets,
          aliases: row.aliases || [], terminals: row.terminals || [],
          bodyElements: (row.body_elements || []).map(id => elements.get(id)).filter(Boolean) });
        for (const el of targets) {
          const ids = JSON.parse(el.getAttribute(attribute) || '[]');
          el.setAttribute(attribute, JSON.stringify([...new Set([...ids, row.id])]));
        }
      }
      return result;
    }
    board.schematicComponents = index(selection.components, 'data-sch-components');
    board.schematicNets = index(selection.nets, 'data-sch-nets');
    board.selectedComponents = new Set(); board.selectedNets = new Set();
    // Give thin wires and pins a usable screen-space click target without changing their drawing.
    for (const el of board.svg.querySelectorAll('[data-sch-nets] line, [data-sch-nets] path, [data-sch-nets] polyline')) {
      const hit = el.cloneNode(false);
      for (const attr of [...hit.attributes]) if (attr.name === 'id' || attr.name.startsWith('data-')) hit.removeAttribute(attr.name);
      hit.removeAttribute('style'); hit.setAttribute('class', 'sch-hit');
      hit.setAttribute('aria-hidden', 'true'); el.before(hit);
    }
  }
  function buildSchematicComponentTargets(board) {
    // getBBox/CTM require the SVG to be mounted. Work in each component's local
    // coordinates so rotated/mirrored symbol graphics keep their correct bounds.
    for (const row of board.schematicComponents.values()) for (const component of row.elements) {
      if (component.querySelector('.sch-component-hit')) continue;
      const points = [];
      const inverse = component.getScreenCTM().inverse();
      for (const graphic of row.bodyElements) {
        if (!component.contains(graphic)) continue;
        const b = graphic.getBBox(), transform = inverse.multiply(graphic.getScreenCTM());
        if (!b.width && !b.height) continue;
        for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]])
          points.push(new DOMPoint(x, y).matrixTransform(transform));
      }
      if (!points.length) continue;
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      const hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('x', x); hit.setAttribute('y', y);
      hit.setAttribute('width', Math.max(Math.max(...xs) - x, 1));
      hit.setAttribute('height', Math.max(Math.max(...ys) - y, 1));
      hit.setAttribute('class', 'sch-component-hit'); hit.setAttribute('aria-hidden', 'true');
      // Above the symbol's own pin hit targets, within the symbol body only.
      component.append(hit);
    }
  }
  function updateSchematicSelection() {
    if (activeBoard?.kind !== 'schematic') return;
    const board = activeBoard;
    for (const [index, selected, cls] of [
      [board.schematicComponents, board.selectedComponents, 'sch-component-match'],
      [board.schematicNets, board.selectedNets, 'sch-net-match'],
    ]) {
      const matched = new Set([...selected].flatMap(id => index.get(id).elements));
      for (const row of index.values()) for (const el of row.elements) el.classList.toggle(cls, matched.has(el));
    }
    const names = (selected, index) => [...selected].map(id => index.get(id).name).join(', ');
    const selected = [];
    if (board.selectedComponents.size) selected.push('Components: ' + names(board.selectedComponents, board.schematicComponents));
    if (board.selectedNets.size) selected.push('Nets: ' + names(board.selectedNets, board.schematicNets));
    $('schematic-selection-status').textContent = selected.join('\n') || 'Nothing selected.';
    $('schematic-clear').disabled = !selected.length;
    updateProbeTargets();
  }
  function clearSchematicSelection() {
    if (activeBoard?.kind !== 'schematic') return;
    activeBoard.selectedComponents.clear(); activeBoard.selectedNets.clear();
    activeBoard.probeMessage = ''; activeBoard.probeResult = null; updateProbeResult();
    updateSchematicSelection();
  }
  function selectSchematic(e) {
    const net = e.target.closest('#scene [data-sch-nets]');
    const component = e.target.closest('#scene [data-sch-components]');
    if (!e.shiftKey) clearSchematicSelection();
    activeBoard.probeMessage = ''; activeBoard.probeResult = null; updateProbeResult();
    // A pin selects its net; clicking the symbol body selects the component.
    const target = net || component;
    if (target && svg.contains(target)) {
      const selected = net ? activeBoard.selectedNets : activeBoard.selectedComponents;
      for (const id of JSON.parse(target.getAttribute(net ? 'data-sch-nets' : 'data-sch-components'))) selected.add(id);
    }
    updateSchematicSelection();
  }
  $('schematic-clear').onclick = clearSchematicSelection;

  // ------------------------------------------------------------ cross-probing
  const identity = value => String(value || '').trim().toLowerCase();
  function updateProbeTargets() {
    const source = activeBoard;
    const fromSchematic = source?.kind === 'schematic';
    const kind = fromSchematic ? 'pcb' : 'schematic', noun = fromSchematic ? 'layout' : 'schematic';
    const select = $(fromSchematic ? 'probe-layout' : 'probe-schematic');
    const button = $(fromSchematic ? 'probe-layout-btn' : 'probe-schematic-btn');
    const status = $(fromSchematic ? 'probe-status' : 'probe-schematic-status');
    const targets = boards.filter(board => board.kind === kind && board.svg && !board.loading);
    if (source && !targets.some(board => board.id === source.probeTargetId))
      source.probeTargetId = targets.length === 1 ? targets[0].id : null;
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = targets.length ? 'Choose a ' + noun + '…' : 'No ' + noun + ' open';
    select.replaceChildren(empty, ...targets.map(board => {
      const option = document.createElement('option'); option.value = board.id; option.textContent = board.name; return option;
    }));
    select.value = source?.probeTargetId || '';
    select.disabled = !targets.length || !source?.svg;
    const selected = fromSchematic ? source.selectedComponents.size + source.selectedNets.size : componentHits.length + netHits.length;
    button.disabled = !source?.svg || !selected || !source.probeTargetId;
    status.textContent = !source?.svg ? '' : source.probeMessage || (!targets.length ?
      'Open a ' + (fromSchematic ? '.PcbDoc layout' : '.SchDoc schematic') + ' to cross-probe.' :
      !selected ? 'Select ' + (fromSchematic ? 'schematic' : 'layout') + ' components or nets.' : !source.probeTargetId ? 'Choose the ' + noun + ' to probe.' : '');
  }
  function updateProbeResult() {
    const result = activeBoard?.probeResult;
    $('probe-result').hidden = !result;
    $('probe-result-status').textContent = result?.message || '';
    $('probe-back').disabled = !result || !boards.some(board => board.id === result.sourceId);
    $('probe-back').textContent = activeBoard?.kind === 'schematic' ? 'Back to layout' : 'Back to schematic';
  }
  $('probe-layout').onchange = () => {
    activeBoard.probeTargetId = Number($('probe-layout').value) || null;
    activeBoard.probeMessage = ''; updateProbeTargets();
  };
  $('probe-schematic').onchange = () => {
    activeBoard.probeTargetId = Number($('probe-schematic').value) || null;
    activeBoard.probeMessage = ''; updateProbeTargets();
  };
  $('probe-back').onclick = () => {
    const source = boards.find(board => board.id === activeBoard?.probeResult?.sourceId);
    if (source) activateBoard(source);
  };
  function matchingComponents(sourceId, row, layout, names) {
    const linked = layout.layoutComponents.filter(component => sourceId && component.source_id && identity(component.source_id) === identity(sourceId));
    if (linked.length) return [...names].filter(name => linked.some(component => identity(component.name) === identity(name)));
    return [...names].filter(name => {
      const link = layout.layoutComponents.find(component => identity(component.name) === identity(name));
      // An explicit link to another source symbol must not match by designator.
      if (sourceId && link?.source_id) return false;
      return identity(link?.source_name || name) === identity(row.name);
    });
  }
  const padKey = (component, pin) => JSON.stringify([identity(component), identity(pin)]);
  function layoutConnections(layout) {
    const primitives = [...layout.svg.querySelectorAll('#scene [data-component], #scene [data-net]')];
    const names = new Set(primitives.map(el => el.dataset.component).filter(Boolean));
    const netNames = new Set(primitives.map(el => el.dataset.net).filter(Boolean));
    const padNets = new Map();
    for (const el of primitives) {
      const { component, padNumber, padDesignator, net } = el.dataset;
      if (!component || !(padNumber || padDesignator) || !net) continue;
      const key = padKey(component, padNumber || padDesignator);
      if (!padNets.has(key)) padNets.set(key, new Set());
      padNets.get(key).add(net);
    }
    return { names, netNames, padNets };
  }
  function matchingNets(row, schematic, layout, { names, netNames, padNets }) {
    const byPins = new Set();
    for (const terminal of row.terminals) {
      if (!terminal.component || !terminal.pin) continue;
      const component = [...schematic.schematicComponents].find(([, item]) => identity(item.name) === identity(terminal.component));
      const matches = matchingComponents(component?.[0] || '', component?.[1] || { name: terminal.component }, layout, names);
      for (const name of matches) for (const net of padNets.get(padKey(name, terminal.pin)) || []) byPins.add(net);
    }
    return byPins.size ? [...byPins] : [...netNames].filter(name =>
      [row.name, ...row.aliases].some(alias => identity(alias) === identity(name)));
  }
  function probeResult(source, components, nets, unmatched) {
    return { sourceId: source.id,
      message: 'From ' + source.name + ': ' + components.size + ' component' + (components.size === 1 ? '' : 's') +
        ', ' + nets.size + ' net' + (nets.size === 1 ? '' : 's') + ' highlighted.' + unmatched };
  }
  $('probe-layout-btn').onclick = () => {
    const source = activeBoard;
    const layout = boards.find(board => board.id === source?.probeTargetId && board.kind === 'pcb' && board.svg && !board.loading);
    if (source?.kind !== 'schematic' || !layout) return;
    const connections = layoutConnections(layout), { names } = connections;
    const components = new Set(), nets = new Set(), missing = [];
    const resolveComponent = (id, row) => matchingComponents(id, row, layout, names);
    for (const id of source.selectedComponents) {
      const row = source.schematicComponents.get(id), matches = resolveComponent(id, row);
      if (matches.length) matches.forEach(name => components.add(name));
      else missing.push('component ' + row.name);
    }
    for (const id of source.selectedNets) {
      const row = source.schematicNets.get(id);
      const matches = matchingNets(row, source, layout, connections);
      if (matches.length === 1) nets.add(matches[0]);
      else missing.push('net ' + row.name + (matches.length > 1 ? ' (ambiguous)' : ''));
    }
    const unmatched = missing.length ? '\nNot found: ' + missing.join(', ') : '';
    if (!components.size && !nets.size) {
      source.probeMessage = 'No matches in ' + layout.name + '.' + unmatched; updateProbeTargets(); return;
    }
    layout.probeComponents = [...components]; layout.probeNets = [...nets];
    layout.componentQuery = [...components].join(', '); layout.netQuery = [...nets].join(', ');
    layout.probeResult = probeResult(source, components, nets, unmatched);
    activateBoard(layout); setMeasuring(false);
    const hits = [...componentHits, ...netHits];
    for (const group of groups) if (group.style.display === 'none' && hits.some(el => group.contains(el))) group._cb.click();
    fitMatches(hits);
  };
  $('probe-schematic-btn').onclick = () => {
    const source = activeBoard;
    const target = boards.find(board => board.id === source?.probeTargetId && board.kind === 'schematic' && board.svg && !board.loading);
    if (source?.kind !== 'pcb' || !target) return;
    const connections = layoutConnections(source);
    const components = new Set(), nets = new Set(), missing = [];
    for (const name of new Set(componentHits.map(el => el.dataset.component))) {
      const link = source.layoutComponents.find(component => identity(component.name) === identity(name));
      const matches = [...target.schematicComponents].filter(([id, row]) => link?.source_id ?
        identity(id) === identity(link.source_id) : identity(row.name) === identity(link?.source_name || name));
      if (matches.length) matches.forEach(([id]) => components.add(id));
      else missing.push('component ' + name);
    }
    const netMatches = [...target.schematicNets].map(([id, row]) => [id, matchingNets(row, target, source, connections)]);
    for (const name of new Set(netHits.map(el => el.dataset.net))) {
      const matches = netMatches.filter(([, names]) => names.length === 1 && names[0] === name);
      if (matches.length) matches.forEach(([id]) => nets.add(id));
      else missing.push('net ' + name + (netMatches.some(([, names]) => names.includes(name)) ? ' (ambiguous)' : ''));
    }
    const unmatched = missing.length ? '\nNot found: ' + missing.join(', ') : '';
    if (!components.size && !nets.size) {
      source.probeMessage = 'No matches in ' + target.name + '.' + unmatched; updateProbeTargets(); return;
    }
    target.selectedComponents = components; target.selectedNets = nets; target.probeMessage = '';
    target.probeResult = probeResult(source, components, nets, unmatched);
    activateBoard(target);
    const hits = [...components].flatMap(id => target.schematicComponents.get(id).elements)
      .concat([...nets].flatMap(id => target.schematicNets.get(id).elements));
    fitMatches(hits);
  };
  function resetProbeSelection(kind) {
    if (!activeBoard) return;
    activeBoard[kind] = null; activeBoard.probeResult = null; activeBoard.probeMessage = ''; updateProbeResult();
  }

  // ------------------------------------------------------------ layout highlight drawing
  function buildLayoutHighlight(id, hits, color) {
    svg?.querySelector('#' + id)?.remove();
    const overlay = document.createElementNS(NS, 'g'); overlay.id = id;
    overlay.style.pointerEvents = 'none';
    const hiddenPolygon = el => activeBoard?.polygonsHidden && el.closest('.polygon-copper');
    const visibleHits = hits.filter(el => !hiddenPolygon(el));
    const matched = new Set(visibleHits), branches = new Set();
    for (const el of visibleHits) for (let node = el; node && node.id !== 'scene'; node = node.parentElement) branches.add(node);
    function tintedCopy(node) {
      const copy = node.cloneNode(true);
      const originals = [node, ...node.querySelectorAll('*')], copies = [copy, ...copy.querySelectorAll('*')];
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i], clone = copies[i];
        // Drill cutouts keep their paint. Tinting them would fill pad/via holes.
        if (!original.matches('path, rect, circle, ellipse, line, polyline, polygon, text, tspan, use') ||
            original.closest('[data-hole-owner], [data-primitive$="-hole"]')) continue;
        const paint = getComputedStyle(original);
        for (const property of ['fill', 'stroke']) {
          const value = paint[property];
          clone.style.setProperty(property, ['none', 'transparent', 'rgba(0, 0, 0, 0)'].includes(value) ? value : color, 'important');
        }
        clone.style.setProperty('stroke-width', paint.strokeWidth, 'important');
      }
      return copy;
    }
    function branch(node) {
      if (matched.has(node)) return tintedCopy(node);
      const copy = node.cloneNode(false);
      for (const child of node.children) if (branches.has(child)) copy.append(branch(child));
      return copy;
    }
    // Keep the renderer's transforms, clipping, widths, and shape geometry.
    // Only the original layer groups are faded; these copies stay at full opacity.
    for (const group of groups) if (group.style.display !== 'none' && branches.has(group)) overlay.append(branch(group));
    for (const el of overlay.querySelectorAll('*')) {
      el.removeAttribute('id'); el.classList.remove('component-match', 'net-match');
      for (const attr of [...el.attributes]) if (attr.name.startsWith('data-')) el.removeAttribute(attr.name);
    }
    if (overlay.childElementCount) svg.querySelector('#scene').append(overlay);
    svg?.classList.toggle('layout-selection', Boolean(svg.querySelector('#component-highlight, #net-highlight')));
    return { overlay, hidden: groups.filter(group => group.style.display === 'none' && branches.has(group)).length,
      hiddenPolygons: hits.some(hiddenPolygon) };
  }

  // ------------------------------------------------------------ component search
  let componentIndex = new Map(), componentHits = [];
  function mountComponentSearch() {
    componentIndex = new Map(); componentHits = [];
    for (const el of svg?.querySelectorAll('#scene [data-component]') || []) {
      const name = el.dataset.component;
      if (!name) continue;
      if (!componentIndex.has(name)) componentIndex.set(name, []);
      componentIndex.get(name).push(el);
    }
    $('component-options').replaceChildren(...[...componentIndex.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => {
      const option = document.createElement('option'); option.value = name; return option;
    }));
    $('component-query').disabled = !svg;
    $('component-query').value = activeBoard?.componentQuery || '';
    searchComponents();
  }
  function searchComponents() {
    for (const el of componentHits) el.classList.remove('component-match');
    componentHits = [];
    const query = $('component-query').value.trim().toLowerCase();
    if (activeBoard) activeBoard.componentQuery = $('component-query').value;
    const names = [...componentIndex.keys()];
    const exact = names.find(name => name.toLowerCase() === query);
    const matches = activeBoard?.probeComponents || (query ? names.filter(name => exact ? name === exact : name.toLowerCase().includes(query)) : []);
    componentHits = matches.flatMap(name => componentIndex.get(name));
    for (const el of componentHits) el.classList.add('component-match');
    updateComponentStatus(matches.length);
    updateProbeTargets();
  }
  function updateComponentStatus(count = new Set(componentHits.map(el => el.dataset.component)).size) {
    const { overlay, hidden, hiddenPolygons } = buildLayoutHighlight('component-highlight', componentHits, '#ffe066');
    $('component-fit').disabled = !overlay.childElementCount;
    $('component-reveal').hidden = !hidden;
    $('component-status').textContent = !$('component-query').value.trim() ? '' : !count ? 'No matching components.' :
      `${count} component${count === 1 ? '' : 's'} ${hiddenPolygons && !overlay.childElementCount ? 'matched' : 'highlighted'}` +
      (hidden ? `; ${hidden} hidden layer${hidden === 1 ? '' : 's'}` : '') + (hiddenPolygons ? '; polygons hidden.' : '.');
  }
  function clearComponent() { resetProbeSelection('probeComponents'); $('component-query').value = ''; searchComponents(); }
  $('component-query').oninput = () => { resetProbeSelection('probeComponents'); searchComponents(); };
  $('component-clear').onclick = clearComponent;
  $('component-fit').onclick = () => fitMatches(componentHits);
  function fitMatches(hits) {
    const rects = hits.map(el => el.getBoundingClientRect()).filter(r => r.width || r.height);
    if (!rects.length) return;
    const bounds = rects.reduce((b, r) => ({ left: Math.min(b.left, r.left), top: Math.min(b.top, r.top),
      right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom) }), rects[0]);
    const a = toSvg({ clientX: bounds.left, clientY: bounds.top });
    const b = toSvg({ clientX: bounds.right, clientY: bounds.bottom });
    const pad = Math.max(b.x - a.x, b.y - a.y, 2) * 0.25;
    vb = { x: a.x - pad, y: a.y - pad, w: b.x - a.x + 2 * pad, h: b.y - a.y + 2 * pad }; apply();
  }
  $('component-reveal').onclick = () => {
    for (const g of groups) if (g.style.display === 'none' && componentHits.some(el => g.contains(el))) g._cb.click();
    updateComponentStatus();
  };

  // ------------------------------------------------------------ layers
  function updatePolygonControl() {
    const hidden = Boolean(activeBoard?.polygonsHidden);
    svg?.classList.toggle('hide-polygons', hidden);
    $('polygons-toggle').textContent = hidden ? 'Show polygons' : 'Hide polygons';
    $('polygons-toggle').setAttribute('aria-pressed', String(hidden));
    $('polygons-toggle').disabled = activeBoard?.kind !== 'pcb' || !svg?.querySelector('.polygon-copper');
  }
  $('polygons-toggle').onclick = () => {
    if (activeBoard?.kind !== 'pcb' || !svg) return;
    activeBoard.polygonsHidden = !activeBoard.polygonsHidden;
    updatePolygonControl(); updateComponentStatus(); updateNetStatus();
  };
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
        updateComponentStatus();
      };
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color;
      lab.append(cb, sw, document.createTextNode(name));
      if (g.dataset.primitiveCount !== undefined) { const c = document.createElement('span'); c.className = 'count'; c.textContent = g.dataset.primitiveCount; lab.append(c); }
      layersEl.append(lab); g._cb = cb;
    }
  }
  const setAll = v => { groups.forEach(g => { g._cb.checked = v; g.style.display = v ? '' : 'none'; }); updateComponentStatus(); };
  $('all').onclick = () => setAll(true);
  $('none').onclick = () => setAll(false);

  // ------------------------------------------------------------ net search
  let netIndex = new Map(), netHits = [];
  function mountNetSearch() {
    netIndex = new Map(); netHits = [];
    for (const el of svg?.querySelectorAll('#scene [data-net]') || []) {
      const name = el.dataset.net;
      if (!name) continue;
      if (!netIndex.has(name)) netIndex.set(name, []);
      netIndex.get(name).push(el);
    }
    $('net-options').replaceChildren(...[...netIndex.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => {
      const option = document.createElement('option'); option.value = name; return option;
    }));
    $('net-query').disabled = !svg;
    $('net-query').value = activeBoard?.netQuery || '';
    searchNets();
  }
  function searchNets() {
    for (const el of netHits) el.classList.remove('net-match');
    netHits = [];
    const query = $('net-query').value.trim().toLowerCase();
    if (activeBoard) activeBoard.netQuery = $('net-query').value;
    const names = [...netIndex.keys()];
    const exact = names.find(name => name.toLowerCase() === query);
    const matches = activeBoard?.probeNets || (query ? names.filter(name => exact ? name === exact : name.toLowerCase().includes(query)) : []);
    netHits = matches.flatMap(name => netIndex.get(name));
    for (const el of netHits) el.classList.add('net-match');
    updateNetStatus(matches.length);
    updateProbeTargets();
  }
  function updateNetStatus(count = new Set(netHits.map(el => el.dataset.net)).size) {
    const { overlay, hidden, hiddenPolygons } = buildLayoutHighlight('net-highlight', netHits, '#68e0ff');
    $('net-fit').disabled = !overlay.childElementCount;
    $('net-reveal').hidden = !hidden;
    $('net-status').textContent = !$('net-query').value.trim() ? '' : !count ? 'No matching nets.' :
      `${count} net${count === 1 ? '' : 's'} ${hiddenPolygons && !overlay.childElementCount ? 'matched' : 'highlighted'}` +
      (hidden ? `; ${hidden} hidden layer${hidden === 1 ? '' : 's'}` : '') + (hiddenPolygons ? '; polygons hidden.' : '.');
  }
  function clearNet() { resetProbeSelection('probeNets'); $('net-query').value = ''; searchNets(); }
  $('net-query').oninput = () => { resetProbeSelection('probeNets'); searchNets(); };
  $('net-clear').onclick = clearNet;
  view.addEventListener('click', e => {
    if (!svg || measuring || panned || e.button !== 0) return;
    if (activeBoard.kind === 'schematic') { selectSchematic(e); return; }
    const primitive = e.target.closest('#scene [data-net]');
    const name = primitive?.dataset.net;
    if (name && svg.contains(primitive) && netIndex.has(name)) {
      resetProbeSelection('probeNets');
      $('net-query').value = name;
      searchNets();
    }
    const component = e.target.closest('#scene [data-component]');
    const designator = component?.dataset.component;
    if (designator && svg.contains(component) && componentIndex.has(designator)) {
      resetProbeSelection('probeComponents');
      $('component-query').value = designator;
      searchComponents();
    }
  });
  $('net-fit').onclick = () => fitMatches(netHits);
  $('net-reveal').onclick = () => {
    for (const g of groups) if (g.style.display === 'none' && netHits.some(el => g.contains(el))) g._cb.click();
    updateNetStatus();
  };

  layersEl.addEventListener('change', () => updateNetStatus());
  $('all').addEventListener('click', () => updateNetStatus());
  $('none').addEventListener('click', () => updateNetStatus());

  // ------------------------------------------------------------ pan / zoom
  let viewFrame = 0, drag = null, panned = false, gestureScale = null;
  function cancelViewUpdate() { cancelAnimationFrame(viewFrame); viewFrame = 0; }
  function apply(redrawMeasurements = true) {
    cancelViewUpdate();
    if (!svg) return;
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    if (redrawMeasurements) draw(); else positionMeasurementLabels();
  }
  function queueViewUpdate() {
    if (!viewFrame) viewFrame = requestAnimationFrame(() => { viewFrame = 0; apply(false); });
  }
  function viewPoint(e) {
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const shown = svg.viewBox.baseVal;
    // Input can arrive several times before the next animation frame. Account
    // for the pending viewBox while using the actual SVG letterbox transform.
    return { x: vb.x + (point.x - shown.x) * vb.w / shown.width,
             y: vb.y + (point.y - shown.y) * vb.h / shown.height };
  }
  function screenUnits() {
    const inverse = svg.getScreenCTM().inverse(), ratio = vb.w / svg.viewBox.baseVal.width;
    return { a: inverse.a * ratio, b: inverse.b * ratio, c: inverse.c * ratio, d: inverse.d * ratio };
  }
  function centerPoint() {
    const r = view.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }
  function zoomAt(point, factor) {
    if (!svg || !Number.isFinite(factor) || factor <= 0) return;
    const span = Math.max(vb.w, vb.h), base = Math.max(home.w, home.h);
    const k = Math.max(base * 0.0001, Math.min(base * 100, span * factor)) / span;
    const anchor = viewPoint(point);
    vb = { x: anchor.x - (anchor.x - vb.x) * k, y: anchor.y - (anchor.y - vb.y) * k,
           w: vb.w * k, h: vb.h * k };
    queueViewUpdate();
  }
  function resetView() { if (svg) { drag = null; vb = { ...home }; apply(); } }
  $('zoom-in').onclick = () => zoomAt(centerPoint(), 1 / 1.25);
  $('zoom-out').onclick = () => zoomAt(centerPoint(), 1.25);
  $('view-fit').onclick = resetView;
  view.addEventListener('wheel', e => {
    if (!svg) return;
    e.preventDefault();
    if (gestureScale !== null || !Number.isFinite(e.deltaX) || !Number.isFinite(e.deltaY)) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e, Math.exp(Math.max(-100, Math.min(100, e.deltaY * unit)) * 0.01));
    } else {
      const scale = screenUnits(), dx = e.deltaX * unit, dy = e.deltaY * unit;
      vb.x += scale.a * dx + scale.c * dy; vb.y += scale.b * dx + scale.d * dy;
      queueViewUpdate();
    }
  }, { passive: false });
  // Safari exposes native pinch gestures separately from wheel events.
  view.addEventListener('gesturestart', e => {
    if (!svg) return; e.preventDefault(); gestureScale = e.scale > 0 ? e.scale : 1;
  }, { passive: false });
  view.addEventListener('gesturechange', e => {
    if (!svg || gestureScale === null || !Number.isFinite(e.scale) || e.scale <= 0) return;
    e.preventDefault();
    const point = Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? e : centerPoint();
    zoomAt(point, gestureScale / e.scale); gestureScale = e.scale;
  }, { passive: false });
  view.addEventListener('gestureend', e => { if (gestureScale !== null) e.preventDefault(); gestureScale = null; }, { passive: false });
  view.addEventListener('mousedown', e => {
    panned = false;
    if (svg && (e.button === 1 || e.button === 0 && !measuring)) {
      if (e.button === 1) e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, scale: screenUnits() };
    }
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, scale = drag.scale;
    if (Math.hypot(dx, dy) > 3) panned = true;
    vb.x = drag.vx - scale.a * dx - scale.c * dy; vb.y = drag.vy - scale.b * dx - scale.d * dy;
    queueViewUpdate();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  window.addEventListener('blur', () => { drag = null; gestureScale = null; });
  view.addEventListener('dblclick', e => { if (e.button === 0 && !measuring) resetView(); });

  // ------------------------------------------------------------ measuring (SVG units are mm)
  const UNITS = { mm: { f: 1, d: 3 }, mil: { f: 1000 / 25.4, d: 1 }, in: { f: 1 / 25.4, d: 4 } };
  let unit = 'mm', measuring = false, pts = [], measurements = [], hover = null, mg = null;
  const fmt = v => (v * UNITS[unit].f).toFixed(UNITS[unit].d) + ' ' + unit;
  const toSvg = e => viewPoint(e);
  const toScreen = p => { const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM()); const r = view.getBoundingClientRect(); return { x: q.x - r.left, y: q.y - r.top }; };
  function dot(p) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 0.3); return c; }
  function positionMeasurementLabels() {
    if (!svg || !label.childElementCount) return;
    const segments = [...measurements];
    if (pts.length && hover) segments.push([pts[0], hover]);
    for (let i = 0; i < segments.length; i++) {
      const [a, b] = segments[i], caption = label.children[i];
      if (!caption) continue;
      const point = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      caption.style.left = point.x + 'px'; caption.style.top = point.y + 'px';
    }
  }
  function draw() {
    if (!mg) return;
    mg.replaceChildren(); label.replaceChildren();
    const segments = [...measurements];
    if (pts.length && hover) segments.push([pts[0], hover]);
    if (pts.length) mg.append(dot(pts[0]));
    for (const [a, b] of segments) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
      mg.append(l, dot(a), dot(b));
      const m = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const caption = document.createElement('div'); caption.className = 'measure-label';
      caption.textContent = fmt(Math.hypot(b.x - a.x, b.y - a.y));
      caption.style.left = m.x + 'px'; caption.style.top = m.y + 'px'; label.append(caption);
    }
    const latest = segments.at(-1);
    if (!latest) {
      const p = pts[0] || (measuring && hover);
      readout.textContent = p ? `cursor  ${fmt(p.x)}, ${fmt(-p.y)}` : ''; return;
    }
    const [a, b] = latest, dx = b.x - a.x, dy = b.y - a.y;
    readout.textContent = `dist ${fmt(Math.hypot(dx, dy))}\ndx   ${fmt(Math.abs(dx))}\ndy   ${fmt(Math.abs(dy))}\nang  ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°`;
  }
  function setMeasuring(v) {
    v = Boolean(v && svg && activeBoard?.kind !== 'schematic');
    measuring = v; $('measure-btn').classList.toggle('on', v); view.classList.toggle('measuring', v);
    if (!v) { pts = []; hover = null; draw(); }
  }
  $('measure-btn').onclick = () => setMeasuring(!measuring);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      clearSchematicSelection();
      clearComponent();
      e.preventDefault();
      clearNet(); setMeasuring(false);
      return;
    }
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'm' || e.key === 'M') setMeasuring(!measuring);
    if (e.shiftKey && e.key.toLowerCase() === 'c') { measurements = []; pts = []; hover = null; draw(); }
  });
  document.querySelectorAll('.unit').forEach(b => b.onclick = () => {
    unit = b.dataset.unit; document.querySelectorAll('.unit').forEach(x => x.classList.toggle('on', x === b)); draw();
  });
  view.addEventListener('click', e => {
    if (!svg || !measuring || e.button !== 0) return;
    pts.push(toSvg(e));
    if (pts.length === 2) { measurements.push(pts); pts = []; hover = null; }
    draw();
  });
  view.addEventListener('mousemove', e => { if (svg && measuring) { hover = toSvg(e); if (pts.length || !measurements.length) draw(); } });

  window.addEventListener('resize', positionMeasurementLabels);

  // ------------------------------------------------------------ board passed on the command line
  fetch('/initial').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.svg) return;
    const file = new File([Uint8Array.from(atob(d.source), c => c.charCodeAt(0))], d.name);
    const board = createBoard(file);
    show(board, d);
    if (!activeBoard) activateBoard(board);
    else updateTabs();
  }).catch(e => toast('Could not load the initial document: ' + e.message));
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
    ap = argparse.ArgumentParser(description="Standalone Altium PCB and schematic viewer")
    ap.add_argument("pcbdoc", nargs="?", type=Path, help="optional .PcbDoc or .SchDoc to load at startup")
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
