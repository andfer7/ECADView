"""Compare cached raster navigation with retained OpenGL layout geometry.

Paint timings measure CPU submission, not completed GPU execution. Timer and
frameSwapped intervals describe observed event/presentation cadence. This script
does not insert GPU fences and therefore does not report GPU execution FPS.
"""

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import QEventLoop, QPointF, QRectF, Qt, QTimer
from PySide6.QtGui import QSurfaceFormat
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop.canvas import BoardCanvas
from pcbvisualizer.desktop.document import NativeDocument
from pcbvisualizer.desktop.gpu_scene import build_scene
from pcbvisualizer.rendering import render_file


def configure_surface_format():
    """Call before creating QApplication, matching the desktop app's profile."""
    surface = QSurfaceFormat()
    surface.setVersion(3, 2)
    surface.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
    surface.setDepthBufferSize(24)
    surface.setSamples(4)
    QSurfaceFormat.setDefaultFormat(surface)


def summary(values):
    if not values:
        return {"samples": 0}
    ordered = sorted(values)
    return {
        "samples": len(values),
        "mean_ms": round(statistics.fmean(values), 3),
        "median_ms": round(statistics.median(values), 3),
        "p95_ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1], 3),
        "max_ms": round(ordered[-1], 3),
    }


class TimedCanvas(BoardCanvas):
    def __init__(self, *, opengl):
        super().__init__(opengl=opengl)
        self.record_paints = False
        self.paint_times = []

    def paintEvent(self, event):
        started = time.perf_counter()
        raster = self.opengl_view is None
        super().paintEvent(event)
        if self.record_paints and raster:
            self.paint_times.append((time.perf_counter() - started) * 1000)


