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
    args = parser.parse_args()
    if args.frames < 1 or args.zoom <= 0 or args.dpr <= 0:
        parser.error("frames, zoom and dpr must be positive")
    app = QApplication([])
    started = time.perf_counter()
    document = NativeDocument(render_file(args.document))
    load = time.perf_counter() - started
    info = document.info()
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
    canvas.accept_frame(frame)
    target = QImage(
        round(1000 * args.dpr),
        round(700 * args.dpr),
        QImage.Format.Format_ARGB32_Premultiplied,
    )
    target.setDevicePixelRatio(args.dpr)
    times = []
    previous_zoom = 1
    for index in range(args.frames):
        if args.motion == "zoom":
            zoom = math.exp(0.25 * math.sin(index / 20))
            canvas.zoom_at(QPointF(400, 300), zoom / previous_zoom)
            previous_zoom = zoom
        else:
            canvas.camera += QPointF(0.02, 0.01)
        painter = QPainter(target)
        started = time.perf_counter()
        canvas.render(painter, QPoint())
        painter.end()
        times.append((time.perf_counter() - started) * 1000)
    canvas.timer.stop()
    canvas.close()
    print(
        json.dumps(
            {
                "document": args.document.name,
                "primitives": len(document.primitives),
                "load_seconds": round(load, 3),
                "vector_raster_ms": round(raster * 1000, 2),
                "frames": args.frames,
                "zoom": args.zoom,
                "dpr": args.dpr,
                "motion": args.motion,
                "cached_paint_median_ms": round(statistics.median(times), 3),
                "cached_paint_p95_ms": round(
                    sorted(times)[int(len(times) * 0.95) - 1], 3
                ),
                "vector_renders_during_navigation": document.render_count - 1,
            },
            indent=2,
        )
    )
