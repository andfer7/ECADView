Native desktop tests exercise Qt rasterization and exact picking, holes and
polygon/layer visibility, Altium and KiCad documents, source/pin cross-probing,
cursor-anchored zoom, millimetre measurements, repeated selections, asynchronous
tabs and errors, closing during a load, and worker shutdown. They also verify a
selected net's rendered colors on tracks, arcs, pads, vias, schematic wires,
pins and legacy junctions, including deselection and inherited paint styles;
drill holes and open paths remain unfilled. Selection tests verify fading of other
geometry while preserving paper backgrounds, picking, multiselection, layer
visibility and routes at layer crossings. Schematic component tests verify
green contours, shared 45% context contrast for component/net selections, preserved
interior fills and readable text while PCB
component fills retain their highlighting. Net stroke tests check 3.5× schematic
widths, inherited/inline units, deselection, and unchanged PCB/component widths.
Navigation tests check a
fixed cache pixel bound and coalescing hundreds of navigation events while a
renderer is busy. Zoom-out waits for the gesture to pause even beyond overscan;
long pans still refresh uncovered areas. Returning worker results preserve the
latest input deadline and cannot restore an older selection. Pad captions reuse
their recorded layout during movement and refresh at idle, with matching pixels
across logical display resolutions. 3D tests check constrained triangle areas,
board occlusion, hole/side ray intersections and body deletion/undo without a GL context.

```sh
QT_QPA_PLATFORM=offscreen uv run python -B -m unittest discover -s tests -v
uv run python scripts/benchmark_native.py /path/to/board.kicad_pcb
uv run python scripts/benchmark_native.py /path/to/large.PcbDoc --dpr 2 --zoom 4 --motion zoom --styles --snapshot /tmp/board.png
```

The benchmark reports source rendering, native indexing and metadata time, time
to the first frame, initial and unchanged-style vector-raster time,
median/p95 cached paint times, and the number of vector renders during its
navigation loop. `--styles` measures first selection, switching nets, revisiting
a cached selection, clearing, and layer reordering separately. `--snapshot`
saves the final navigation image for visual comparison. The loop starts with a
resting caption layout and measures replaying it during pan/zoom movement.
Navigation timings measure cached painting, not the asynchronous refinement rate
or end-to-end input latency. Compare fresh processes with the same viewport,
zoom, pixel density and filesystem-cache conditions.

Altium optimization tests compare complete SVG output against the upstream
renderer, including original IDs, V7 layers, clipping and multilayer pads/vias.
Native rendering additionally batches stroke text into independent path
segments, inherits shared metadata, and emits each physical drill once. Tests
compare expanded geometry and effective relationships against upstream output;
the source document and browser SVG output remain unchanged. Antialiasing at
coincident drill edges or crossing glyph strokes can differ slightly after
removing duplicated paint operations.
Set `PERF_TEST_FILE` to a local large `.PcbDoc` (such as
`LimeSDR-USB_1v4s.PcbDoc`) to run that exact-output comparison on a reference board
and verify its source checksum. The file stays outside this repository.
Native tests also check restoration of attributes, layer order and pixels after
repeated selections, and caption-index culling without changing label priority.
Large synthetic PCB tests require selection changes to avoid full SVG
serialization, renderer reloads and full-board repaint. They check drill
cutouts, selected crossings, layer and polygon visibility, camera invalidation,
and direct native masks against Qt SVG. At a fixed view, the last two selected
images are cached with a combined 64 MiB bound; camera/layer/polygon changes
invalidate them. Schematic contour and selection styling uses its existing path.

Layout GPU tests run separately on a live desktop, since the offscreen Qt plugin
cannot create a GL context. On macOS:

```sh
PCB_GPU_TESTS=1 QT_QPA_PLATFORM=cocoa uv run python -B -m unittest tests.test_layout_gpu -v
uv run python scripts/benchmark_layout_gpu.py /path/to/large.PcbDoc --renderer both --zoom 4 --motion zoom
```

The GPU checks require a valid context and report the OpenGL renderer. They
compare image orientation, color, transparency, camera transforms and overlays,
verify texture reuse and bounded residency, and release resources on cleanup.
The ordinary offscreen suite covers the raster fallback. GPU framebuffer captures
use `grabFramebuffer()`; ordinary `QWidget.render()` does not capture GL contents.
The live comparison reports CPU paint submission times and event timer cadence,
separately from source loading and texture upload. It does not measure total GPU
execution or end-to-end display latency. The standalone bundle and real 3D output
also require a live desktop smoke check.

The optional browser regression tests launch the real Python server and load its HTML,
CSS, and JavaScript, with small SVG fixtures in place of the Altium renderer.
They require the project's Python environment, Node.js 20 or newer, and Playwright. Install
the locked test dependencies from the project root:

