"""Measure real layout input/presentation latency with the production worker.

Run on a live desktop, for example:
  python scripts/benchmark_layout_interaction.py board.PcbDoc --output result.json

The texture mode keeps the existing SVG refinement path for a paired comparison.
Presentation/timer timings include the event loop and worker; paint timings are
CPU submissions, not GPU execution times or an independent GPU FPS measurement.
"""

import argparse
import json
import math
import sys
import threading
import time
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtCore import QEventLoop, QObject, QPointF, Qt, QThread, QTimer, Slot
from PySide6.QtWidgets import QApplication

from pcbvisualizer.desktop import document as document_module
from pcbvisualizer.desktop import gpu_scene
from pcbvisualizer.desktop.app import DocumentTab
from scripts.benchmark_layout_gpu import configure_surface_format, summary

PHASES = (
    ("zoom_out", 1.4),
    ("pause_out", 0.25),
    ("zoom_in", 1.4),
    ("pause_in", 0.15),
    ("pan_beyond", 1.5),
    ("pause_pan", 0.15),
    ("zoom_resume", 0.8),
    ("pause_resume", 0.3),
    ("pan_return", 1.0),
    ("settle", 0.8),
)


class InteractionBenchmark(QObject):
    def __init__(
        self,
        path,
        *,
        renderer="retained",
        width=1000,
        height=700,
        interval=16,
        snapshot_dir=None,
        timeout=120,
    ):
        super().__init__()
        self.app = QApplication.instance()
        self.renderer = renderer
        self.snapshot_dir = Path(snapshot_dir) if snapshot_dir else None
        self.events, self.inputs, self.pending, self.gaps = [], [], [], []
        self.preparation_gaps = []
        self.heartbeat_gaps, self.errors = [], []
        self.active = False
        self.started = time.perf_counter()
        self.paint_serial = -1
        self.paint_content = "empty"
        self.retained_presented = False
        self.warm_zoom = False
        self.view = None
        self.stop_heartbeat = threading.Event()
        self.loop = QEventLoop()
        self.poll, self.ticks, self.deadline = QTimer(self), QTimer(self), QTimer(self)
        self.poll.setInterval(25)
        self.poll.timeout.connect(self.ready)
        self.ticks.setInterval(interval)
        self.ticks.setTimerType(Qt.TimerType.PreciseTimer)
        self.ticks.timeout.connect(self.step)
        self.deadline.setSingleShot(True)
        self.deadline.timeout.connect(lambda: self.fail("Benchmark timed out"))
        self.patches = ExitStack()
        self.instrument_worker()
        self.tab = DocumentTab(path)
        self.canvas = self.tab.canvas
        if renderer == "textures":
            self.canvas.scene_requested.disconnect(self.tab.worker.build_gpu_scene)
        self.tab.worker.loaded.connect(self.loaded)
        self.tab.worker.frame.connect(self.frame)
        self.tab.worker.gpu_scene.connect(self.scene)
        self.tab.worker.failed.connect(self.fail)
        self.canvas.render_requested.connect(
            lambda request: self.record("request", token=request["token"])
        )
        original = self.canvas.paint_captions

        def captions(*args):
            started, cpu = time.perf_counter(), time.thread_time()
            result = original(*args)
            self.record(
                "captions",
                duration_ms=(time.perf_counter() - started) * 1000,
                thread_cpu_ms=(time.thread_time() - cpu) * 1000,
                navigating=self.canvas.navigating,
            )
            return result

        self.canvas.paint_captions = captions
        self.tab.resize(width, height)
        self.tab.setWindowTitle(
            f"PCBVisualizer — {renderer.title()} interaction benchmark"
        )
        self.tab.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.tab.show()
        self.tab.raise_()
        self.tab.activateWindow()
        self.preparation_tick = time.perf_counter()
        self.poll.start()
        self.deadline.start(timeout * 1000)

    def record(self, kind, **values):
        self.events.append(
            {
                "kind": kind,
                "t": time.perf_counter() - self.started,
                "thread": threading.get_ident(),
                "gui_thread": QThread.currentThread() == self.app.thread(),
                "active": self.active,
                **values,
            }
        )

    def instrument_worker(self):
        render_file = document_module.render_file
        initialize = document_module.NativeDocument.__init__
        raster = document_module.NativeDocument.raster
        compile_scene = gpu_scene.build_scene

        def source(*args, **kwargs):
            started = time.perf_counter()
            result = render_file(*args, **kwargs)
            self.record("source", duration_ms=(time.perf_counter() - started) * 1000)
            return result

        def constructor(document, *args, **kwargs):
            started = time.perf_counter()
            initialize(document, *args, **kwargs)
            self.record("index", duration_ms=(time.perf_counter() - started) * 1000)

        def rendering(document, request):
            if QThread.currentThread() == self.app.thread():
                raise RuntimeError("Production raster unexpectedly ran on GUI thread")
            started, cpu = time.perf_counter(), time.thread_time()
            self.record("render_start", token=request["token"])
            result = raster(document, request)
            self.record(
                "render_finish",
                token=request["token"],
                duration_ms=(time.perf_counter() - started) * 1000,
                thread_cpu_ms=(time.thread_time() - cpu) * 1000,
            )
            return result

        def compiling(document):
            started = time.perf_counter()
            self.record("compile_start")
            result = compile_scene(document)
            self.record(
                "compile",
                duration_ms=(time.perf_counter() - started) * 1000,
                supported=result["supported"],
                reason=result["reason"],
                stats=result.get("stats", {}),
            )
            return result

        for target, name, replacement in (
            (document_module, "render_file", source),
            (document_module.NativeDocument, "__init__", constructor),
            (document_module.NativeDocument, "raster", rendering),
            (gpu_scene, "build_scene", compiling),
        ):
            self.patches.enter_context(patch.object(target, name, replacement))

    @Slot(object)
    def loaded(self, info):
        self.record("loaded", load_seconds=info.get("load_seconds"))
        if self.renderer == "textures":
            # Disabling compilation must not leave its preparation badge visible.
            self.canvas.scene_error = "Retained geometry disabled for texture benchmark"
        self.view = self.canvas.opengl_view
        if self.view is None:
            self.fail("A real OpenGL viewport is required")
            return
        original = self.view._paint_frames

        def paint():
            self.paint_serial = self.canvas.serial
            result = original()
            mesh = self.view.retained_renderer
            self.paint_content = (
                "retained"
                if self.canvas.gpu_scene is not None and mesh and mesh.geometry_uploads
                else "textures"
                if self.view.texture_count
                else "empty"
            )
            return result

        self.view._paint_frames = paint
        self.view.frameSwapped.connect(self.swap)
        self.view.failed.connect(self.fail)

    @Slot(object)
    def frame(self, frame):
        self.record("frame", token=frame["token"])

    @Slot(object)
    def scene(self, scene):
        self.record("scene_ready", supported=scene["supported"])
        if not scene["supported"]:
            self.fail(scene["reason"])

    @Slot(str)
    def fail(self, message):
        self.errors.append(message)
        self.loop.quit()

    def swap(self):
        now = time.perf_counter()
        self.record(
            "swap",
            serial=self.paint_serial,
            content=self.paint_content,
            cpu_submit_ms=self.view.last_paint_ms,
        )
        self.retained_presented |= self.paint_content == "retained"
        if not self.active:
            return
        keep = []
        for item in self.pending:
            if item["serial"] <= self.paint_serial:
                item["present_t"] = now
                self.inputs.append(item)
            else:
                keep.append(item)
        self.pending = keep

    def gpu_stats(self):
        mesh = getattr(self.view, "retained_renderer", None)
        return {
            "texture_uploads": self.view.uploads,
            "resident_textures": self.view.texture_count,
            "texture_bytes": self.view.texture_bytes,
            "geometry_uploads": mesh.geometry_uploads if mesh else 0,
            "selection_uploads": mesh.selection_uploads if mesh else 0,
            "vertex_bytes": mesh.vertex_bytes if mesh else 0,
            "index_bytes": mesh.index_bytes if mesh else 0,
            "draw_calls": mesh.draw_calls if mesh else 0,
        }

    def snapshot(self, name):
        if self.snapshot_dir:
            self.snapshot_dir.mkdir(parents=True, exist_ok=True)
            self.view.grabFramebuffer().save(str(self.snapshot_dir / f"{name}.png"))

    def ready(self):
        now = time.perf_counter()
        self.preparation_gaps.append(
            {"t": now - self.started, "gap_ms": (now - self.preparation_tick) * 1000}
        )
        self.preparation_tick = now
        canvas = self.canvas
        if self.tab.error_message or canvas.opengl_error:
            self.fail(self.tab.error_message or canvas.opengl_error)
            return
        if not canvas.info or not self.view or not self.view.isValid():
            return
        if self.renderer == "retained":
            mesh = self.view.retained_renderer
            if (
                not canvas.gpu_scene
                or not mesh
                or mesh.geometry_uploads != 1
                or not self.retained_presented
            ):
                return
        elif not canvas.frame or canvas.inflight:
            return
        if not self.warm_zoom:
            self.snapshot("overview")
            canvas.zoom_at(QPointF(canvas.width() / 2, canvas.height() / 2), 4)
            self.warm_zoom = True
            return
        if canvas.navigating or canvas.inflight or canvas.caption_cache is None:
            return
        if self.renderer == "textures":
            resolution = canvas.frame["image"].width() / canvas.frame["rect"].width()
            if abs(resolution / (canvas.scale * canvas.devicePixelRatioF()) - 1) > 0.02:
                return
        self.poll.stop()
        self.snapshot("detail")
        self.start_camera, self.home_scale = QPointF(canvas.camera), canvas.scale / 4
        self.start_t = self.last_tick = time.perf_counter()
        self.previous_phase = None
        self.before = self.gpu_stats()
        self.active = True
        self.record("begin")
        self.heartbeat_thread = threading.Thread(target=self.heartbeat, daemon=True)
        self.heartbeat_thread.start()
        self.ticks.start()
        print("NAVIGATION_STARTED", self.renderer, flush=True)

    def heartbeat(self):
        previous = time.perf_counter()
        while not self.stop_heartbeat.wait(0.002):
            now = time.perf_counter()
            if self.active:
                self.heartbeat_gaps.append((now - previous) * 1000)
            previous = now

    def step(self):
        if self.canvas.opengl_error:
            self.fail(self.canvas.opengl_error)
            return
        now = time.perf_counter()
        elapsed = now - self.start_t
        self.gaps.append((now - self.last_tick) * 1000)
        self.last_tick = now
        start = 0
        for name, duration in PHASES:
            if elapsed < start + duration:
                break
            start += duration
        else:
            self.ticks.stop()
            self.active = False
            self.record("end")
            self.stop_heartbeat.set()
            QTimer.singleShot(300, self.loop.quit)
            return
        progress = (elapsed - start) / duration
        canvas = self.canvas
        if name != self.previous_phase:
            self.record("phase", name=name)
            self.previous_phase = name
            if name == "pan_beyond":
                self.pan_origin, self.pan_width = (
                    QPointF(canvas.camera),
                    canvas.viewport().width(),
                )
            if name == "pan_return":
                self.return_origin = QPointF(canvas.camera)
        if name.startswith("pause") or name == "settle":
            return
        input_t = time.perf_counter()
        if name in {"zoom_out", "zoom_in", "zoom_resume"}:
            first, last = {
                "zoom_out": (4, 0.65),
                "zoom_in": (0.65, 10),
                "zoom_resume": (10, 6),
            }[name]
            target = (
                self.home_scale * first * math.exp(math.log(last / first) * progress)
            )
            canvas.zoom_at(
                QPointF(canvas.width() * 0.4, canvas.height() * 0.4),
                target / canvas.scale,
            )
        elif name == "pan_beyond":
            canvas.camera = self.pan_origin + QPointF(
                self.pan_width * 3 * progress, self.pan_width * 0.2 * progress
            )
            canvas.schedule(navigation=True)
        elif name == "pan_return":
            canvas.camera = (
                self.return_origin * (1 - progress) + self.start_camera * progress
            )
            canvas.schedule(navigation=True)
        self.pending.append({"t": input_t, "serial": canvas.serial, "phase": name})

    def run(self):
        try:
            self.loop.exec()
            if self.errors:
                raise RuntimeError(self.errors)
            after = self.gpu_stats()
            self.snapshot("final")
            active = [event for event in self.events if event["active"]]
            latencies = [(item["present_t"] - item["t"]) * 1000 for item in self.inputs]
            scene_ready = next(
                (event["t"] for event in self.events if event["kind"] == "scene_ready"),
                float("inf"),
            )
            compile_start = next(
                (
                    event["t"]
                    for event in self.events
                    if event["kind"] == "compile_start"
                ),
                float("inf"),
            )
            compile_end = next(
                (event["t"] for event in self.events if event["kind"] == "compile"),
                float("inf"),
            )
            return {
                "renderer": self.renderer,
                "timing_scope": "native event-loop presentation and CPU submission; not GPU execution duration",
                "input_scope": "scripted BoardCanvas camera updates; excludes physical trackpad and OS input dispatch",
                "gl_info": self.view.gl_info,
                "gl_error": self.canvas.opengl_error,
                "viewport": [self.canvas.width(), self.canvas.height()],
                "dpr": self.view.devicePixelRatioF(),
                "elapsed_seconds": next(
                    event["t"] for event in self.events if event["kind"] == "end"
                )
                - next(event["t"] for event in self.events if event["kind"] == "begin"),
                "input_to_next_present_ms": summary(latencies),
                "timer_interval_ms": summary(self.gaps),
                "python_heartbeat_gap_ms": summary(self.heartbeat_gaps),
                "preparation_timer_interval_ms": summary(
                    [item["gap_ms"] for item in self.preparation_gaps]
                ),
                "compile_timer_interval_ms": summary(
                    [
                        item["gap_ms"]
                        for item in self.preparation_gaps
                        if compile_start <= item["t"] <= compile_end
                    ]
                ),
                "cpu_submit_ms": summary(
                    [
                        event["cpu_submit_ms"]
                        for event in active
                        if event["kind"] == "swap"
                    ]
                ),
                "caption_layout_ms": summary(
                    [
                        event["duration_ms"]
                        for event in active
                        if event["kind"] == "captions"
                    ]
                ),
                "load_stages": [
                    event
                    for event in self.events
                    if event["kind"]
                    in {"source", "index", "loaded", "compile", "scene_ready"}
                ],
                "first_board_preview_seconds": next(
                    event["t"]
                    for event in self.events
                    if event["kind"] == "swap" and event["content"] != "empty"
                ),
                "first_gpu_geometry_present_seconds": next(
                    (
                        event["t"]
                        for event in self.events
                        if event["kind"] == "swap" and event["content"] == "retained"
                    ),
                    None,
                ),
                "gpu_before": self.before,
                "gpu_after": after,
                "active_raster_calls": [
                    event for event in active if event["kind"] == "render_finish"
                ],
                "raster_calls_after_scene_ready": [
                    event
                    for event in self.events
                    if event["kind"] == "render_start" and event["t"] > scene_ready
                ],
                "unpresented_input_count": len(self.pending),
                "per_phase": {
                    name: summary(
                        [
                            (item["present_t"] - item["t"]) * 1000
                            for item in self.inputs
                            if item["phase"] == name
                        ]
                    )
                    for name, _ in PHASES
                },
                "events": self.events,
                "input_events": [
                    {
                        **item,
                        "t": item["t"] - self.started,
                        "present_t": item["present_t"] - self.started,
                    }
                    for item in self.inputs
                ],
                "preparation_ticks": self.preparation_gaps,
            }
        finally:
            self.active = False
            self.stop_heartbeat.set()
            self.poll.stop()
            self.ticks.stop()
            self.deadline.stop()
            self.tab.shutdown()
            self.tab.close()
            self.patches.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument(
        "--renderer", choices=("retained", "textures"), default="retained"
    )
    parser.add_argument("--width", type=int, default=1000)
    parser.add_argument("--height", type=int, default=700)
    parser.add_argument("--interval", type=int, default=16)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--snapshot-dir", type=Path)
    arguments = parser.parse_args()
    if (
        min(arguments.width, arguments.height, arguments.interval, arguments.timeout)
        < 1
    ):
        parser.error("width, height, interval and timeout must be positive")
    configure_surface_format()
    app = QApplication.instance() or QApplication([])
    if app.platformName() in {"offscreen", "minimal"}:
        parser.error("This benchmark requires a real desktop OpenGL context")
    app.setQuitOnLastWindowClosed(False)
    report = InteractionBenchmark(
        arguments.document,
        renderer=arguments.renderer,
        width=arguments.width,
        height=arguments.height,
        interval=arguments.interval,
        snapshot_dir=arguments.snapshot_dir,
        timeout=arguments.timeout,
    ).run()
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(json.dumps(report, indent=2))
    print(
        json.dumps(
            {
                key: value
                for key, value in report.items()
                if key not in {"events", "input_events", "preparation_ticks"}
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
