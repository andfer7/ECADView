"""Measure native load/raster and cached navigation without a browser."""

import argparse
import json
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
    args = parser.parse_args()
    app = QApplication([])
    started = time.perf_counter()
    document = NativeDocument(render_file(args.document))
    load = time.perf_counter() - started
    info = document.info()
    started = time.perf_counter()
    frame = document.raster(
        {
            "token": 1,
            "rect": info["home"],
            "width": 1400,
            "height": 980,
            "style": (
                {row["id"] for row in info["layers"] if row["visible"]},
                True,
                set(),
                set(),
            ),
        }
    )
    raster = time.perf_counter() - started
    canvas = BoardCanvas()
    canvas.resize(1000, 700)
    canvas.set_document(info)
    canvas.frame = frame
    target = QImage(1000, 700, QImage.Format.Format_ARGB32_Premultiplied)
    times = []
    for index in range(args.frames):
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
                "cached_paint_median_ms": round(statistics.median(times), 3),
                "cached_paint_p95_ms": round(
                    sorted(times)[int(len(times) * 0.95) - 1], 3
                ),
                "vector_renders_during_navigation": document.render_count - 1,
            },
            indent=2,
        )
    )
