# PCBVisualizer

A local browser-based Altium and KiCad PCB and schematic viewer. Open `.PcbDoc`,
`.SchDoc`, `.kicad_pcb`, `.kicad_sch`, and legacy KiCad `.sch` files in separate
tabs, inspect layers and polygon pours, find components and nets, cross-probe
between documents, and measure PCB geometry.

**The web viewer is the primary and only supported interface.** All launch
commands open it in a browser. The former native Qt window has been retired;
new features and performance work target the web viewer.

Files, parsing, geometry preparation and graphics assets stay on your computer.
The backend listens only on `127.0.0.1`. There is no cloud upload, CDN, Node.js
runtime or frontend build step required to use the application. Once installed,
it works offline with a locally installed browser.

## Setup and launch

Requires Python 3.12 or newer. Install the locked environment with uv:

```sh
uv sync --locked
uv run pcbvisualizer
```

These entry points all open the same browser interface, with or without files:

```sh
python pcb_viewer_gui.py
python pcb_viewer_gui.py board.PcbDoc sheet.SchDoc
python -m pcbvisualizer board.kicad_pcb sheet.kicad_sch
pcbvisualizer legacy.sch
```

Without uv, install with `python -m pip install .` in your Python environment.
Chrome is preferred by default, with a system-browser fallback. Select a browser
or start only the local server:

```sh
pcbvisualizer --browser default
pcbvisualizer --browser firefox board.PcbDoc
pcbvisualizer --no-open --port 8000
```

`--web` remains accepted for existing scripts, but is no longer needed.
Open the printed local URL when using `--no-open`. Closing the last viewer
browser tab or window automatically stops the local backend and exits the
program after a **3-second reconnect grace period**. Refreshing the page or
keeping another viewer page open keeps the backend running. Background tabs
also stay connected; shutdown does not depend on JavaScript heartbeat timers.
A server started with `--no-open` waits for its first viewer indefinitely.
A terminal launch also accepts Ctrl+C to stop the backend immediately.
Active geometry compiler children are cancelled and reaped during shutdown.
Document tabs, measurements and preview edits are session state and are lost
when the page closes. After automatic shutdown, launch the program again to
start a new session.

## Navigation, selection and measurements

The compact toolbar floats at the top centre of the drawing window. Its
magnifying-glass icons zoom out, zoom in and fit the active document. Hover for
the action and keyboard shortcut. It works in layout, schematic and 3D views.

Use **Open files** or drop files anywhere in the application. Multiple startup
files, movable tabs and Alt+Shift+Left/Right tab reordering are supported.

- Left-drag draws a dashed rectangle to select overlapping nets and symbols/components.
  Shift-drag or Shift-click extends the selection. Click selected objects to toggle them.
- Pan with two-finger scrolling, middle-drag or Space-drag. Pinch or Ctrl+scroll
  zooms at the pointer. F or double-click fits; `+` / `-` zoom and Cmd/Ctrl+O opens files.
- Search components and nets by name, fit or reveal matches, and cross-probe
  between open PCB and schematic tabs using source identities and pin relationships.
- The layer list follows the physical copper stack, including renamed inner
  layers. Selecting a visible layer name or enabling a layer brings it to the front.
- Selected objects remain bright while the rest fades. Schematics use green
  contours and nets, preserve component interiors and keep 45% context contrast.
  Selected schematic net strokes are 3.5 times their original width.

In PCB layout mode, **Measure** (M) immediately shows a pointer marker. Click
once to fix the starting marker, move to preview the dashed line and live
distance, then click again to fix the endpoint. Both endpoint markers remain.
Hold Command on macOS or Control on Windows/Linux to snap to visible pad/via
centres. Left-drag continues to pan while measurement mode is active.

Click a completed measurement segment to show dashed X/Y legs and distances;
click it again to hide them. Q or **Metric/Imperial** switches unit systems,
remembering each tab's last mil/in choice. White thicker graphics and larger
labels stay clear of the measurement segments. Escape cancels the tool and
selection while retaining completed measurements; Shift+C clears measurements.
Each document retains its view, layers, selections, measurements and units
across tab and 2D/3D changes.

