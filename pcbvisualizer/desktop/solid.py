"""Native OpenGL solid meshes, camera controls and body editing."""

import math
from array import array
from itertools import pairwise

from PySide6.QtCore import QEvent, QPointF, Qt, Signal
from PySide6.QtGui import QColor, QMatrix4x4, QVector3D, QVector4D
from PySide6.QtOpenGL import (
    QOpenGLBuffer,
    QOpenGLShader,
    QOpenGLShaderProgram,
    QOpenGLVertexArrayObject,
)
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from shapely import constrained_delaunay_triangles
from shapely.geometry import LineString, Point, Polygon


def build_mesh(scene):
    vertices, objects = array("f"), []
    thickness = scene.get("thickness", 1.6)
    sources = [
        (None, shape, -thickness / 2, thickness, 0x27875D, "Board")
        for shape in scene.get("board", [])
    ]
    sources.extend(
        (
            body.get("id", f"body-{i}"),
            body,
            body.get("z", thickness / 2),
            body["height"],
            body.get("color", 0xAAAAAA),
            body.get("name", "Body"),
        )
        for i, body in enumerate(scene.get("bodies", []))
    )
    for identifier, shape, z, height, color, name in sources:
        polygon = Polygon(shape["outline"], shape.get("holes", []))
        if polygon.is_empty or not polygon.is_valid or height <= 0:
            continue
        first = len(vertices) // 6

        def triangle(points, normal):
            for p in points:
                vertices.extend((*p, *normal))

        for face in constrained_delaunay_triangles(polygon).geoms:
            points = list(face.exterior.coords)[:3]
            triangle([(x, y, z + height) for x, y in points], (0, 0, 1))
            triangle([(x, y, z) for x, y in reversed(points)], (0, 0, -1))
        for ring in [polygon.exterior, *polygon.interiors]:
            coords = list(ring.coords)
            for a, b in pairwise(coords):
                length = math.dist(a, b)
                if not length:
                    continue
                normal = ((b[1] - a[1]) / length, (a[0] - b[0]) / length, 0)
                p, q, r, s = (*a, z), (*b, z), (*b, z + height), (*a, z + height)
                triangle([p, q, r], normal)
                triangle([p, r, s], normal)
        objects.append(
            {
                "id": identifier,
                "first": first,
                "count": len(vertices) // 6 - first,
                "color": color,
                "name": name,
                "polygon": polygon,
                "z": z,
                "top": z + height,
                "opacity": shape.get("opacity", 1),
            }
        )
    extent = max(
        (
            max(abs(v) for v in shape["outline"][i])
            for _, shape, *_ in sources
            for i in range(len(shape["outline"]))
        ),
        default=20,
    )
    return {
        "vertices": vertices.tobytes(),
        "objects": objects,
        "extent": max(
            extent, thickness, max((abs(o["top"]) for o in objects), default=1), 1
        ),
    }


def prism_hit(origin, direction, obj):
    """Intersect an extruded contour in GEOS, avoiding Python triangle scans."""
    distances = []
    if abs(direction.z()) > 1e-10:
        for z in (obj["z"], obj["top"]):
            t = (z - origin.z()) / direction.z()
            point = origin + direction * t
            if t >= 0 and obj["polygon"].covers(Point(point.x(), point.y())):
                distances.append(t)
    square = direction.x() ** 2 + direction.y() ** 2
    if square > 1e-12:
        line = LineString(
            [
                (origin.x(), origin.y()),
                (origin.x() + direction.x() * 2e6, origin.y() + direction.y() * 2e6),
            ]
        )
        intersections = obj["polygon"].boundary.intersection(line)

        def coordinates(geometry):
            if hasattr(geometry, "geoms"):
                for part in geometry.geoms:
                    yield from coordinates(part)
            elif not geometry.is_empty:
                yield from geometry.coords

        for x, y in coordinates(intersections):
            t = (
                (x - origin.x()) * direction.x() + (y - origin.y()) * direction.y()
            ) / square
            z = origin.z() + t * direction.z()
            if t >= 0 and obj["z"] - 1e-6 <= z <= obj["top"] + 1e-6:
                distances.append(t)
    return min(distances) if distances else None


