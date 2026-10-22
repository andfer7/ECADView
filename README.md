# PCBVisualizer

A local Altium PCB and schematic viewer. Open `.PcbDoc` and `.SchDoc` files in
separate tabs, inspect layers and polygon pours, find components and nets,
cross-probe between documents, and measure PCB geometry. Files are parsed on
your machine and the browser displays the rendered SVG.

Zoom into a PCB to see net names directly over visible pads, vias, and routes when
the text fits. Labels remain readable while navigating and respect layer and polygon
visibility. Via captions fit on the copper ring around the drill hole.

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
python pcb_viewer_gui.py --no-open --port 8000
```

The default browser is Chrome, and the server listens on `127.0.0.1` with a random
free port unless `--port` is supplied. Stop it with Ctrl+C. You can also launch
with `python -m pcbvisualizer`, or use the `pcbvisualizer` command after installing
the package. Without uv, install it with `python -m pip install .` in your Python
environment. No Node.js installation or frontend build is needed to run the app.

## Project layout

```text
pcb_viewer_gui.py          Compatibility launcher
pcbvisualizer/
  __init__.py             Package identity
  __main__.py             python -m pcbvisualizer entry point
  cli.py                  Arguments, startup, and browser launching
  rendering.py            Altium rendering and selection metadata
  server.py               Local HTTP endpoints and uploads
  static/
    index.html            Browser interface
    viewer.css            Interface styling
    viewer.js             Tabs, navigation, selection, probing, and measurement
    net-labels.js         Automatic net captions for zoomed PCB views
tests/
  test_rendering.py       Rendering regression tests
  test_server.py          HTTP and launch-command integration tests
  board_tabs.test.cjs     Browser regression tests
```

The server serves frontend resources explicitly. They are included in
the installed Python package, so launching does not depend on the current working
directory. The frontend uses plain JavaScript and requires no build step.

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