## 2D rendering and performance

PCB layouts show “Starting WebGL…” until their retained WebGL 2 geometry is
ready, with navigation disabled during preparation. Zoom and pan update camera
uniforms; selection updates an object lookup. Geometry stays on the GPU during
navigation and selection. Schematics use SVG directly.

One WebGL context serves all PCB tabs. Context loss, missing WebGL 2, unsupported
SVG composition or geometry preparation failure falls back to SVG. The parser
and compiler still use the CPU; initial loading remains separate from navigation
performance. Qt Essentials provides offscreen SVG bounds and font outlines for
the compiler, and does not create a native viewer window. Qt Widgets, Qt OpenGL
views and Qt WebEngine are excluded from the packaged launcher.

See [browser performance notes](docs/browser-webgl-performance.md) for bounds,
measurements and the reproducible browser benchmark:

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/benchmark_browser_layout.cjs path/to/board.PcbDoc result.json
```

## 3D preview

PCB tabs offer a sliding **2D / 3D** switch at the top-left of the drawing
window. Its translucent cover slides over the inactive mode while keeping both
labels readable; click it, or use Enter/Space while focused, to switch views.
Press **2** for 2D or **3** for 3D when outside a text field or list. These
shortcuts apply to PCB tabs after loading has finished.
The local WebGL preview shows the board
profile, curved edges, cutouts, through holes, slots and component STEP models.
Embedded Altium STEP assets load automatically when entering 3D. Models retain
their colors, rotations, offsets and board side; repeated models share geometry.
Conversion runs in a browser worker using bundled OpenCascade WebAssembly, so
2D loading never waits for tessellation and the viewer stays usable while models
appear. The sidebar reports loading progress and any unavailable models.
The 3D finish includes outer copper relief, exposed pads and silkscreen taken
from the PCB layers on both sides, with a satin solder mask and an FR4-colored
board edge. These details stay aligned regardless of 2D selections or hidden
layers. Studio reflections, softer shadows and tone mapping give components
more depth. STEP colors are preserved; plastic/metal roughness is inferred from
color because STEP assets do not provide measured material finishes. Shadows
are reused during navigation and refreshed when geometry or deletions change.
The board finish is applied directly to its existing top and bottom faces.
The camera's depth interval follows the visible board during zoom, pan and orbit
to keep closely spaced STEP faces distinct and avoid striped depth artifacts.
Middle-drag or left-drag to rotate freely through any orientation, including
past top and bottom, without a locked up axis. Right-drag, Shift-middle-drag or
Shift-left-drag to pan; scroll or pinch to zoom towards the pointer. On a
touchscreen, use one finger to rotate and two fingers to pan or pinch. Double-click a
board or component surface to centre rotation there, preserving the viewing
direction and zoom. Fit, the F key and double-clicking empty space centre and
frame the board without changing its rotation. In 3D, the floating Top and Bottom
buttons are stacked above the arrow pad at the bottom-left. The four arrows rotate the
board by 5° per click in screen directions, keeping the rotation centre and zoom.
Hold an arrow to keep rotating; release to stop. Space or Enter also works while
an arrow is focused.
Each tab remembers its rotation centre, camera and mode.

Click a body to select it; its visible parts turn cyan, including dark plastics
and reflective metal. Clear the selection to restore its original finish.
Shift-click for multiple bodies, and use Delete /
Backspace or **Delete selected** to hide them. **Undo delete** or Cmd/Ctrl+Z
restores them. The body list also selects bodies behind the board. These edits
last for the session and never modify the source document or 2D geometry.

The preview uses the first physical stack's thickness, or reports a 1.6 mm
fallback. Missing, invalid or unsupported models retain an extruded outline when
one is available; components without either a model or body geometry are omitted.
Use **Add STEP models…** to supply missing `.step`/`.stp` references by filename.
STEP assets are limited to 32 MB (64 MB after decompression), 250,000 triangles
per model and a 45-second conversion deadline; converted CPU data uses a bounded
64 MB cache. Completed 3D views retain their geometry, board finishes and shadows,
so returning from 2D or another tab displays the prepared view immediately.
The viewer retains up to three completed scenes within an estimated 512 MiB
budget; older or oversized scenes rebuild when needed. Closing/reloading a tab
or replacing its STEP models releases its cached scene. Leaving an unfinished
3D view cancels outstanding conversion.
Outer copper and printing are rasterized into maps up to 2048 pixels per side;
these are visual finishes rather than additional editable solids. Blind/buried
via bores and rigid-flex folding are not represented. Applicable approximations appear in
the sidebar.

## Packaged browser launcher

Build a self-contained local backend and launcher for the current operating system:

```sh
uv run --locked --group build python scripts/build_app.py
```

On macOS, open `dist/PCBVisualizer.app`. On Windows/Linux, launch the executable
under `dist/PCBVisualizer/` and keep its supporting files together. It starts
the local backend and opens the same browser interface, with no Python or uv
installation required on the receiving computer. A browser must be installed.
Close the last viewer browser tab/window to stop it automatically.

Build on each target operating system. The macOS bundle uses a local ad-hoc
signature; release signing/notarization is a separate distribution step. The
launcher no longer registers native Finder file associations. Open documents
inside the browser, drop files there, or pass startup paths to the executable.

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
decorations and text use simplified drawing and installed fonts; images, text
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
are joined when constructing the profile. STEP component references opened from
the command line resolve relative to the board directory, `${KIPRJMOD}` and
configured environment variables such as `${KICAD9_3DMODEL_DIR}`. Model scale,
rotation and offsets are respected, including legacy KiCad 5 model offsets.
Browser uploads cannot access adjacent files: use **Add STEP models…** to select
the referenced files. Matching uses filenames; give models distinct filenames
when different reference paths share a name. VRML and other non-STEP component
models remain unsupported. Source files are never modified.

## Project layout

```text
pcb_viewer_gui.py          Compatibility launcher
pcbvisualizer/
  __main__.py, cli.py      Browser startup and isolated worker dispatch
  rendering.py            Format dispatch and compact SVG/selection metadata
  geometry/               Offscreen document bounds, glyphs and GPU compilation
  web_geometry.py         Bounded isolated compiler and binary transport
  server.py               Loopback HTTP endpoints, uploads and viewer connections
  session_lifetime.py     Last-viewer shutdown and reconnect grace
  kicad_*.py              KiCad geometry, connectivity and input support
  scene3d.py              Board/body fallbacks and STEP placements in millimetres
  step_models.py          Embedded/external STEP assets and model transforms
  static/                 Browser interface, WebGL renderers and bundled assets
