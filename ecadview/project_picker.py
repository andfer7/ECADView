"""Run the native project chooser on an isolated Qt main thread."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading


def worker(result_path: str) -> None:
    """Choose a project in the helper process; cancellation is an empty path."""
    result = {}
    try:
        platform = os.environ.get("QT_QPA_PLATFORM", "").split(":", 1)[0]
        if platform in {"offscreen", "minimal"} or (
            sys.platform.startswith("linux")
            and not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY")
        ):
            raise RuntimeError("A desktop display is required for the project picker. "
                               "Drop the whole project folder onto the viewer.")
        from PySide6.QtWidgets import QApplication, QDialog, QFileDialog

        app = QApplication.instance() or QApplication(["ECADView"])
        app.setApplicationName("ECADView")
        dialog = QFileDialog()
        dialog.setWindowTitle("Open Altium project")
        dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptOpen)
        dialog.setNameFilter("Altium projects (*.PrjPcb *.PrjPCB *.prjpcb *.PRJPCB)")
        dialog.show()
        dialog.raise_()
        dialog.activateWindow()
        result["path"] = dialog.selectedFiles()[0] if dialog.exec() == QDialog.DialogCode.Accepted else None
        del dialog
        del app
    except Exception as error:
        result = {"error": str(error)}
    Path(result_path).write_text(json.dumps(result), encoding="utf-8")


def _stop(child) -> None:
    if child.poll() is not None:
        return
    try:
        child.terminate()
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            child.kill()
        except ProcessLookupError:
            pass
        child.wait()


class ProjectPicker:
    """Keep one chooser per local server and reap it when the viewer closes."""

    def __init__(self):
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self._process_lock = threading.Lock()
        self._process = None

    def choose(self) -> Path | None:
        if self.stopping.is_set():
            return None
        command = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "ecadview.cli"]
        with tempfile.TemporaryDirectory(prefix="ecadview-project-") as temporary:
            result_path = Path(temporary) / "selection.json"
            with self._process_lock:
                if self.stopping.is_set():
                    return None
                child = subprocess.Popen([*command, "--project-picker-worker", str(result_path)],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                self._process = child
            with child:
                try:
                    while not self.stopping.is_set():
                        try:
                            _, errors = child.communicate(timeout=.2)
                            break
                        except subprocess.TimeoutExpired:
                            continue
                    else:
                        return None
                    if self.stopping.is_set():
                        return None
                    if child.returncode or not result_path.is_file():
                        detail = errors.decode("utf-8", errors="replace").strip()[-500:]
                        raise RuntimeError("Could not open the project picker. "
                                           "Drop the whole project folder onto the viewer." +
                                           (f" {detail}" if detail else ""))
                    result = json.loads(result_path.read_text(encoding="utf-8"))
                    if result.get("error"):
                        raise RuntimeError(result["error"])
                    selected = result.get("path")
                    if selected is not None and not isinstance(selected, str):
                        raise RuntimeError("The project picker returned an invalid file path.")
                    return Path(selected) if selected else None
                finally:
                    _stop(child)
                    with self._process_lock:
                        if self._process is child:
                            self._process = None

    def close(self) -> None:
        self.stopping.set()
        with self._process_lock:
            child = self._process
        if child is not None:
            _stop(child)
