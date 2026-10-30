# Browser 2D WebGL renderer

Issue #86 adds a retained WebGL 2 layout renderer to the browser viewer. Schematics and
the separate 3D renderer keep their existing paths. Parsing and geometry
preparation run locally; no CAD data goes to an external service.

## Design and limits

The browser keeps the loading status visible while an isolated offscreen Qt
process uses the SVG geometry compiler to prepare analytic primitives and
tessellated paths. A padded JSON header and binary float32/uint32 buffers cross
the loopback connection. Geometry is uploaded once when a document becomes
resident. Navigation updates camera uniforms; component/net selection updates
an R8 object-ID lookup, with a faded context pass, highlight pass and hole pass.
Layer drawing follows the SVG sibling order, including the last-enabled layer.

The SVG scene stays transparent above the canvas for browser-native picking,
search bounds, cross-probing and measurement coordinates. Measurement graphics
remain visible on top. This still requires an SVG interaction tree and its
viewBox transform; it does not remove all DOM costs. Caption placement waits
140 ms after navigation, uses worker-prepared world bounds to reject small and
offscreen candidates, and yields between short batches. Subsequent input
cancels stale caption work.

One WebGL context serves all PCB tabs. At most one PCB has GPU buffers; its
buffers remain resident while viewing schematics, so probing back needs no new
geometry upload. Switching to a different PCB replaces them. Each open tab
retains its CPU geometry for switching and recovery. Closing a PCB drops its CPU
data and deletes its resident GPU buffers, including while a schematic is active.
Context loss immediately
restores SVG; successful context restoration recreates the current buffers.
Unsupported SVG features (including isolated group opacity, clips, masks and
filters), a missing WebGL 2 context, compiler failure, or GPU allocation failure
keep the SVG path. Native Qt font outlines can differ from browser text fonts.

Preparation is serialized per browser and bounded to one compiler process per
server, with a 90-second timeout, 128 MiB input/geometry budgets and a 160 MiB
binary response limit including metadata. A closed tab aborts its browser
request and cannot mount a stale response. A compiler that has already started
may finish before its temporary files are removed; it is bounded by the same
timeout. There is no persistent generated-board cache.