def _run_case(
    document,
    info,
    *,
    renderer,
    frames,
    zoom,
    motion,
    width,
    height,
    interval,
    snapshot_dir,
    frame_cache,
    scene,
):
    gpu = renderer == "opengl"
    canvas = TimedCanvas(opengl=gpu)
    canvas.resize(width, height)
    canvas.setWindowTitle(
        f"PCBVisualizer — {'OpenGL' if gpu else 'Raster'} navigation benchmark"
    )
    canvas.set_document(info)
    canvas.timer.stop()
    loop = QEventLoop()
    ready_timer, input_timer, watchdog = QTimer(), QTimer(), QTimer()
    ready_timer.setInterval(25)
    input_timer.setInterval(interval)
    input_timer.setTimerType(Qt.TimerType.PreciseTimer)
    watchdog.setSingleShot(True)
    state = {
        "primed": False,
        "active": False,
        "error": None,
        "result": None,
        "ticks": 0,
        "cadence": [],
        "swaps": [],
        "gpu_paints": [],
    }

    def fail(error):
        state["error"] = str(error)
        ready_timer.stop()
        input_timer.stop()
        canvas.timer.stop()
        loop.quit()

    def guard(callback):
        def wrapped():
            try:
                callback()
            except Exception as exc:  # noqa: BLE001 - callbacks must release the event loop
                fail(exc)

        return wrapped

    def raster_frame():
        # Same overscan and pixel budget as BoardCanvas.request_frame, outside
        # navigation timing. No worker receives later detail requests.
        wide, high = canvas.width() * 1.4, canvas.height() * 1.4
        dpr = min(canvas.devicePixelRatioF(), 4096 / max(wide, high))
        rect = QRectF(
            canvas.camera.x() - wide / canvas.scale / 2,
            canvas.camera.y() - high / canvas.scale / 2,
            wide / canvas.scale,
            high / canvas.scale,
        )
        request = {
            "token": canvas.serial,
            "rect": rect,
            "width": max(1, round(wide * dpr)),
            "height": max(1, round(high * dpr)),
            "style": canvas.style_key(),
        }
        key = (
            rect.x(),
            rect.y(),
            rect.width(),
            rect.height(),
            request["width"],
            request["height"],
            request["style"],
        )
        if key not in frame_cache:
            frame_cache[key] = document.raster(request)
        frame = frame_cache[key]
        canvas.accept_frame(frame)
        canvas.timer.stop()

    def swapped():
        if not state["active"]:
            return
        state["swaps"].append(time.perf_counter())
        view = canvas.opengl_view
        if view is not None and view.paint_count != state["last_gpu_paint"]:
            state["gpu_paints"].append(view.last_paint_ms)
            state["last_gpu_paint"] = view.paint_count

    def begin():
        view = canvas.opengl_view
        if gpu and (view is None or not view.isValid() or canvas.opengl_error):
            raise RuntimeError(
                canvas.opengl_error
                or "A real OpenGL context is required; raster fallback is not a GPU result."
            )
        state.update(
            active=True,
            started=time.perf_counter(),
            previous_tick=time.perf_counter(),
            previous_zoom=1.0,
            renders=document.render_count,
            paints=view.paint_count if gpu else canvas.paint_count,
            uploads=view.uploads if gpu else 0,
            gpu_cpu_total=view.paint_ms_total if gpu else 0,
            last_gpu_paint=view.paint_count if gpu else 0,
            geometry_uploads=(
                view.retained_renderer.geometry_uploads
                if gpu and view.retained_renderer is not None
                else 0
            ),
            selection_uploads=(
                view.retained_renderer.selection_uploads
                if gpu and view.retained_renderer is not None
                else 0
            ),
        )
        canvas.paint_times.clear()
        canvas.record_paints = True
        input_timer.start()

    def prepare():
        if not canvas.isVisible():
            return
        view = canvas.opengl_view
        if gpu:
            if canvas.opengl_error:
                raise RuntimeError(canvas.opengl_error)
            if view is None:
                raise RuntimeError(
                    "The OpenGL viewport was not created; offscreen/minimal platforms cannot benchmark GPU drawing."
                )
            if not view.isValid() or not view.gl_info:
                return
        if not state["primed"]:
            if gpu:
                view.frameSwapped.connect(swapped)
            canvas.fit()
            canvas.timer.stop()
            if gpu and scene is not None and scene.get("supported"):
                canvas.accept_gpu_scene(scene)
                canvas.zoom_at(QPointF(canvas.width() / 2, canvas.height() / 2), zoom)
                canvas.timer.stop()
            else:
                if gpu and scene is not None:
                    canvas.accept_gpu_scene(scene)  # records the fallback reason
                raster_frame()  # retain a home overview for uncovered zoom/pan
                canvas.zoom_at(QPointF(canvas.width() / 2, canvas.height() / 2), zoom)
                canvas.timer.stop()
                raster_frame()
            canvas.navigating = False
            canvas.update()
            state["primed"] = True
            return
        # Initial geometry/images and label placement are excluded from timing.
        retained = gpu and scene is not None and scene.get("supported")
        ready = True
        if gpu:
            ready = (
                view.retained_renderer is not None
                and view.retained_renderer.geometry_uploads > 0
                if retained
                else view.texture_count > 0
            )
        if canvas.caption_cache is None or not ready:
            return
        ready_timer.stop()
        QTimer.singleShot(150, guard(begin))

    def finish():
        state["active"] = canvas.record_paints = False
        canvas.timer.stop()
        view = canvas.opengl_view
        if gpu and (view is None or not view.isValid() or canvas.opengl_error):
            raise RuntimeError(
                canvas.opengl_error or "OpenGL rendering fell back during navigation."
            )
        paints = (view.paint_count if gpu else canvas.paint_count) - state["paints"]
        if document.render_count != state["renders"]:
            raise RuntimeError("Navigation unexpectedly rasterized a new detail frame.")
        if gpu and view.uploads != state["uploads"]:
            raise RuntimeError("Cached navigation unexpectedly uploaded another image.")
        mesh = view.retained_renderer if gpu else None
        if mesh is not None and (
            mesh.geometry_uploads != state["geometry_uploads"]
            or mesh.selection_uploads != state["selection_uploads"]
        ):
            raise RuntimeError("Camera navigation unexpectedly uploaded retained data.")
        swap_intervals = [
            (b - a) * 1000 for a, b in zip(state["swaps"], state["swaps"][1:])
        ]
        cpu = summary(state["gpu_paints"] if gpu else canvas.paint_times)
        if gpu:
            cpu["mean_all_paints_ms"] = round(
                (view.paint_ms_total - state["gpu_cpu_total"]) / max(1, paints), 3
            )
        result = {
            "renderer": renderer,
            "presentation": (
                "retained_geometry"
                if mesh is not None
                else "cached_texture_fallback"
                if gpu
                else "cached_raster_image"
            ),
            "viewport": [canvas.width(), canvas.height()],
            "device_pixel_ratio": canvas.devicePixelRatioF(),
            "resident_image_keys": sorted(
                {
                    frame["image"].cacheKey()
                    for frame in (canvas.frame, canvas.overview)
                    if frame is not None
                }
            ),
            "zoom": zoom,
            "motion": motion,
            "requested_inputs": frames,
            "input_interval_ms": interval,
            "elapsed_seconds": round(time.perf_counter() - state["started"], 3),
            "input_timer_cadence": summary(state["cadence"]),
            "cpu_paint_submission": cpu,
            "paint_count": paints,
            "frame_swapped_cadence": summary(swap_intervals),
            "vector_renders_during_navigation": document.render_count
            - state["renders"],
        }
        if gpu:
            result.update(
                gl_info=dict(view.gl_info),
                uploads_before=state["uploads"],
                uploads_after=view.uploads,
                texture_count=view.texture_count,
                texture_bytes=view.texture_bytes,
                retained_scene={
                    "supported": bool(scene and scene.get("supported")),
                    "reason": scene.get("reason", "") if scene else "No scene supplied",
                    "preparation": dict(scene.get("stats", {})) if scene else {},
                },
            )
            if mesh is not None:
                result.update(
                    geometry_uploads_before=state["geometry_uploads"],
                    geometry_uploads_after=mesh.geometry_uploads,
                    selection_uploads_before=state["selection_uploads"],
                    selection_uploads_after=mesh.selection_uploads,
                    resident_vertex_bytes=mesh.vertex_bytes,
                    resident_index_bytes=mesh.index_bytes,
                    draw_calls_last_paint=mesh.draw_calls,
                )
        if snapshot_dir is not None:
            snapshot_dir.mkdir(parents=True, exist_ok=True)
            path = snapshot_dir / (
                f"{renderer}-{motion}-{zoom:g}x-{canvas.width()}x{canvas.height()}.png"
            )
            image = view.grabFramebuffer() if gpu else canvas.grab().toImage()
            if not image.save(str(path)):
                raise RuntimeError(f"Could not save {path}")
            result["snapshot"] = str(path.resolve())
        state["result"] = result
        watchdog.stop()
        loop.quit()

    def tick():
        now = time.perf_counter()
        state["cadence"].append((now - state["previous_tick"]) * 1000)
        state["previous_tick"] = now
        index = state["ticks"]
        if motion == "zoom":
            factor = math.exp(0.25 * math.sin(index / 20))
            canvas.zoom_at(
                QPointF(canvas.width() * 0.4, canvas.height() * 0.4),
                factor / state["previous_zoom"],
            )
            state["previous_zoom"] = factor
        else:
            canvas.camera += QPointF(0.02, 0.01)
            canvas.schedule(navigation=True)
        state["ticks"] += 1
        if state["ticks"] == frames:
            input_timer.stop()
            # Allow the last requested paint to reach the compositor; the
            # readback used for an optional snapshot is excluded from timings.
            QTimer.singleShot(max(32, interval * 2), guard(finish))

    ready_timer.timeout.connect(guard(prepare))
    input_timer.timeout.connect(guard(tick))
    watchdog.timeout.connect(
        lambda: fail("Timed out waiting for the visible benchmark/context.")
    )
    canvas.show()
    ready_timer.start()
    watchdog.start(max(30000, frames * interval + 15000))
    try:
        loop.exec()
        if state["error"]:
            raise RuntimeError(state["error"])
        return state["result"]
    finally:
        for timer in (ready_timer, input_timer, watchdog, canvas.timer):
            timer.stop()
        canvas.close()


