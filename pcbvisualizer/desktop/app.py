"""Standalone Qt application with asynchronous native 2D and OpenGL 3D views."""

import sys
from pathlib import Path

from PySide6.QtCore import QEvent, Qt, QThread, QTimer, Signal, Slot
from PySide6.QtGui import QAction, QColor, QKeySequence, QPalette, QSurfaceFormat
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDockWidget,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QStackedLayout,
    QTabWidget,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from .canvas import BoardCanvas
from .document import DocumentWorker
from .probing import probe

FILE_FILTER = "EDA documents (*.PcbDoc *.pcbdoc *.SchDoc *.schdoc *.kicad_pcb *.kicad_sch *.sch);;All files (*)"


class DocumentTab(QWidget):
    loaded = Signal()
    changed = Signal()
    mesh_requested = Signal()
    stop_requested = Signal()

    def __init__(self, path, parent=None):
        super().__init__(parent)
        self.path, self.info, self.solid = Path(path), None, None
        self.error_message, self.mesh_loading, self.probe_target = "", False, None
        self.canvas = BoardCanvas()
        self.stack = QStackedLayout(self)
        self.stack.setContentsMargins(0, 0, 0, 0)
        self.stack.addWidget(self.canvas)
        self.thread = QThread(self)
        self.worker = DocumentWorker(self.path)
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.load)
        self.thread.finished.connect(self.worker.deleteLater)
        self.worker.loaded.connect(self.receive_document)
        self.worker.failed.connect(self.failed)
        self.worker.frame.connect(self.canvas.accept_frame)
        self.worker.picked.connect(self.canvas.accept_pick)
        self.worker.mesh.connect(self.receive_mesh)
        self.canvas.render_requested.connect(self.worker.render)
        self.canvas.pick_requested.connect(self.worker.pick)
        self.mesh_requested.connect(self.worker.build_mesh)
        self.stop_requested.connect(self.worker.shutdown)
        self.canvas.selection_changed.connect(self.changed)
        self.thread.start()

    @Slot(object)
    def receive_document(self, info):
        self.info = info
        self.canvas.set_document(info)
        self.loaded.emit()

    @Slot(str)
    def failed(self, message):
        self.error_message = message
        self.canvas.inflight = False
        self.changed.emit()

    @Slot(object)
    def receive_mesh(self, mesh):
        self.mesh_loading = False
        if self.solid:
            self.solid.set_mesh(mesh)
        self.changed.emit()

    def show_3d(self, enabled):
        if enabled and self.info and self.info["scene3d"].get("board"):
            if self.solid is None:
                from .solid import SolidView

                self.solid = SolidView()
                self.solid.changed.connect(self.changed)
                self.solid.error.connect(self.solid_failed)
                self.stack.addWidget(self.solid)
                self.mesh_loading = True
                self.mesh_requested.emit()
            self.stack.setCurrentWidget(self.solid)
            self.solid.setFocus()
            QTimer.singleShot(1000, self.check_context)
        else:
            self.stack.setCurrentWidget(self.canvas)
        self.changed.emit()

    def is_3d(self):
        return self.solid is not None and self.stack.currentWidget() == self.solid

    @Slot(str)
    def solid_failed(self, message):
        self.stack.setCurrentWidget(self.canvas)
        self.failed(message)

    def check_context(self):
        if self.is_3d() and not self.solid.isValid():
            self.solid_failed(
                "Native OpenGL 3.2 is unavailable. The 2D view remains available."
            )

    def shutdown(self):
        self.canvas.timer.stop()
        self.canvas.release_graphics()
        if self.thread.isRunning():
            self.stop_requested.emit()
        # A renderer never outlives its thread/window, including a tab closed
        # while parsing. No thread is forcibly terminated during a file read.
        self.thread.wait()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("PCBVisualizer")
        self.resize(1280, 850)
        self.setAcceptDrops(True)
        self.tabs = QTabWidget()
        self.tabs.setTabsClosable(True)
        self.tabs.setMovable(True)
        self.tabs.tabCloseRequested.connect(self.close_tab)
        self.tabs.currentChanged.connect(self.mount)
        self.setCentralWidget(self.tabs)
        self.toolbar = QToolBar("Document")
        self.toolbar.setMovable(False)
        self.addToolBar(self.toolbar)
        self.add_action("Open…", self.choose_files, QKeySequence.StandardKey.Open)
        self.add_action("Fit", self.fit, "F")
        self.add_action("+", lambda: self.zoom(1.25), QKeySequence.StandardKey.ZoomIn)
        self.add_action("−", lambda: self.zoom(0.8), QKeySequence.StandardKey.ZoomOut)
        self.toolbar.addSeparator()
        self.action_2d = self.add_action("2D", lambda: self.mode(False))
        self.action_3d = self.add_action("3D", lambda: self.mode(True))
        self.action_2d.setCheckable(True)
        self.action_3d.setCheckable(True)
        self.measure_action = self.add_action("Measure", self.toggle_measure, "M")
        self.measure_action.setCheckable(True)
        self.units_action = self.add_action("Metric (mm)", self.toggle_units, "Q")
        self.units_action.setToolTip("Switch metric / imperial units (Q)")
        self.add_action("Clear measurements", self.clear_measurements)
        self.add_action("Clear selection", self.clear_selection, "Escape")
        quit_action = QAction("Quit", self)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        quit_action.triggered.connect(self.close)
        self.addAction(quit_action)
        sidebar = QWidget()
        self.sidebar_layout = QVBoxLayout(sidebar)
        self.warning = QLabel("Open or drop Altium and KiCad files to begin.")
        self.warning.setWordWrap(True)
        self.sidebar_layout.addWidget(self.warning)
        form = self.form = QFormLayout()
        self.sidebar_layout.addLayout(form)
        self.component = QComboBox()
        self.component.setEditable(True)
        self.component.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self.net = QComboBox()
        self.net.setEditable(True)
        self.net.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        form.addRow("Component", self.component)
        form.addRow("Net", self.net)
        self.search_timer = QTimer(self)
        self.search_timer.setSingleShot(True)
        self.search_timer.setInterval(160)
        self.search_timer.timeout.connect(self.search)
        self.component.editTextChanged.connect(lambda: self.search_timer.start())
        self.net.editTextChanged.connect(lambda: self.search_timer.start())
        self.component.activated.connect(self.commit_search)
        self.net.activated.connect(self.commit_search)
        row = QHBoxLayout()
        self.sidebar_layout.addLayout(row)
        self.two_d_buttons = [
            self.button(row, "Fit selection", self.fit_selection),
            self.button(row, "Reveal layers", self.reveal_selection),
        ]
        self.selection = QLabel()
        self.selection.setWordWrap(True)
        self.sidebar_layout.addWidget(self.selection)
        self.target = QComboBox()
        form.addRow("Probe target", self.target)
        self.target.currentIndexChanged.connect(self.remember_target)
        self.probe_button = QPushButton("Show in target")
        self.probe_button.clicked.connect(self.cross_probe)
        self.sidebar_layout.addWidget(self.probe_button)
        self.probe_status = QLabel()
        self.probe_status.setWordWrap(True)
        self.sidebar_layout.addWidget(self.probe_status)
        self.polygons = QCheckBox("Show polygon pours")
        self.polygons.setChecked(True)
        self.polygons.toggled.connect(self.toggle_polygons)
        self.sidebar_layout.addWidget(self.polygons)
        self.layer_controls = QWidget()
        layer_layout = QVBoxLayout(self.layer_controls)
        layer_layout.setContentsMargins(0, 0, 0, 0)
        self.layers = QListWidget()
        self.layers.itemChanged.connect(self.layer_changed)
        self.layers.currentItemChanged.connect(self.layer_selected)
        layer_layout.addWidget(self.layers, 1)
        row = QHBoxLayout()
        layer_layout.addLayout(row)
        self.button(row, "Show all", lambda: self.all_layers(True))
        self.button(row, "Hide all", lambda: self.all_layers(False))
        self.sidebar_layout.addWidget(self.layer_controls, 1)
        self.unit = QComboBox()
        self.unit.addItems(["mm", "mil", "in"])
        self.unit.currentTextChanged.connect(self.set_unit)
        form.addRow("Measure in", self.unit)
        self.body_controls = QWidget()
        body_layout = QVBoxLayout(self.body_controls)
        body_layout.setContentsMargins(0, 0, 0, 0)
        body_layout.addWidget(QLabel("3D component bodies"))
        self.bodies = QListWidget()
        self.bodies.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        self.bodies.itemSelectionChanged.connect(self.select_bodies)
        body_layout.addWidget(self.bodies)
        row = QHBoxLayout()
        body_layout.addLayout(row)
        self.button(row, "Delete selected", self.delete_bodies)
        self.undo_button = self.button(row, "Undo delete", self.undo_bodies)
        self.undo_action = QAction("Undo body deletion", self)
        self.undo_action.setShortcut(QKeySequence.StandardKey.Undo)
        self.undo_action.triggered.connect(self.undo_bodies)
        self.addAction(self.undo_action)
        row = QHBoxLayout()
        body_layout.addLayout(row)
        for preset in ("top", "bottom", "iso"):
            self.button(
                row,
                preset.title(),
                lambda checked=False, p=preset: self.camera_preset(p),
            )
        self.sidebar_layout.addWidget(self.body_controls)
        self.stats = QLabel()
        self.stats.setWordWrap(True)
        self.sidebar_layout.addWidget(self.stats)
        hint = QLabel(
            "Drag or two-finger scroll to pan. Ctrl/⌘ + wheel to zoom. Double-click or F to fit.\nMeasure: hold ⌘ to snap to pad/via centres.\n3D: drag to rotate; right/Shift-drag to pan; scroll to zoom."
        )
        hint.setWordWrap(True)
        self.sidebar_layout.addWidget(hint)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(sidebar)
        dock = QDockWidget("Inspector", self)
        dock.setWidget(scroll)
        dock.setMinimumWidth(300)
        dock.setFeatures(QDockWidget.DockWidgetFeature.NoDockWidgetFeatures)
        self.addDockWidget(Qt.DockWidgetArea.LeftDockWidgetArea, dock)
        self.statusBar().showMessage(
            "Native Qt rendering · files stay on this computer"
        )
        self.mount()

    def add_action(self, text, callback, shortcut=None):
        action = QAction(text, self)
        if shortcut:
            action.setShortcut(shortcut)
        action.triggered.connect(callback)
        self.toolbar.addAction(action)
        return action

    @staticmethod
    def button(layout, text, callback):
        button = QPushButton(text)
        button.clicked.connect(callback)
        layout.addWidget(button)
        return button

    def current(self):
        return self.tabs.currentWidget()

    def choose_files(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Open EDA documents", "", FILE_FILTER
        )
        self.open_files(paths)

    def open_files(self, paths):
        for path in paths:
            document = DocumentTab(path, self)
            index = self.tabs.addTab(document, Path(path).name + " …")
            document.loaded.connect(self.document_loaded)
            document.changed.connect(self.mount)
            document.canvas.measurement_changed.connect(self.statusBar().showMessage)
            self.tabs.setCurrentIndex(index)
        self.mount()

    @Slot()
    def document_loaded(self):
        document = self.sender()
        index = self.tabs.indexOf(document)
        if index >= 0:
            self.tabs.setTabText(index, document.path.name)
            if document == self.current():
                self.mount()
                document.canvas.fit()
                self.statusBar().showMessage(
                    f"Opened {document.path.name} in {document.info['load_seconds']:.2f}s · native renderer"
                )

    def close_tab(self, index):
        document = self.tabs.widget(index)
        self.tabs.removeTab(index)
        document.shutdown()
        document.deleteLater()
        self.mount()

    def mount(self, *args):
        self.search_timer.stop()
        document = self.current()
        info = document.info if document else None
        self.component.blockSignals(True)
        self.net.blockSignals(True)
        self.layers.blockSignals(True)
        self.polygons.blockSignals(True)
        self.target.blockSignals(True)
        self.component.clear()
        self.net.clear()
        self.layers.clear()
        self.target.clear()
        self.component.addItem("")
        self.net.addItem("")
        solid = bool(document and document.is_3d())
        self.body_controls.setVisible(solid)
        for widget in (self.component, self.net, self.target, self.unit):
            widget.setVisible(not solid)
            self.form.labelForField(widget).setVisible(not solid)
        for widget in (
            self.selection,
            self.probe_button,
            self.probe_status,
            *self.two_d_buttons,
        ):
            widget.setVisible(not solid)
        self.action_2d.setChecked(not document or not document.is_3d())
        self.action_3d.setChecked(bool(document and document.is_3d()))
        self.action_3d.setEnabled(bool(info and info["scene3d"].get("board")))
        self.measure_action.setEnabled(
            bool(info and info["kind"] == "pcb" and not document.is_3d())
        )
        units_enabled = bool(info and info["kind"] == "pcb" and not solid)
        self.units_action.setEnabled(units_enabled)
        self.unit.setEnabled(units_enabled)
        self.update_unit_controls()
        self.probe_button.setEnabled(False)
        self.component.setEnabled(bool(info))
        self.net.setEnabled(bool(info))
        self.polygons.setEnabled(bool(info and info["kind"] == "pcb"))
        self.polygons.setVisible(bool(info and info["kind"] == "pcb" and not solid))
        self.layer_controls.setVisible(
            bool(info and info["kind"] == "pcb" and not solid)
        )
        self.warning.setText(
            document.error_message
            if document and document.error_message
            else "\n".join(
                info["warnings"]
                + (info["scene3d"].get("notes", []) if document.is_3d() else [])
            )
            if info
            else "Loading document…"
            if document
            else "Open or drop an Altium or KiCad document."
        )
        if info:
            canvas = document.canvas
            for widget, rows, selected in (
                (self.component, info["components"], canvas.components),
                (self.net, info["nets"], canvas.nets),
            ):
                widget.addItems(
                    sorted({row["name"] for row in rows.values()}, key=str.casefold)
                )
                widget.setEditText(
                    ", ".join(rows[key]["name"] for key in selected if key in rows)
                )
            for layer in info["layers"]:
                item = QListWidgetItem(layer["name"])
                item.setData(Qt.ItemDataRole.UserRole, layer["id"])
                item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                item.setCheckState(
                    Qt.CheckState.Checked
                    if layer["id"] in canvas.visible
                    else Qt.CheckState.Unchecked
                )
                self.layers.addItem(item)
                if layer["id"] == canvas.active_layer:
                    self.layers.setCurrentItem(item)
            self.polygons.setChecked(canvas.polygons)
            self.measure_action.setChecked(canvas.measuring)
            self.selection.setText(
                f"{len(canvas.components)} component(s), {len(canvas.nets)} net(s) selected"
            )
            self.stats.setText(
                " · ".join(
                    f"{value} {key.replace('_', ' ')}"
                    for key, value in info["stats"].items()
                )
            )
            for i in range(self.tabs.count()):
                other = self.tabs.widget(i)
                if other.info and other.info["kind"] != info["kind"]:
                    self.target.addItem(other.path.name, other)
            if self.target.count() > 1:
                self.target.insertItem(0, "Choose a document…", None)
                self.target.setCurrentIndex(0)
            previous = self.target.findData(document.probe_target)
            if document.probe_target and previous >= 0:
                self.target.setCurrentIndex(previous)
            self.probe_button.setEnabled(
                bool(self.target.count() and (canvas.components or canvas.nets))
            )
            self.update_bodies()
        else:
            self.stats.clear()
            self.selection.clear()
        self.component.blockSignals(False)
        self.net.blockSignals(False)
        self.layers.blockSignals(False)
        self.polygons.blockSignals(False)
        self.target.blockSignals(False)

    def remember_target(self):
        if self.current():
            self.current().probe_target = self.target.currentData()

    def commit_search(self):
        self.search_timer.stop()
        self.search()

    def search(self):
        document = self.current()
        if not document or not document.info:
            return
        for widget, rows, selected in (
            (self.component, document.info["components"], document.canvas.components),
            (self.net, document.info["nets"], document.canvas.nets),
        ):
            query = widget.currentText().strip().casefold()
            if (
                len(selected) > 1
                and query
                == ", ".join(
                    rows[key]["name"] for key in selected if key in rows
                ).casefold()
            ):
                continue
            exact = {
                key for key, row in rows.items() if row["name"].casefold() == query
            }
            matches = exact or {
                key
                for key, row in rows.items()
                if query and query in row["name"].casefold()
            }
            selected.clear()
            selected.update(matches)
        document.canvas.schedule()
        self.selection.setText(
            f"{len(document.canvas.components)} component(s), {len(document.canvas.nets)} net(s) selected"
        )
        self.probe_button.setEnabled(
            bool(
                self.target.count()
                and (document.canvas.components or document.canvas.nets)
            )
        )

    def fit(self):
        document = self.current()
        if document:
            document.solid.fit() if document.is_3d() else document.canvas.fit()

    def zoom(self, factor):
        document = self.current()
        if document:
            if document.is_3d():
                document.solid.zoom *= factor
                document.solid.update()
            else:
                document.canvas.zoom_at(document.canvas.rect().center(), factor)

    def fit_selection(self):
        if self.current() and self.current().info:
            self.current().canvas.fit_selection()

    def clear_selection(self):
        document = self.current()
        if document:
            document.canvas.components.clear()
            document.canvas.nets.clear()
            document.canvas.selected_measurement = None
            document.canvas.set_measuring(False)
            document.canvas.schedule()
            if document.solid:
                document.solid.selected.clear()
                document.solid.update()
            self.mount()

    def layer_changed(self, item):
        document = self.current()
        if document:
            identifier = item.data(Qt.ItemDataRole.UserRole)
            if item.checkState() == Qt.CheckState.Checked:
                document.canvas.visible.add(identifier)
                document.canvas.raise_layer(identifier)
            else:
                document.canvas.visible.discard(identifier)
            document.canvas.schedule()

    def layer_selected(self, item, previous=None):
        document = self.current()
        if document and item:
            document.canvas.raise_layer(item.data(Qt.ItemDataRole.UserRole))

    def all_layers(self, visible):
        document = self.current()
        if document and document.info:
            document.canvas.visible = (
                {layer["id"] for layer in document.info["layers"]} if visible else set()
            )
            document.canvas.schedule()
            self.mount()

    def reveal_selection(self):
        # Reveal only layers containing the selected geometry; mask apertures
        # must not obscure copper merely because another component is selected.
        document = self.current()
        if document and document.info:
            for names, mapping in (
                (document.canvas.components, document.info["component_layers"]),
                (document.canvas.nets, document.info["net_layers"]),
            ):
                for name in names:
                    document.canvas.visible.update(mapping.get(name, set()))
            document.canvas.schedule()
            self.mount()

    def toggle_polygons(self, checked):
        if self.current():
            self.current().canvas.polygons = checked
            self.current().canvas.schedule()

    def toggle_measure(self, checked):
        if self.current():
            canvas = self.current().canvas
            canvas.set_measuring(checked)
            canvas.setFocus()

    def clear_measurements(self):
        if self.current():
            canvas = self.current().canvas
            canvas.cancel_measurement()
            canvas.measurements.clear()
            canvas.selected_measurement = None
            canvas.update()

    def set_unit(self, unit):
        document = self.current()
        if not document or not document.info or unit not in ("mm", "mil", "in"):
            return
        canvas = document.canvas
        canvas.unit = unit
        if unit != "mm":
            canvas.imperial_unit = unit
        canvas.update()
        self.update_unit_controls()

    def toggle_units(self):
        document = self.current()
        if document and document.info:
            canvas = document.canvas
            self.set_unit(canvas.imperial_unit if canvas.unit == "mm" else "mm")

    def update_unit_controls(self):
        document = self.current()
        unit = document.canvas.unit if document and document.info else "mm"
        self.unit.blockSignals(True)
        self.unit.setCurrentText(unit)
        self.unit.blockSignals(False)
        system = "Metric" if unit == "mm" else "Imperial"
        self.units_action.setText(f"{system} ({unit})")
        if document and document.info and document.info["kind"] == "pcb":
            canvas = document.canvas
            if canvas.measurements:
                index = canvas.selected_measurement
                if index is None:
                    index = len(canvas.measurements) - 1
                self.statusBar().showMessage(
                    canvas.distance(*canvas.measurements[index])
                )
            else:
                self.statusBar().showMessage(self.units_action.text())

    def mode(self, solid):
        if self.current():
            self.current().show_3d(solid)

    def camera_preset(self, preset):
        if self.current() and self.current().solid:
            self.current().solid.fit(preset)

    def update_bodies(self):
        self.bodies.blockSignals(True)
        self.bodies.clear()
        solid = self.current().solid if self.current() else None
        if solid and solid.mesh:
            names = {
                obj["id"]: obj["name"]
                for obj in solid.mesh["objects"]
                if obj["id"] is not None and obj["id"] not in solid.deleted
            }
            for identifier, name in names.items():
                item = QListWidgetItem(name)
                item.setData(Qt.ItemDataRole.UserRole, identifier)
                self.bodies.addItem(item)
                item.setSelected(identifier in solid.selected)
        self.undo_button.setEnabled(bool(solid and solid.undo))
        self.bodies.blockSignals(False)
        self.undo_action.setEnabled(bool(solid and solid.undo))

    def select_bodies(self):
        solid = self.current().solid if self.current() else None
        if solid:
            solid.selected = {
                item.data(Qt.ItemDataRole.UserRole)
                for item in self.bodies.selectedItems()
            }
            solid.update()

    def delete_bodies(self):
        if self.current() and self.current().solid:
            self.current().solid.delete_selected()

    def undo_bodies(self):
        if self.current() and self.current().solid:
            self.current().solid.undo_delete()

    def cross_probe(self):
        source, target = self.current(), self.target.currentData()
        if not source or not target or not source.info or not target.info:
            return
        cs, ns, missing = probe(
            source.info, target.info, source.canvas.components, source.canvas.nets
        )
        if cs or ns:
            target.canvas.components, target.canvas.nets = cs, ns
            self.tabs.setCurrentWidget(target)
            target.canvas.fit_selection()
            target.canvas.schedule()
            self.mount()
        self.probe_status.setText(
            f"{len(cs)} component(s), {len(ns)} net(s) matched."
            + (" Unmatched: " + ", ".join(missing) if missing else "")
        )

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):
        self.open_files(
            [url.toLocalFile() for url in event.mimeData().urls() if url.isLocalFile()]
        )
        event.acceptProposedAction()

    def closeEvent(self, event):
        self.search_timer.stop()
        for i in range(self.tabs.count()):
            self.tabs.widget(i).shutdown()
        event.accept()


