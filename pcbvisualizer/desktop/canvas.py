"""Cached native viewport: navigation paints images, never an SVG DOM."""

import math
from bisect import bisect_left, bisect_right

from PySide6.QtCore import QEvent, QPointF, QRectF, Qt, QTimer, Signal, Slot
from PySide6.QtGui import QColor, QCursor, QFont, QPainter, QPen
from PySide6.QtWidgets import QApplication, QWidget

# Qt maps Command on macOS to ControlModifier / Key_Control.
SNAP_MODIFIER = Qt.KeyboardModifier.ControlModifier


class BoardCanvas(QWidget):
    render_requested = Signal(object)
    pick_requested = Signal(object)
    selection_changed = Signal()
    measurement_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setMouseTracking(True)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)
        self.info = None
        self.camera, self.scale = QPointF(), 1.0
        self.frame = None
        self.overview = None
        self.caption_sizes, self.caption_font_key = {}, None
        self.visible, self.components, self.nets = set(), set(), set()
        self.layer_order, self.active_layer = [], None
        self.polygons, self.measuring, self.unit = True, False, "mm"
        self.imperial_unit = "mil"
        self.measurements, self.points = [], []
        self.selected_measurement = None
        self.measure_pointer = None
        self.measure_snapping = False
        self.snap_points, self.snap_x = [], []
        self.press = self.previous = None
        self.inflight, self.dirty, self.serial = False, False, 0
        self.paint_count = self.render_count = 0
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.setInterval(90)
        self.timer.timeout.connect(self.request_frame)

    def set_document(self, info):
        self.info = info
        self.frame = self.overview = None
        self.caption_sizes.clear()
        self.snap_points = sorted(
            info.get("snap_points", []), key=lambda row: row[0].x()
        )
        self.snap_x = [point.x() for point, layers in self.snap_points]
        self.visible = {layer["id"] for layer in info["layers"] if layer["visible"]}
        self.layer_order = [layer["id"] for layer in info["layers"]]
        self.active_layer = None
        self.fit()

    def raise_layer(self, identifier):
        if self.info and self.info["kind"] == "pcb" and identifier in self.layer_order:
            self.active_layer = identifier
            self.layer_order.remove(identifier)
            self.layer_order.append(identifier)
            self.schedule()

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
        self.schedule(navigation=True)

    def viewport(self):
        return QRectF(
            self.to_world(QPointF()),
            self.to_world(QPointF(self.width(), self.height())),
        )

    def style_key(self):
        return (
            frozenset(self.visible),
            self.polygons,
            frozenset(self.components),
            frozenset(self.nets),
            tuple(self.layer_order),
        )

    def schedule(self, navigation=False):
        if self.info:
            self.serial += 1
            self.dirty = True
            # Transform the cache immediately; refine after a gesture pauses.
            # Outside the cached area keep refreshing during a long pan too.
            covered = self.frame and self.frame["rect"].contains(self.viewport())
            if (navigation and covered) or not self.timer.isActive():
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
        style = self.style_key()
        if self.frame and self.frame.get("style") == style:
            resolution = self.frame["image"].width() / self.frame["rect"].width()
            desired = self.scale * min(
                self.devicePixelRatioF(),
                4096 / max(self.width() * 1.4, self.height() * 1.4),
            )
            if (
                self.frame["rect"].contains(self.viewport())
                and abs(resolution / desired - 1) < 0.01
            ):
                self.dirty = False
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
                "style": style,
            }
        )

    @Slot(object)
    def accept_frame(self, frame):
        self.inflight = False
        self.render_count = frame["renders"]
        # A stale camera frame is still useful while navigating. A stale style
        # will be replaced by the one coalesced request as soon as this returns.
        self.frame = frame
        if self.overview and self.overview.get("style") != frame.get("style"):
            self.overview = None
        if self.info and frame["rect"].contains(self.info["home"]):
            self.overview = frame
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
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        if self.frame:
            frames = [self.frame]
            if (
                self.overview
                and self.overview is not self.frame
                and not self.frame["rect"].contains(self.viewport())
            ):
                frames.insert(0, self.overview)
            for frame in frames:
                rect = frame["rect"]
                target = QRectF(
                    self.to_screen(rect.topLeft()), self.to_screen(rect.bottomRight())
                )
                painter.drawImage(target, frame["image"])
        else:
            painter.setPen(QColor("#c8d0d8"))
            painter.drawText(
                self.rect(),
                Qt.AlignmentFlag.AlignCenter,
                "Rendering…" if self.info else "Open or drop an Altium or KiCad file",
            )
        if self.info:
            self.paint_captions(painter)
        self.paint_measurements(painter)
        painter.end()

    def paint_measurements(self, painter):
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setFont(QFont("Sans Serif", 14, QFont.Weight.DemiBold))
        pen = QPen(QColor("#ffffff"), 3)
        painter.setPen(pen)
        painter.setBrush(QColor("#1b1d21"))

        def marker(point):
            painter.drawEllipse(point, 6, 6)
            painter.drawLine(point - QPointF(10, 0), point + QPointF(10, 0))
            painter.drawLine(point - QPointF(0, 10), point + QPointF(0, 10))

        for index, (a, b) in enumerate(self.measurements):
            pen.setWidthF(4 if index == self.selected_measurement else 3)
            painter.setPen(pen)
            p, q = self.to_screen(a), self.to_screen(b)
            painter.drawLine(p, q)
            painter.drawText((p + q) / 2 + QPointF(5, -5), self.distance(a, b))
            if index == self.selected_measurement:
                self.paint_measurement_axes(painter, a, b)
            marker(p)
            marker(q)
        pen.setWidthF(3)
        painter.setPen(pen)
        if self.measuring:
            target, _snapped = (
                self.measurement_position(self.measure_pointer, self.measure_snapping)
                if self.measure_pointer is not None
                else (None, False)
            )
            if self.points:
                a = self.points[0]
                p = self.to_screen(a)
                if target is not None:
                    q = self.to_screen(target)
                    pen.setStyle(Qt.PenStyle.DashLine)
                    painter.setPen(pen)
                    painter.drawLine(p, q)
                    painter.drawText(
                        (p + q) / 2 + QPointF(5, -5), self.distance(a, target)
                    )
                    pen.setStyle(Qt.PenStyle.SolidLine)
                    painter.setPen(pen)
                marker(p)
            if target is not None:
                marker(self.to_screen(target))
        painter.restore()

    def paint_measurement_axes(self, painter, a, b):
        painter.save()
        painter.setPen(QPen(QColor("#ffffff"), 3, Qt.PenStyle.DashLine))
        corner = QPointF(b.x(), a.y())
        p, q, c = self.to_screen(a), self.to_screen(b), self.to_screen(corner)
        painter.drawLine(p, c)
        painter.drawLine(c, q)
        metrics = painter.fontMetrics()
        x_label = f"X: {self.distance(a, corner)}"
        y_label = f"Y: {self.distance(corner, b)}"
        # Put component labels outside the triangle, keeping axis-aligned
        # measurements legible when a dashed leg coincides with the total.
        x_offset = -18 if q.y() > p.y() else metrics.height() + 10
        y_offset = 16 if q.x() > p.x() else -metrics.horizontalAdvance(y_label) - 16
        painter.drawText(
            (p + c) / 2 + QPointF(-metrics.horizontalAdvance(x_label) / 2, x_offset),
            x_label,
        )
        painter.drawText((c + q) / 2 + QPointF(y_offset, metrics.height() / 3), y_label)
        painter.restore()

    def measurement_at(self, position):
        closest, distance = None, 6 * 6
        for index in reversed(range(len(self.measurements))):
            a, b = (self.to_screen(point) for point in self.measurements[index])
            line = b - a
            length = line.x() ** 2 + line.y() ** 2
            offset = position - a
            fraction = (
                max(0, min(1, (offset.x() * line.x() + offset.y() * line.y()) / length))
                if length
                else 0
            )
            delta = position - (a + line * fraction)
            squared = delta.x() ** 2 + delta.y() ** 2
            if squared < distance:
                closest, distance = index, squared
        return closest

    def measurement_position(self, position, snap):
        point = self.to_world(position)
        if not snap or not self.info or self.info["kind"] != "pcb":
            return point, False
        radius = 12 / self.scale
        lo = bisect_left(self.snap_x, point.x() - radius)
        hi = bisect_right(self.snap_x, point.x() + radius)
        closest, distance = None, radius * radius
        for index in range(lo, hi):
            center, layers = self.snap_points[index]
            if not self.visible.intersection(layers):
                continue
            delta = center - point
            squared = delta.x() ** 2 + delta.y() ** 2
            if squared <= distance:
                closest, distance = center, squared
        return (QPointF(closest), True) if closest is not None else (point, False)

    def set_measuring(self, enabled):
        self.measuring = enabled
        if enabled:
            self.setCursor(Qt.CursorShape.CrossCursor)
        else:
            self.unsetCursor()
        self.cancel_measurement()

    def cancel_measurement(self):
        self.points.clear()
        self.measure_pointer = (
            QPointF(self.mapFromGlobal(QCursor.pos())) if self.measuring else None
        )
        self.measure_snapping = bool(
            self.measuring and QApplication.keyboardModifiers() & SNAP_MODIFIER
        )
        self.update()

    def paint_captions(self, painter):
        if (
            self.info["kind"] != "pcb"
            or self.scale * self.info["home"].width() / max(1, self.width()) < 2
        ):
            return
        painter.setFont(QFont("Sans Serif", 9))
        metrics = painter.fontMetrics()
        font_key = (
            painter.font().key(),
            painter.device().logicalDpiX(),
            painter.device().logicalDpiY(),
        )
        if self.caption_font_key != font_key:
            self.caption_font_key = font_key
            self.caption_sizes.clear()
        viewport = self.viewport()
        occupied = []
        for bounds, pin, net, layer, polygon, component in self.info["captions"]:
            if layer not in self.visible or polygon and not self.polygons:
                continue
            # Cull in world space before transforming or measuring any text.
            if (
                not bounds.intersects(viewport)
                or bounds.height() * self.scale < metrics.height() + 4
            ):
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
            if text not in self.caption_sizes:
                lines = text.splitlines()
                self.caption_sizes[text] = (
                    max(metrics.horizontalAdvance(row) for row in lines) + 6,
                    metrics.height() * len(lines) + 4,
                )
            width, height = self.caption_sizes[text]
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
            self.schedule(navigation=True)
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

    def enterEvent(self, event):
        if self.measuring:
            self.measure_pointer = event.position()
            self.measure_snapping = bool(
                QApplication.keyboardModifiers() & SNAP_MODIFIER
            )
            self.update()
        super().enterEvent(event)

    def mouseMoveEvent(self, event):
        if self.previous is not None:
            delta = event.position() - self.previous
            self.previous = event.position()
            self.dragged |= (event.position() - self.press).manhattanLength() > 4
            if self.dragged:
                self.camera -= delta / self.scale
                self.schedule(navigation=True)
        if self.measuring:
            self.measure_pointer = event.position()
            self.measure_snapping = bool(event.modifiers() & SNAP_MODIFIER)
            self.update()

    def mouseReleaseEvent(self, event):
        if (
            self.press is not None
            and not self.dragged
            and event.button() == Qt.MouseButton.LeftButton
            and self.info
        ):
            if not self.measuring or (
                not self.points and not event.modifiers() & SNAP_MODIFIER
            ):
                measurement = self.measurement_at(event.position())
                if measurement is not None:
                    self.selected_measurement = (
                        None
                        if measurement == self.selected_measurement
                        else measurement
                    )
                    if self.measuring:
                        self.measure_pointer = event.position()
                        self.measure_snapping = False
                    self.press = self.previous = None
                    self.update()
                    return
            self.selected_measurement = None
            point = self.to_world(event.position())
            if self.measuring:
                point, _snapped = self.measurement_position(
                    event.position(), bool(event.modifiers() & SNAP_MODIFIER)
                )
                self.points.append(point)
                self.measure_pointer = event.position()
                self.measure_snapping = bool(event.modifiers() & SNAP_MODIFIER)
                if len(self.points) == 2:
                    a, b = self.points
                    self.measurements.append((a, b))
                    self.points.clear()
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
                            tuple(self.layer_order),
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
            self.selected_measurement = None
            self.set_measuring(False)
            self.components.clear()
            self.nets.clear()
            self.schedule()
            self.selection_changed.emit()
        elif event.key() == Qt.Key.Key_Control and self.measuring:
            self.measure_snapping = True
            self.update()
        else:
            super().keyPressEvent(event)

    def keyReleaseEvent(self, event):
        if event.key() == Qt.Key.Key_Control and self.measuring:
            self.measure_snapping = False
            self.update()
        else:
            super().keyReleaseEvent(event)

    def focusOutEvent(self, event):
        self.measure_snapping = False
        self.update()
        super().focusOutEvent(event)