def benchmark(
    document,
    info=None,
    *,
    renderer="both",
    frames=180,
    zoom=4,
    motion="pan",
    width=1000,
    height=700,
    interval=16,
    snapshot_dir=None,
    scene=None,
):
    """Benchmark an already constructed NativeDocument without reparsing it."""
    app = QApplication.instance()
    if app is None:
        raise RuntimeError(
            "Create QApplication after configure_surface_format() first."
        )
    if app.platformName() in {"offscreen", "minimal"}:
        raise RuntimeError(
            "Use a native Qt platform for this visible benchmark; offscreen/minimal cannot measure GPU drawing."
        )
    if renderer not in {"both", "raster", "opengl"} or motion not in {"pan", "zoom"}:
        raise ValueError("Invalid renderer or motion")
    if min(frames, width, height, interval) < 1 or zoom <= 0:
        raise ValueError("Frames, size, interval and zoom must be positive")
    info = document.info() if info is None else info
    if info["kind"] != "pcb":
        raise ValueError("The GPU layout benchmark requires a PCB document")
    previous = app.quitOnLastWindowClosed()
    app.setQuitOnLastWindowClosed(False)
    # Compile once before either measured case. Callers comparing several
    # window sizes can supply a previously built scene to reuse this work.
    if renderer != "raster" and scene is None:
        scene = build_scene(document)
    # The raster comparator retains its original cached-image presentation.
    # Unsupported scenes use that same image path through the OpenGL blitter.
    frame_cache = {}
    try:
        return [
            _run_case(
                document,
                info,
                renderer=choice,
                frames=frames,
                zoom=zoom,
                motion=motion,
                width=width,
                height=height,
                interval=interval,
                snapshot_dir=Path(snapshot_dir) if snapshot_dir is not None else None,
                frame_cache=frame_cache,
                scene=scene,
            )
            for choice in (["raster", "opengl"] if renderer == "both" else [renderer])
        ]
    finally:
        app.setQuitOnLastWindowClosed(previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument(
        "--renderer", choices=("both", "raster", "opengl"), default="both"
    )
    parser.add_argument("--frames", type=int, default=180)
    parser.add_argument("--zoom", type=float, default=4)
    parser.add_argument("--motion", choices=("pan", "zoom"), default="pan")
    parser.add_argument("--width", type=int, default=1000)
    parser.add_argument("--height", type=int, default=700)
    parser.add_argument("--interval", type=int, default=16)
    parser.add_argument("--snapshot-dir", type=Path)
    args = parser.parse_args()
    if min(args.frames, args.width, args.height, args.interval) < 1 or args.zoom <= 0:
        parser.error("frames, size, interval and zoom must be positive")
    configure_surface_format()
    app = QApplication([])
    if app.platformName() in {"offscreen", "minimal"}:
        parser.error(
            "Use a native Qt platform; unset QT_QPA_PLATFORM=offscreen/minimal."
        )
    started = time.perf_counter()
    data = render_file(args.document, native=True)
    source_ready = time.perf_counter()
    document = NativeDocument(data)
    info = document.info()
    indexed = time.perf_counter()
    cases = benchmark(
        document,
        info,
        renderer=args.renderer,
        frames=args.frames,
        zoom=args.zoom,
        motion=args.motion,
        width=args.width,
        height=args.height,
        interval=args.interval,
        snapshot_dir=args.snapshot_dir,
    )
    print(
        json.dumps(
            {
                "document": args.document.name,
                "qt_platform": app.platformName(),
                "source_render_seconds": round(source_ready - started, 3),
                "native_index_seconds": round(indexed - source_ready, 3),
                "timing_notes": "Paint timings are CPU submissions, not GPU execution. Timer/frameSwapped intervals are observed cadence, not GPU FPS. Raster uses cached images; supported OpenGL scenes use retained geometry. Scene preparation, initial rasterization/uploads, caption warmup and snapshot readback are excluded from navigation timing and scene preparation is reported separately.",
                "cases": cases,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