class DesktopApplication(QApplication):
    def event(self, event):
        if event.type() == QEvent.Type.FileOpen:
            window = getattr(self, "window", None)
            if window:
                window.open_files([event.file()])
            else:
                self.pending = getattr(self, "pending", []) + [event.file()]
            return True
        return super().event(event)


def run(paths=()):
    surface = QSurfaceFormat()
    surface.setVersion(3, 2)
    surface.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
    surface.setDepthBufferSize(24)
    surface.setSamples(4)
    QSurfaceFormat.setDefaultFormat(surface)
    app = QApplication.instance() or DesktopApplication([sys.argv[0]])
    app.setApplicationName("PCBVisualizer")
    app.setOrganizationName("PCBVisualizer")
    app.setStyle("Fusion")
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor("#24272c"))
    palette.setColor(QPalette.ColorRole.WindowText, QColor("#d8dbe0"))
    palette.setColor(QPalette.ColorRole.Base, QColor("#1b1d21"))
    palette.setColor(QPalette.ColorRole.Text, QColor("#d8dbe0"))
    palette.setColor(QPalette.ColorRole.Button, QColor("#363c44"))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor("#d8dbe0"))
    palette.setColor(QPalette.ColorRole.Highlight, QColor("#268eaa"))
    app.setPalette(palette)
    window = MainWindow()
    app.window = window
    window.show()
    window.open_files([*paths, *getattr(app, "pending", [])])
    return app.exec()
