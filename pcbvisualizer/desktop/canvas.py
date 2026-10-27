"""Cached native viewport: navigation paints images, never an SVG DOM."""

import math

from PySide6.QtCore import QEvent, QPointF, QRectF, Qt, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QWidget


class BoardCanvas(QWidget):
    render_requested = Signal(object)
    pick_requested = Signal(object)
    selection_changed = Signal()
    measurement_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMouseTracking(True)
        self.info = None
        self.camera, self.scale = QPointF(), 1.0
        self.frame = None
        self.visible, self.components, self.nets = set(), set(), set()
        self.polygons, self.measuring, self.unit = True, False, "mm"
        self.measurements, self.points = [], []
        self.press = self.previous = None
        self.inflight, self.dirty, self.serial = False, False, 0
        self.paint_count = self.render_count = 0
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.setInterval(90)
        self.timer.timeout.connect(self.request_frame)

    def set_document(self, info):
        self.info = info
        self.visible = {layer["id"] for layer in info["layers"] if layer["visible"]}
        self.fit()

    def to_world(self, point):
        return (
            self.camera
            + (point - QPointF(self.width() / 2, self.height() / 2)) / self.scale
        )

    def to_screen(self, point):
        return (point - self.camera) * self.scale + QPointF(
            self.width() / 2, self.height() / 2
        )

    def fit(self, bounds=None):
        if not self.info:
            return
        bounds = bounds or self.info["home"]
        self.camera = bounds.center()
        self.scale = min(
            max(1, self.width() - 40) / max(bounds.width(), 0.1),
            max(1, self.height() - 40) / max(bounds.height(), 0.1),
        )
        self.schedule()

    def fit_selection(self):
        bounds = QRectF()
        for names, mapping in (
            (self.components, self.info["component_bounds"]),
            (self.nets, self.info["net_bounds"]),
        ):
            for name in names:
                if name in mapping:
                    bounds = bounds.united(mapping[name])
        if not bounds.isEmpty():
            self.fit(bounds.adjusted(-1, -1, 1, 1))

    def zoom_at(self, point, factor):
        before = self.to_world(point)
        self.scale = max(0.001, min(100000, self.scale * factor))
        self.camera += before - self.to_world(point)
        self.schedule()

    def schedule(self):
        if self.info:
            self.serial += 1
            self.dirty = True
            if not self.timer.isActive():
                self.timer.start()
        self.update()

    def request_frame(self):
        if (
            not self.info
            or self.inflight
            or not self.dirty
            or not self.width()
            or not self.height()
        ):
            return
        self.dirty, self.inflight = False, True
        # Overscan allows panning from the cached frame while the worker renders
        # the next view. The cache has a hard pixel bound, independent of zoom.
        width, height = self.width() * 1.4, self.height() * 1.4
        dpr = min(self.devicePixelRatioF(), 4096 / max(width, height))
        rect = QRectF(
            self.camera.x() - width / self.scale / 2,
            self.camera.y() - height / self.scale / 2,
            width / self.scale,
            height / self.scale,
        )
        self.render_requested.emit(
            {
                "token": self.serial,
                "rect": rect,
                "width": max(1, int(width * dpr)),
                "height": max(1, int(height * dpr)),
                "style": (
                    set(self.visible),
                    self.polygons,
                    set(self.components),
                    set(self.nets),
                ),
            }
        )

    @Slot(object)
    def accept_frame(self, frame):
        self.inflight = False
        self.render_count = frame["renders"]
        # A stale camera frame is still useful while navigating. A stale style
        # will be replaced by the one coalesced request as soon as this returns.
        self.frame = frame
        self.update()
        if self.dirty:
            self.timer.start()

    @Slot(object)
    def accept_pick(self, message):
        result, shift = message["result"], message["shift"]
        if self.info["kind"] == "pcb":
            if result:
                for selected, names in (
                    (self.components, result["components"]),
                    (self.nets, result["nets"]),
                ):
                    names = set(names)
                    if not names:
                        continue
                    if names <= selected:
                        selected.difference_update(names)
                    else:
                        if not shift:
                            selected.clear()
                        selected.update(names)
            self.schedule()
            self.selection_changed.emit()
            return
        if not result:
            if not shift:
                self.components.clear()
                self.nets.clear()
        else:
            cs, ns = set(result["components"]), set(result["nets"])
            # Schematic pins/wires select nets; body targets select components.
            if self.info["kind"] == "schematic" and ns:
                cs.clear()
            if cs <= self.components and ns <= self.nets:
                self.components.difference_update(cs)
                self.nets.difference_update(ns)
            else:
                if not shift:
                    self.components.clear()
                    self.nets.clear()
                self.components.update(cs)
                self.nets.update(ns)
        self.schedule()
        self.selection_changed.emit()

    def paintEvent(self, event):
        self.paint_count += 1
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#1b1d21"))
        if self.frame:
            rect = self.frame["rect"]
            target = QRectF(
                self.to_screen(rect.topLeft()), self.to_screen(rect.bottomRight())
            )
            painter.drawImage(target, self.frame["image"])
        else:
            painter.setPen(QColor("#c8d0d8"))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "Rendering…" if self.info else "Open or drop an Altium or KiCad file",
            )
        if self.info:
            self.paint_captions(painter)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QPen(QColor("#35c2d8"), 1.5))
        for a, b in self.measurements:
            p, q = self.to_screen(a), self.to_screen(b)
            painter.drawLine(p, q)
            painter.drawText((p + q) / 2 + QPointF(5, -5), self.distance(a, b))
        for p in self.points:
            painter.drawEllipse(self.to_screen(p), 4, 4)
        painter.end()

    def paint_captions(self, painter):
        if (
            self.info["kind"] != "pcb"
            or self.scale * self.info["home"].width() / max(1, self.width()) < 2
        ):
            return
        painter.setFont(QFont("Sans Serif", 9))
        occupied = []
        for bounds, pin, net, layer, polygon, component in self.info["captions"]:
            if layer not in self.visible or polygon and not self.polygons:
                continue
            if (
                (self.components or self.nets)
                and component not in self.components
                and net not in self.nets
            ):
                continue
            rect = QRectF(
                self.to_screen(bounds.topLeft()), self.to_screen(bounds.bottomRight())
            )
            text = pin + ("\n" + net if net else "")
            width = (
                max(
                    painter.fontMetrics().horizontalAdvance(row)
                    for row in text.splitlines()
                )
                + 6
            )
            height = painter.fontMetrics().height() * len(text.splitlines()) + 4
            if (
                rect.width() < width
                or rect.height() < height
                or not self.rect().intersects(rect.toRect())
            ):
                continue
            caption = QRectF(
                rect.center().x() - width / 2,
                rect.center().y() - height / 2,
                width,
                height,
            )
            if any(caption.intersects(other) for other in occupied):
                continue
            if not self.frame:
                continue
            image, view = self.frame["image"], self.frame["rect"]
            placed = False
            for dx, dy in ((0, 0), (0, -0.25), (0, 0.25), (-0.25, 0), (0.25, 0)):
                candidate = caption.translated(dx * rect.width(), dy * rect.height())
                if not rect.contains(candidate) or any(
                    candidate.intersects(other) for other in occupied
                ):
                    continue
                probes = [
                    self.to_world(QPointF(x, y))
                    for x in (
                        candidate.left(),
                        candidate.center().x(),
                        candidate.right(),
                    )
                    for y in (
                        candidate.top(),
                        candidate.center().y(),
                        candidate.bottom(),
                    )
                ]
                pixels = [
                    (
                        int((p.x() - view.x()) / view.width() * image.width()),
                        int((p.y() - view.y()) / view.height() * image.height()),
                    )
                    for p in probes
                ]
                if not all(
                    0 <= x < image.width()
                    and 0 <= y < image.height()
                    and image.pixelColor(x, y) != QColor("#1b1d21")
                    for x, y in pixels
                ):
                    continue
                painter.fillRect(candidate, QColor(20, 24, 28, 215))
                painter.setPen(QColor("#f7fbff"))
                painter.drawText(candidate, Qt.AlignmentFlag.AlignCenter, text)
                occupied.append(candidate)
                placed = True
                break
            if not placed:
                continue
            if len(occupied) >= 100:
                break

    def distance(self, a, b):
        factor, digits = {"mm": (1, 3), "mil": (1000 / 25.4, 1), "in": (1 / 25.4, 4)}[
            self.unit
        ]
        return f"{math.hypot(b.x() - a.x(), b.y() - a.y()) * factor:.{digits}f} {self.unit}"

    def resizeEvent(self, event):
        self.schedule()

    def wheelEvent(self, event):
        if event.modifiers() & (
            Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier
        ):
            self.zoom_at(event.position(), math.exp(event.angleDelta().y() / 600))
        else:
            delta = event.pixelDelta()
            if delta.isNull():
                delta = event.angleDelta() / 3
            self.camera -= QPointF(delta) / self.scale
            self.schedule()
        event.accept()

    def event(self, event):
        if (
            event.type() == QEvent.Type.NativeGesture
            and event.gestureType() == Qt.NativeGestureType.ZoomNativeGesture
        ):
            self.zoom_at(event.position(), max(0.01, 1 + event.value()))
            event.accept()
            return True
        return super().event(event)

    def mousePressEvent(self, event):
        self.setFocus()
        self.press = self.previous = event.position()
        self.dragged = False

    def mouseMoveEvent(self, event):
        if self.previous is not None:
            delta = event.position() - self.previous
            self.previous = event.position()
            self.dragged |= (event.position() - self.press).manhattanLength() > 4
            if self.dragged:
                self.camera -= delta / self.scale
                self.schedule()

    def mouseReleaseEvent(self, event):
        if (
            self.press is not None
            and not self.dragged
            and event.button() == Qt.MouseButton.LeftButton
            and self.info
        ):
            point = self.to_world(event.position())
            if self.measuring:
                self.points.append(point)
                if len(self.points) == 2:
                    a, b = self.points
                    self.measurements.append((a, b))
                    self.points = []
                    self.measurement_changed.emit(self.distance(a, b))
                self.update()
            else:
                self.pick_requested.emit(
                    {
                        "args": (
                            point,
                            4 / self.scale,
                            set(self.visible),
                            self.polygons,
                        ),
                        "shift": bool(
                            event.modifiers() & Qt.KeyboardModifier.ShiftModifier
                        ),
                    }
                )
        self.press = self.previous = None

    def mouseDoubleClickEvent(self, event):
        self.fit()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape:
            self.points = []
            self.measuring = False
            self.components.clear()
            self.nets.clear()
            self.schedule()
            self.selection_changed.emit()
        else:
            super().keyPressEvent(event)
