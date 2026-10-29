# Browser / standalone feature audit

Issue [#92](https://github.com/andfer7/PCB_Visualizer/issues/92) compares the
browser viewer against the 40 closed repository issues available on 2026-10-29,
the merged standalone changes, and the final refinements requested in the chat.
The table records user-visible behavior rather than requiring the browser to
use Qt's implementation. Native-only OS packaging/integration is identified
below. The standalone viewer remains unchanged by this work.

| Source | Browser behavior after this change | Status / coverage |
| --- | --- | --- |
| #1; native #58 | Multiple open documents, independent cameras/layers/selections/measurements/units, closing, keyboard navigation, movable tabs; multiple command-line startup files and file drops throughout the app | Extended; startup, reordering and sidebar-drop browser tests plus real CLI startup integration |
| #2, #3 | Case-insensitive component/net searches with exact-match preference, fit and reveal | Retained for PCB; added schematic searches with synchronized selections and fit |
| #4 | Modern KiCad PCB/schematic support and supported legacy `.sch`/KiCad 5 board previews | Shared parsers retained; existing real-file browser tests and WebGL cross-probing checks |
| #5 | Altium schematic visualization | Shared parser retained; generated electrical and embedded-image `.SchDoc` browser tests |
| #8 | Limited default visible layers, with per-tab choices | Retained; role/token metadata, custom layer names and tab tests |
| #10 | Multiple simultaneous measurements | Retained; extended with independent segment selection |
| #11 | Cursor-anchored zoom and screen-distance pan | Retained; letterboxing, coalescing, middle-button and Safari gesture tests |
| #12, #64 | Last selected/enabled layout layer draws on top | Added an independent layer-name action for already-visible layers; selected row persists per tab; drill cutouts stay above copper |
| #18 | Net selection includes connected polygon copper | Retained; polygon metadata and SVG/WebGL highlight tests |
| #19 | Component search above net search; obsolete render-color controls removed | Retained; both searches also available on schematic tabs |
| #23, #25 | Click nets/components to select complete related geometry | Retained; Shift-click now adds PCB selections like the standalone viewer |
| #27 | Escape exits measurement mode, clears unfinished work and selection, keeps completed measurements | Retained; completed measurements remain selectable afterwards |
| #30, #40 | Cross-probe schematic ↔ layout, with source identities, pin/net relationships, target choice, fit/reveal and explicit unmatched results | Retained; existing real KiCad and synthetic Altium browser coverage, including WebGL |
| #32, #34 | Select whole schematic nets, pins and symbol bodies; Shift adds; hollow/rotated/mirrored body hits avoid distant annotations | Retained and extended to metadata on leaf line/path graphics; overlays do not capture input |
| #37 | PCB highlight preserves actual source geometry, transforms, widths, holes and connected copper | Retained; SVG fallback now also keeps all visible drill cutouts above highlights and component color priority, matching native/GPU selection |
| #41 | Hide polygon pours without hiding ordinary copper | Retained; selected-polygon and per-tab tests |
| #45 | Clicking an already-selected net/component removes that selection while preserving other exact matches | Retained; PCB and schematic toggle tests, including Shift selections |
| #47 | Modular project structure | Preserved; browser schematic styling and measurement helpers now have separate modules |
| #49, #51 | Readable net names and component pin numbers on sufficiently zoomed copper | Retained; fit/collision/hole/mirror/layer tests and deferred WebGL caption placement |
| #53; chat 3D refinements | Local 3D board/cutouts/holes and simple bodies; presets, camera state, selection, multiple selection, deletion and undo | Retained; existing real Altium/KiCad and per-tab body-edit tests |
| #58; chat highlight refinements | Whole PCB and schematic selections; faded unselected context | PCB behavior retained; schematic selection now follows the final native style below |
| #60, #61 | Hide polygon and layer controls in schematic mode | Retained; schematic searches stay available; PCB controls also stay out of 3D mode |
| #66; chat / PR #79 | Faster large-board loading, highlighting and navigation | Compact shared renderer retained; WebGL keeps static geometry and selection lookup; measurements do not trigger board uploads |
| #68 | Investigate intermittent native touchpad pinch | Investigation was closed at the user's request without an implementation; no abandoned native experiment is reapplied. Browser wheel/pinch/gesture routing has its own regression coverage |
| #69 | First marker, live distance/line, second marker, persistent completed measurements | Screen-sized crosshair/circle markers; immediate pointer on tool entry and between measurements; cancelled previews disappear; dragging pans without placing endpoints |
| #71; final chat correction | Command-held measurement snapping on macOS; normal left click commits measurements | Command on macOS, Control on Windows/Linux; 12 CSS-pixel capture radius; visible copper pad/via centres; first point, live preview, second point, modifier release and hidden layers covered in SVG and WebGL |
| #73 | A clicked completed segment shows dashed X/Y legs and distances; default remains total distance only | Added; works in normal and measurement modes, toggles on repeat clicks, persists per tab and does not start a new measurement |
| #75; issue's Q shortcut | Q toggles metric/imperial, remembers mil/in preference per tab, refreshes totals/axes/live values without changing geometry | Added, including an explicit system button; search text entry remains normal |
| #77; final chat label correction | White thicker segments/markers, larger measurement text, total label clear of the segment and its X/Y legs | 3 px strokes, 4 px selected segment, 6 px marker radius/10 px crosshair arms, approximately 14 pt semibold labels, outside-triangle placement; direction/short-segment/zoom tests |
| #80 | GPU-assisted 2D layout navigation with reusable resources and fallback | Browser equivalent supplied by #86/#91: WebGL 2 retained geometry, not Qt OpenGL textures |
| #82 | Embedded diagram images render with correct placement/scaling | Shared SVG already supports browser images; new actual `.SchDoc` PNG pixel regression, plus the three supplied LimeSDR diagrams verified |
| #84 | Layer list follows the saved physical copper stack, independently from paint order and custom names | Added; list-only sorting replaces copper slots, retains technical slots and per-tab visibility/active layer |
| #86 / PR #91 | Dedicated browser WebGL 2 renderer, local preparation, retained buffers, exact picking, lifecycle/fallback | Retained; GPU integration suite and LimeSDR check confirm buffer reuse during new measurement operations |

## Final schematic appearance from the chat

Both selected nets and symbols use `#008a3b`. Unselected paint blends toward the
paper color (`#fffcf8`) at 45% contrast, matching the standalone constant. Symbol
body interiors keep their original fill; contours turn green, including a
contour for filled-only bodies. References/values remain filled glyphs. Selected
net strokes use **3.5 times their original width**, with no cumulative widening
on repeated selection. Selected geometry is drawn above the faded context;
the overlay has no hit targets or duplicate IDs. Clearing selection restores
the source paint and widths. This is schematic-only styling.

## Browser controls

`M` toggles measurement mode; hold Command (macOS) or Control (Windows/Linux)
for snapping. Click a saved segment for X/Y, and click it again to hide the
axes. `Q` toggles metric/imperial; the mm/mil/in buttons remain available.
`F` fits; `+` / `-` zoom; Cmd/Ctrl+O opens files. Escape clears the active
selection and unfinished measurement, while Shift+C clears saved measurements.
Shortcuts leave editable search text alone. Tabs can be dragged or moved using
Alt+Shift+Left/Right. Clicking a layer name raises it; its checkbox independently
controls visibility.

## Real-reference validation

Chrome on macOS opened `01_BlockDiagram.SchDoc`, `02_PowerDiagram.SchDoc`, and
`03_ClockDiagram.SchDoc` from the supplied LimeSDR project. Their embedded PNGs
decoded at 3482×2151, 5457×6370, and 7351×3401 pixels and rendered visibly.
These sheets contain image diagrams and report zero electrical components,
wires and net labels; an image cannot provide electrical selection or probing
relationships that are absent from its source.

`LimeSDR-USB_1v4s.PcbDoc` showed Top, L2 through L11, Bottom in the sidebar.
Command snapping, completed measurement selection, dashed axes and imperial
conversion worked on its retained WebGL scene. Geometry remained at one upload
through those operations (92,381,420 vertex/index bytes). The four supplied
source files had unchanged SHA-256 hashes and the browser reported no script
errors. This is a functional/reference check; the existing navigation benchmark
and its timing limits are documented in [browser performance notes](browser-webgl-performance.md).
The existing real-file browser test also passed against the supplied
`co60.kicad_pcb` and `co60.sch`, including legacy schematic selection,
cross-probing and the PCB's 3D view.

## Verification and remaining platform distinctions

```sh
QT_QPA_PLATFORM=offscreen .venv/bin/python -B -m unittest discover -s tests -v
PLAYWRIGHT_CHANNEL=chrome npm test
PLAYWRIGHT_CHANNEL=chrome npm run test:gpu
```

The focused tests have `native parity:` in their names and run both SVG fallback
and actual WebGL 2 for measurements, snapping and units. The full existing suite
continues to cover selection, formats, cross-probing, captions, navigation,
3D body editing and per-tab state.

On the macOS validation host, the Python suite passed 148 tests (11 skipped),
the main Chrome suite passed 83 (3 environment-dependent cases skipped), and
the WebGL/SVG pixel suite passed 8. The packaged macOS executable also passed
a smoke check covering multiple startup files, green schematic selection,
WebGL, snapping and the Q unit toggle.

Qt native widgets, standalone executable packaging, Finder/Windows Open With,
and the native window's Quit action remain OS integration. Browser tabs/file
inputs/host-browser commands provide their corresponding interaction. The web
app still requires its local backend; no cloud service replaces file parsing.
Native renderer follow-ups #87–#90 were open at this audit and are not completed
features to port. Physical touchpad recognition and Windows/other browsers were
not verified on this macOS/Chrome test host.