```sh
npm ci
npx playwright install chromium
npm test
```

To use an installed Google Chrome instead of downloading Chromium, skip the
browser installation and add `PLAYWRIGHT_CHANNEL=chrome` to the test command.

Navigation coverage includes scroll-to-pan, Ctrl-wheel pinch zoom, native Safari
gesture event handling, cursor anchoring with SVG margins, redraw batching,
measurement label positioning, and pending gestures during tab changes.

Selection tests cover repeated clicks to deselect and reselect components and
nets in both views, including selections from searches and cross-probing.
They also check Shift selections, shared schematic graphics, remaining exact
matches across tabs, and preservation of selections during pans and measurements.

The checked-in `fixtures/kicad/demo.kicad_pcb` and `demo.kicad_sch` exercise real
KiCad parsing through the HTTP server and browser, without a KiCad installation.
They cover mixed Altium/KiCad tabs, uploads and drag-and-drop, component/net
cross-probing, wire selection, layers, zone visibility, pin captions,
millimetre measurements, board-only WebGL output, and malformed-upload recovery.
Python tests additionally verify rotated and mirrored geometry, board cutouts
and slots, sheet-local connectivity and crossings, saved zone metadata, escaped
text, source preservation, and CLI startup loading.

`fixtures/kicad/legacy.sch` checks legacy fields, mil-to-mm coordinates, wire and
power-label connectivity, missing-library placeholders, source timestamps,
sheet boxes, and clear errors for malformed or unrelated `.sch` files. KiCad 5
PCB tests retain unquoted brackets, apostrophes, semicolons and backslashes in
names. To reproduce the reported co60 pair through Chrome, set `KICAD_TEST_PCB`
and `KICAD_TEST_SCH` to their local paths; these files stay outside the repository.
Set `KICAD_SCREENSHOT_DIR` to an existing directory to save previews from that test.

Font validation, rendering, HTTP endpoints, and launch-command tests use the
project's Python environment:

```sh
.venv/bin/python -B -m unittest discover -s tests -v
```

Server tests cover the packaged frontend resources, unknown paths, initial
document loading, upload rendering and errors, and both the original script and
`python -m pcbvisualizer` launch commands. A generated schematic exercises actual
parsing and rendering without an external fixture.

Set `PCB_TEST_FILE` to the path of the affected GasWellShutoff.PcbDoc to also
exercise all three render modes and an actual browser upload through the Python
server. This optional fixture stays outside the repository. Set
`PCB_TEST_PYTHON` if the Python environment is somewhere other than `.venv`.

Set `SCH_TEST_FILE` to a local `.SchDoc` to exercise real schematic rendering,
startup loading, and browser upload. Schematic parsing is also tested with a
temporary schematic generated by the library, without an external fixture.
When both fixture variables are set, the browser test also probes the real
schematic selection into its matching PCB and back into the source sheet.
Cross-probing coverage in both directions includes renamed source components,
pin connectivity, exact name/alias fallbacks, multiple document targets, missing
and ambiguous matches, and preservation of source selections and views.

Polygon visibility tests cover solid and hatched pours, preservation of custom
pad shapes and ordinary copper, selection overlays, click-through to routes,
layer controls, and per-tab visibility. Python rendering checks verify the
source polygon links against SVG IDs in full, top, and bottom views.

Net-label tests cover zoom-dependent visibility, literal net names, mirrored
pads and rotated routes, drill holes, clipping, occlusion and label collisions.
They also exercise pan/resize alignment, hidden layers and pours, tab changes,
and click-through selection and measurement.
Via coverage checks annular-ring placement around large drills, duplicate copper
across layers, mirrored geometry, small vias at closer zoom, visibility and tab
state, and selection/measurement through the captions.
Component pin tests cover numeric/alphanumeric identifiers, unconnected pads,
two-row pin/net captions, cramped-pad fallback, mirrored pads, holes, visibility,
navigation, and click-through interactions. A generated PCB verifies source pad
numbers and component links in full, top, and bottom render modes.

3D tests round-trip a generated PCB through the real parser, verify board and
body dimensions, bottom-side standoffs, curved outlines, merged drills, slots,
edge notches, and fallback notices. Browser coverage checks actual WebGL output,
camera controls and tab persistence, preservation of 2D state, lazy local assets,
unsupported browsers, and an uploaded generated PcbDoc through the real server.
Body editing coverage checks ray picking from both sides, board occlusion,
highlight restoration, drag suppression, Shift selections, duplicate names,
Delete/Backspace, grouped undo, tab isolation, and unchanged 2D/source geometry.
Python coverage verifies that split solids share one body identity while distinct
bodies retain separate identities even when their names match.