scripts/
  build_app.py            Packaged local backend/browser launcher
  PCBVisualizer.spec      Offscreen Qt dependencies and packaged resources
  benchmark_browser_layout.cjs Browser navigation/selection measurements
tests/                    Python geometry/parser/server and browser regressions
```

Frontend resources ship with the Python package. Launching does not depend on
the current directory. Three.js 0.180.0 and OrbitControls are bundled under the
MIT license in `pcbvisualizer/static/THREE-LICENSE.txt`.
STEP conversion uses [occt-import-js 0.0.23](https://github.com/kovacsv/occt-import-js)
and OpenCascade, with LGPL 2.1 license texts in `static/OCCT-IMPORT-LICENSE.txt`
and `static/OCCT-LICENSE.txt`. The importer is separately replaceable; its source,
build instructions and upstream releases are available in that repository.
After `npm ci`, run `python scripts/vendor_step_importer.py` to reproduce the
bundled JavaScript, WebAssembly and license files from the pinned npm package.
The [historical feature audit](docs/browser-native-parity.md) records how the
former desktop features were brought into the browser before its retirement.

## Tests

```sh
uv run --locked python -B -m unittest discover -s tests -v
npm ci
npx playwright install chromium
npm test
npm run test:gpu
```

Use `PLAYWRIGHT_CHANNEL=chrome` for an installed Chrome. Tests need Node.js 20+
and Playwright; the application itself does not. Set `PCB_TEST_PYTHON` when the
Python interpreter is elsewhere than `.venv/bin/python`.
See [tests/README.md](tests/README.md) for coverage and optional reference files.
