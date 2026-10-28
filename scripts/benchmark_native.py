"""Measure native load/raster and cached navigation without a browser."""

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import QPoint, QPointF
from PySide6.QtGui import QImage, QPainter
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop.canvas import BoardCanvas
from pcbvisualizer.desktop.document import NativeDocument
from pcbvisualizer.rendering import render_file

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument("--frames", type=int, default=200)
    parser.add_argument("--zoom", type=float, default=1)
    parser.add_argument("--dpr", type=float, default=1)
    parser.add_argument("--motion", choices=("pan", "zoom"), default="pan")
    parser.add_argument(
        "--styles", action="store_true", help="Also time layer/selection changes"
    )
    parser.add_argument(
        "--snapshot", type=Path, help="Save the final cached navigation image"
    )
    args = parser.parse_args()
    if args.frames < 1 or args.zoom <= 0 or args.dpr <= 0:
        parser.error("frames, zoom and dpr must be positive")
    app = QApplication([])
    started = time.perf_counter()
    load_started = started
    data = render_file(args.document, native=True)
    source_ready = time.perf_counter()
    document = NativeDocument(data)
    indexed = time.perf_counter()
    load = time.perf_counter() - started
    info = document.info()
    metadata_seconds = time.perf_counter() - indexed
    stages = {
        "source_render_seconds": round(source_ready - started, 3),
        "native_index_seconds": round(indexed - source_ready, 3),
        "metadata_seconds": round(metadata_seconds, 3),
    }
    canvas = BoardCanvas()
    canvas.resize(1000, 700)
    canvas.set_document(info)
    canvas.zoom_at(QPointF(500, 350), args.zoom)
    requests = []
    canvas.render_requested.connect(requests.append)
    canvas.request_frame()
    request = requests[-1]
    raster_dpr = min(args.dpr, 4096 / max(canvas.width() * 1.4, canvas.height() * 1.4))
    request["width"] = round(canvas.width() * 1.4 * raster_dpr)
    request["height"] = round(canvas.height() * 1.4 * raster_dpr)
    started = time.perf_counter()
    frame = document.raster(request)
    raster = time.perf_counter() - started
    stages["time_to_first_frame_seconds"] = round(time.perf_counter() - load_started, 3)
    started = time.perf_counter()
    document.raster(request)
    stages["unchanged_style_raster_ms"] = round(
        (time.perf_counter() - started) * 1000, 2
    )
    if args.styles:
        visible, polygons, components, nets, order = request["style"]
        selected_net = (
            "GND" if "GND" in info["nets"] else next(iter(info["nets"]), None)
        )
        styles = {}
        if selected_net is not None:
            styles["selected_net"] = (
                visible,
                polygons,
                components,
                {selected_net},
                order,
            )
            other_net = next(
                (name for name in info["nets"] if name != selected_net), None
            )
            if other_net is not None:
                styles["switched_net"] = (
                    visible,
                    polygons,
                    components,
                    {other_net},
                    order,
                )
            styles["repeated_net"] = styles["selected_net"]
        styles["restored_style"] = request["style"]
        styles["reordered_layer"] = (
            visible,
            polygons,
            components,
            nets,
            tuple(reversed(order)),
        )
        styles["restored_layers"] = request["style"]
        for name, style in styles.items():
            started = time.perf_counter()
            document.raster(dict(request, style=style))
            stages[name + "_ms"] = round((time.perf_counter() - started) * 1000, 2)
    canvas.accept_frame(frame)
    target = QImage(
        round(1000 * args.dpr),
        round(700 * args.dpr),
        QImage.Format.Format_ARGB32_Premultiplied,
    )
    target.setDevicePixelRatio(args.dpr)
    # Prepare the resting label layout before measuring navigation, matching a
    # visible board. Layout is replayed with the image until the gesture pauses.
    canvas.timer.stop()
    canvas.navigating = False
    painter = QPainter(target)
    canvas.render(painter, QPoint())
    painter.end()
    times = []
    renders_before_navigation = document.render_count
    previous_zoom = 1
    for index in range(args.frames):
        if args.motion == "zoom":
            zoom = math.exp(0.25 * math.sin(index / 20))
            canvas.zoom_at(QPointF(400, 300), zoom / previous_zoom)
            previous_zoom = zoom
        else:
            canvas.camera += QPointF(0.02, 0.01)
            canvas.schedule(navigation=True)
        painter = QPainter(target)
        started = time.perf_counter()
        canvas.render(painter, QPoint())
        painter.end()
        times.append((time.perf_counter() - started) * 1000)
    canvas.timer.stop()
    if args.snapshot:
        target.save(str(args.snapshot))
    canvas.close()
    print(
        json.dumps(
            {
                "document": args.document.name,
                "primitives": len(document.primitives),
                "load_seconds": round(load, 3),
                "vector_raster_ms": round(raster * 1000, 2),
                **stages,
                "frames": args.frames,
                "zoom": args.zoom,
                "dpr": args.dpr,
                "motion": args.motion,
                "cached_paint_median_ms": round(statistics.median(times), 3),
                "cached_paint_p95_ms": round(
                    sorted(times)[int(len(times) * 0.95) - 1], 3
                ),
                "vector_renders_during_navigation": document.render_count
                - renders_before_navigation,
            },
            indent=2,
        )
    )