class SolidView(QOpenGLWidget):
    changed = Signal()
    error = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.mesh = None
        self.selected, self.deleted, self.undo = set(), set(), []
        self.yaw, self.pitch, self.zoom = -35.0, 55.0, 1.0
        self.pan = QPointF()
        self.press = self.previous = None
        self.program = None
        self.upload = False

    def set_mesh(self, mesh):
        self.mesh, self.upload = mesh, True
        self.update()

    def fit(self, preset="iso"):
        self.yaw, self.pitch = {"top": (0, 0), "bottom": (0, 180), "iso": (-35, 55)}[
            preset
        ]
        self.zoom, self.pan = 1.0, QPointF()
        self.update()

    def matrix(self):
        extent = (self.mesh or {}).get("extent", 20) * 1.7 / max(0.02, self.zoom)
        aspect = self.width() / max(1, self.height())
        clip = (self.mesh or {}).get("extent", 20) * 10
        projection = QMatrix4x4()
        projection.ortho(
            -extent * aspect, extent * aspect, -extent, extent, -clip, clip
        )
        model = QMatrix4x4()
        model.translate(
            self.pan.x() * extent * 2 / self.height(),
            -self.pan.y() * extent * 2 / self.height(),
            0,
        )
        model.rotate(self.pitch, 1, 0, 0)
        model.rotate(self.yaw, 0, 0, 1)
        return projection * model, model

    def initializeGL(self):
        self.gl = self.context().functions()
        self.gl.initializeOpenGLFunctions()
        self.program = QOpenGLShaderProgram(self)
        vertex = """#version 150
in vec3 position; in vec3 normal; uniform mat4 mvp; uniform mat4 model;
out float light; void main() { gl_Position=mvp*vec4(position,1.0);
light=0.35+0.65*abs(dot(normalize(mat3(model)*normal),normalize(vec3(0.3,0.4,1.0)))); }"""
        fragment = """#version 150
in float light; uniform vec4 color; out vec4 outputColor;
void main() { outputColor=vec4(color.rgb*light,color.a); }"""
        if (
            not self.program.addShaderFromSourceCode(
                QOpenGLShader.ShaderTypeBit.Vertex, vertex
            )
            or not self.program.addShaderFromSourceCode(
                QOpenGLShader.ShaderTypeBit.Fragment, fragment
            )
            or not self.program.link()
        ):
            self.error.emit("Native OpenGL shaders failed: " + self.program.log())
            self.program = None
            return
        self.vao = QOpenGLVertexArrayObject(self)
        self.vao.create()
        self.buffer = QOpenGLBuffer(QOpenGLBuffer.Type.VertexBuffer)
        self.buffer.create()
        self.context().aboutToBeDestroyed.connect(self.cleanup)

    def cleanup(self):
        if self.program:
            self.makeCurrent()
            self.buffer.destroy()
            self.vao.destroy()
            self.program = None
            self.doneCurrent()

    def paintGL(self):
        self.gl.glClearColor(0.106, 0.114, 0.129, 1)
        self.gl.glClear(0x4000 | 0x0100)
        if not self.program or not self.mesh:
            return
        self.gl.glEnable(0x0B71)  # depth testing, including board occlusion
        self.gl.glDisable(0x0B44)  # both sides of imported contours
        self.vao.bind()
        self.buffer.bind()
        self.program.bind()
        if self.upload:
            self.buffer.allocate(self.mesh["vertices"], len(self.mesh["vertices"]))
            self.upload = False
        for name, offset in (("position", 0), ("normal", 12)):
            location = self.program.attributeLocation(name)
            self.program.enableAttributeArray(location)
            self.program.setAttributeBuffer(location, 0x1406, offset, 3, 24)
        mvp, model = self.matrix()
        self.program.setUniformValue("mvp", mvp)
        self.program.setUniformValue("model", model)
        opaque = [obj for obj in self.mesh["objects"] if obj["opacity"] >= 1]
        transparent = sorted(
            (obj for obj in self.mesh["objects"] if obj["opacity"] < 1),
            key=lambda obj: model.map(
                QVector3D(
                    obj["polygon"].centroid.x, obj["polygon"].centroid.y, obj["z"]
                )
            ).z(),
        )
        self.gl.glEnable(0x0BE2)
        self.gl.glBlendFunc(0x0302, 0x0303)
        for obj in opaque + transparent:
            if obj["id"] in self.deleted:
                continue
            self.gl.glDepthMask(obj["opacity"] >= 1)
            color = (
                QColor("#ffe066")
                if obj["id"] in self.selected
                else QColor.fromRgb(obj["color"])
            )
            self.program.setUniformValue(
                "color",
                QVector4D(color.redF(), color.greenF(), color.blueF(), obj["opacity"]),
            )
            self.gl.glDrawArrays(0x0004, obj["first"], obj["count"])
        self.gl.glDepthMask(True)
        self.program.release()
        self.buffer.release()
        self.vao.release()

    def mousePressEvent(self, event):
        self.setFocus()
        self.press = self.previous = event.position()
        self.dragged = False

    def mouseMoveEvent(self, event):
        if self.previous is None:
            return
        delta = event.position() - self.previous
        self.previous = event.position()
        self.dragged |= (event.position() - self.press).manhattanLength() > 4
        if (
            event.buttons() & Qt.MouseButton.RightButton
            or event.modifiers() & Qt.KeyboardModifier.ShiftModifier
        ):
            self.pan += delta
        else:
            self.yaw += delta.x() * 0.5
            self.pitch += delta.y() * 0.5
        self.update()

    def mouseReleaseEvent(self, event):
        if (
            self.press is not None
            and not self.dragged
            and event.button() == Qt.MouseButton.LeftButton
        ):
            hit = self.pick(event.position())
            if not event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
                self.selected = (
                    set() if hit in self.selected else {hit} if hit else set()
                )
            elif hit:
                self.selected.symmetric_difference_update({hit})
            self.changed.emit()
            self.update()
        self.press = self.previous = None

    def pick(self, point):
        if not self.mesh:
            return None
        inverse, valid = self.matrix()[0].inverted()
        if not valid:
            return None
        x, y = point.x() / self.width() * 2 - 1, 1 - point.y() / self.height() * 2
        start, end = inverse.map(QVector3D(x, y, -1)), inverse.map(QVector3D(x, y, 1))
        direction = (end - start).normalized()
        nearest, identifier = math.inf, None
        for obj in self.mesh["objects"]:
            if obj["id"] in self.deleted:
                continue
            distance = prism_hit(start, direction, obj)
            if distance is not None and distance < nearest:
                nearest, identifier = distance, obj["id"]
        return identifier

    def wheelEvent(self, event):
        self.zoom = max(
            0.02, min(100, self.zoom * math.exp(event.angleDelta().y() / 600))
        )
        self.update()
        event.accept()

    def event(self, event):
        if (
            event.type() == QEvent.Type.NativeGesture
            and event.gestureType() == Qt.NativeGestureType.ZoomNativeGesture
        ):
            self.zoom = max(0.02, min(100, self.zoom * (1 + event.value())))
            self.update()
            event.accept()
            return True
        return super().event(event)

    def mouseDoubleClickEvent(self, event):
        self.fit()

    def delete_selected(self):
        if self.selected:
            self.undo.append(set(self.selected))
            self.deleted.update(self.selected)
            self.selected.clear()
            self.changed.emit()
            self.update()

    def undo_delete(self):
        if self.undo:
            self.selected = self.undo.pop()
            self.deleted.difference_update(self.selected)
            self.changed.emit()
            self.update()

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.delete_selected()
        elif event.key() == Qt.Key.Key_Escape:
            self.selected.clear()
            self.changed.emit()
            self.update()
        elif event.key() == Qt.Key.Key_Z and event.modifiers() & (
            Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier
        ):
            self.undo_delete()
        else:
            super().keyPressEvent(event)