The WebGL interface follows the [Khronos WebGL 2 specification](https://registry.khronos.org/webgl/specs/2.0/).
The renderer uses analytic coverage for simple primitives; GPU integration tests
compare the resulting pixels with SVG and verify selection colors and holes.

## Initial loading improvements (#113)

The loader reuses the physical layer stack for SVG, 3D metadata and layer order,
uses exact byte-row vertex deduplication for filled paths, and draws the first
accelerated selection state once. It avoids SVG measurement layout when there
are no measurements, and defers hidden selection clones while WebGL is preparing.
Queries entered during preparation still appear in either WebGL or SVG fallback.

A local Chrome load profile of the supplied LimeSDR reference measured 20.04 s
before and 18.48 s after (about 8% faster). Document response time fell from
7.44 s to 6.44 s and geometry preparation from 11.26 s to 10.72 s. These are
single before/after observations, not a cross-machine performance guarantee;
the geometry buffers and visible output retain the same precision.

The benchmark now reports `svg_setup_ms` for the installed SVG interaction tree
and `prepared_ms` for an interactive viewer. The SVG is hidden during WebGL
preparation; older `preview_ms` results must not be treated as an interactive
loading time.

## Cross-probing improvements (#115)

Connection indexes are built once per document and reused by each schematic/PCB
pair. Component-only probes skip net resolution entirely. Net probes lazily cache
pin-connected matches and the reverse lookup, retaining source-ID precedence,
exact-name/alias fallbacks and ambiguity reporting. Replacing a document creates
fresh indexes. View activation reuses search indexes and unchanged schematic
styling; a schematic-to-layout probe batches activation, hidden-layer reveal and
fitting into one final WebGL draw and caption refresh.

A generated workload with 400 components and 600 two-terminal schematic nets
exercises renamed component links without source IDs through the real viewer
and WebGL geometry compiler. Local headless Chrome measurements at 1440 × 900
on 2026-10-30 gave these median synchronous button-handler times over three
round trips per selection type:

| Direction and selection | Before | After |
| --- | ---: | ---: |
| Layout → schematic, component | 4,580 ms | 9.2 ms |
| Layout → schematic, net | 4,570 ms | 12.4 ms |
| Schematic → layout, component | 53 ms | 6.9 ms |
| Schematic → layout, net | 62 ms | 7.2 ms |

The first component and net forward probes after loading took 20 ms and 15.5 ms
respectively; later probes reused their indexes. These timings include matching,
selection restoration, view activation and fitting, but exclude deferred captions
and presentation by the display. They describe this generated workload, not a
guarantee for arbitrary CAD documents or machines. Reproduce with:

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/benchmark_browser_cross_probe.cjs result.json
```

## Representative LimeSDR result

Measured locally on 2026-10-29, Apple M3 Pro, Chrome 156.0.8078.73, headless,
1440 × 900 CSS pixels. Chrome reported its ANGLE Metal Apple M3 Pro renderer.
Input was `LimeSDR-USB_1v4s.PcbDoc` supplied for performance work.

Command (provide your local path):

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/benchmark_browser_layout.cjs path/to/LimeSDR-USB_1v4s.PcbDoc result.json
```

The benchmark compares the same compact SVG preview with WebGL disabled versus
enabled. A six-second timed sequence dispatches wheel/pinch events through the
real input handler, which coalesces camera updates with requestAnimationFrame.
These are synthetic browser events, not OS-generated touchpad input. A blocked
main thread can extend the six-second window and reduce delivered events.
This measures browser callback cadence, not completed GPU work or display FPS.

| Observation | SVG | WebGL 2 |
| --- | ---: | ---: |
| Navigation callback interval, median | 16.7 ms | 16.7 ms |
| Navigation callback interval, p95 | 33.4 ms | 33.4 ms |
| Worst navigation callback gap | 15,749 ms | 33.4 ms |
| Observed callbacks in timed window | 65 in 17.1 s | 299 in 6.0 s |
| Long task during navigation | 15,745 ms | none observed |
| GND selection handler | 5,437 ms | 127 ms |
| Worst callback gap after a settled close zoom | 10,762 ms | 22.2 ms |

The steady median/p95 did not improve in this run; the major gain was removing
large stalls and delivering many more input/camera updates. Results vary with
Chrome scheduling and other work on the machine. Earlier runs showed comparable
WebGL maximum navigation gaps of 33–34 ms and GND handlers around 102–144 ms.

The initial preview appeared in roughly 7–11 seconds across these runs; WebGL
became available in roughly 17–20 seconds, so preparation added approximately
9 seconds while keeping the preview usable. This change targets interaction,
and does not claim to eliminate the initial parse/preparation cost.

The LimeSDR scene contained 1,046,272 vertices and 2,169,915 indices, occupying
92,381,420 bytes (88.1 MiB) in static geometry buffers, with 16 visible draw
batches. The navigation phase performed one geometry upload and one initial
selection upload. No geometry was regenerated or uploaded while navigating.
Retaining the CPU copy adds approximately another geometry-sized allocation,
plus metadata and the SVG tree. Chrome reported about 15.6 MB of JS heap,
97.1 MB backing storage and 146 MB embedder heap for the selected WebGL page;
these diagnostics are not total process/GPU memory and must not be summed into
a claimed GPU-memory measurement. The selected page retained approximately
140,000 DOM nodes versus approximately 319,000 for SVG with highlight clones.

## Validation

```sh
QT_QPA_PLATFORM=offscreen .venv/bin/python -B -m unittest discover -s tests -v
PLAYWRIGHT_CHANNEL=chrome npm test
PLAYWRIGHT_CHANNEL=chrome npm run test:gpu
```

GPU integration tests use the real local compiler and Chrome WebGL 2. They
compare source/SVG pixel colors for transformed shapes, pours, cutouts, slots,
transparency and overlap; check exact picking, highlight/fade colors, hidden
matches, layer order and polygon visibility; and verify camera buffer reuse,
visible measurements, per-tab state, resource deletion, cancellation, context
loss/restoration, missing WebGL and unsupported SVG fallback. Real KiCad PCB
and schematic files cover captions, cross-probing and switching into/out of 3D.
The existing browser suite also exercises a generated Altium PCB upload.

The macOS standalone executable was built and its local web server successfully
prepared/rendered the real KiCad PCB through the bundled child worker. Windows
and other browsers were not exercised on this machine.
