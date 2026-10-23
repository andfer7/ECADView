# PCBVisualizer

A local Altium and KiCad PCB and schematic viewer. Open `.PcbDoc`, `.SchDoc`,
`.kicad_pcb`, `.kicad_sch`, and legacy KiCad `.sch` files in separate tabs, inspect layers and polygon pours, find components and nets,
cross-probe between documents, and measure PCB geometry. Files are parsed on
your machine and the browser displays the rendered SVG.

Zoom into a PCB to see net names directly over visible pads, vias, and routes when
the text fits. Labels remain readable while navigating and respect layer and polygon
visibility. Via captions fit on the copper ring around the drill hole.
Component pads also show their pin numbers, including alphanumeric and
unconnected pins. Pin numbers appear above net names when both fit; on cramped
pads the pin number takes priority.

PCB tabs also offer a **2D / 3D** toggle. The 3D preview shows the board profile,
curved edges, cutouts, through holes, slots, and simple extruded component bodies
where the document supplies body outlines and heights. Drag to rotate,
right-drag or Shift-drag to pan, and scroll or pinch to zoom. Use Top, Bottom,
Isometric, or Fit to reset the camera. Each tab remembers its view mode and
camera; switching back to 2D preserves layers, selections, zoom, and measurements.

Click a 3D body to select and highlight it; click it again or press Escape to
clear the selection. Shift-click adds or removes bodies from the selection.
The body list also supports keyboard selection, including bodies hidden behind
the board. Use **Delete selected**, Delete, or Backspace to remove selected
bodies from the preview, and **Undo delete** or Ctrl/Cmd+Z to restore the last
deletion. Selection, deletions, and undo history stay with each tab across mode
switches. These changes last for the current viewer session; the source document
and its 2D geometry remain unchanged.

The preview uses the first physical layer stack's thickness, or an explicitly
reported 1.6 mm fallback when thickness is unavailable. It requires a board
outline and browser WebGL support. Components without usable body geometry are
omitted, and detailed STEP models use simplified outlines. Copper, silkscreen,
blind/buried via bores, and rigid-flex folding are not represented in this first
3D version. The sidebar reports applicable approximations. Parsing, geometry,
and all graphics assets stay local; no CDN or Node.js runtime is needed.

## Setup and launch

Requires Python 3.12 or newer. Install the locked Python environment with uv:

```sh
uv sync --locked
uv run python pcb_viewer_gui.py
```

The existing launch command continues to work from an activated environment:

```sh
python pcb_viewer_gui.py
python pcb_viewer_gui.py board.PcbDoc
python pcb_viewer_gui.py sheet.SchDoc --browser default
python pcb_viewer_gui.py board.kicad_pcb
python pcb_viewer_gui.py sheet.kicad_sch
python pcb_viewer_gui.py legacy.sch
python pcb_viewer_gui.py --no-open --port 8000
```

The default browser is Chrome, and the server listens on `127.0.0.1` with a random
free port unless `--port` is supplied. Stop it with Ctrl+C. You can also launch
with `python -m pcbvisualizer`, or use the `pcbvisualizer` command after installing
the package. Without uv, install it with `python -m pip install .` in your Python
environment. No Node.js installation or frontend build is needed to run the app.

## KiCad support

KiCad `.kicad_pcb` boards (including KiCad 5) and modern `.kicad_sch` schematics
open directly, without installing KiCad or resolving external symbol libraries.
Use Open files or drag files into the viewer; KiCad and Altium documents can
share the same session.

PCB previews include footprints, pads and drills, tracks and arcs, vias, saved
zone fills, and board/footprint graphics. Layer controls, polygon visibility,
component and net searches, pin captions, cross-probing, and measurements use the
same controls as Altium documents. Refill and save zones in KiCad to include
their copper; this viewer does not calculate pours. Custom pad primitives are
supported, while chamfered and trapezoidal pads use a rectangular approximation.

Schematic previews use embedded symbols, units, rotation and mirroring, pins,
properties, wires, labels, junctions, and sheet boxes. Click bodies to select
components and wires or pins to select connected nets, then cross-probe into an
open PCB. Connectivity is derived for the individual sheet, including named
labels and power symbols. Open child sheets individually: the viewer does not
compile hierarchical projects or expand bus-member connectivity. Symbol and pin
decorations and text use simplified drawing and browser fonts; images, text
boxes, tables, and PCB dimensions are omitted. Applicable omissions appear in
the sidebar.

Legacy Eeschema `.sch` files (versions 1–4) have a limited preview: wires, labels,
junctions, notes, sheet boxes, visible fields, and dashed markers at component
positions. Components can be selected and probed into a matching PCB using
their saved timestamps. Standard power anchors and named wire labels contribute
to net selection; ordinary symbol pins are unavailable. Legacy files store
their symbol graphics and pins in external `.lib`/cache libraries, which this
viewer does not load. The sidebar explicitly marks the preview as incomplete.
For complete symbols and pin connectivity, open the original project with its
cache library in KiCad and save the sheet as `.kicad_sch`. Open child sheets
individually; uploading a parent sheet does not load its project files.

KiCad 3D previews show closed Edge.Cuts board profiles, cutouts, through drills,
slots, and the saved board thickness. Tiny outline endpoint gaps up to 0.002 mm
are joined when constructing the profile. External STEP/VRML component models
are not loaded, so KiCad's 3D preview currently shows the board only. Source
files are never modified.

## Project layout

```text
pcb_viewer_gui.py          Compatibility launcher
pcbvisualizer/
  __init__.py             Package identity
  __main__.py             python -m pcbvisualizer entry point
  cli.py                  Arguments, startup, and browser launching
  rendering.py            Format dispatch, Altium rendering and selection metadata
  kicad_common.py         KiCad S-expression and SVG helpers
  kicad_legacy.py         Limited legacy Eeschema preview with explicit placeholders
  kicad_pcb.py            KiCad board geometry, layers, and metadata
  kicad_schematic.py      Embedded symbols and sheet-local connectivity
  scene3d.py              Board and simple-body solid geometry in millimetres
  server.py               Local HTTP endpoints and uploads
  static/
    index.html            Browser interface
    viewer.css            Interface styling
    viewer.js             Tabs, navigation, selection, probing, and measurement
    net-labels.js         Net and component pin captions for zoomed PCB views
    viewer-3d.js          Local WebGL scene, controls, and camera management
tests/
  test_rendering.py       Rendering regression tests
  test_kicad.py           KiCad geometry, connectivity, and input tests
  test_server.py          HTTP and launch-command integration tests
  board_tabs.test.cjs     Browser regression tests
  fixtures/kicad/         Small native-format PCB and schematic examples
```

The server serves frontend resources explicitly. They are included in
the installed Python package, so launching does not depend on the current working
directory. The frontend uses plain JavaScript and requires no build step.
Three.js 0.180.0 and its OrbitControls module are bundled under the MIT license
in `pcbvisualizer/static/THREE-LICENSE.txt`. The upstream minified module and
core are unchanged; OrbitControls only changes its import to the local module.

## Tests

```sh
uv run python -B -m unittest discover -s tests -v
npm ci
npx playwright install chromium
npm test
```

Alternatively, use an installed Chrome with `PLAYWRIGHT_CHANNEL=chrome npm test`.
Browser tests require Node.js 20 or newer and launch the real Python server using
`.venv/bin/python` by default;
set `PCB_TEST_PYTHON` to use a different interpreter. Node.js and Playwright are
only needed for browser tests, and their dependencies are pinned in
`package-lock.json`.

See [tests/README.md](tests/README.md) for coverage and optional real-document
fixtures.
