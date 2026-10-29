"""Retained PCB triangles and analytic primitives for the native GL viewport.

Geometry lives in static buffers. Camera motion only changes uniforms;
selection changes a small object-ID lookup texture, preserving draw order.
"""

from PySide6.QtGui import QOpenGLContext, QVector2D
from PySide6.QtOpenGL import (
    QOpenGLBuffer,
    QOpenGLShader,
    QOpenGLShaderProgram,
    QOpenGLTexture,
    QOpenGLVertexArrayObject,
)
from shiboken6 import VoidPtr

VERTEX_SHADER = """#version 150
in vec2 worldPosition;
in vec2 localPosition;
in vec4 shapeParameters;
in vec4 sourceColor;
in vec4 metadata;
in vec2 worldExpansion;
in vec2 localExpansion;
uniform vec2 camera;
uniform vec2 viewport;
uniform vec2 pixelMetrics;
uniform sampler2D objectFlags;
uniform int flagsWidth;
uniform int renderPass;
uniform int showPolygons;
out vec2 local;
flat out vec4 parameters;
flat out vec4 color;
flat out int shape;
flat out int selection;
void main() {
    int objectID = max(0, int(metadata.y + 0.5));
    selection = int(texelFetch(objectFlags,
        ivec2(objectID % flagsWidth, objectID / flagsWidth), 0).r * 255.0 + 0.5);
    shape = int(metadata.x + 0.5);
    parameters = shapeParameters;
    color = sourceColor;
    local = localPosition + localExpansion * pixelMetrics.y;
    vec2 world = worldPosition + worldExpansion * pixelMetrics.y;
    vec2 screen = (world - camera) * pixelMetrics.x;
    gl_Position = vec4(screen.x * 2.0 / viewport.x,
                       -screen.y * 2.0 / viewport.y, 0.0, 1.0);
    bool hole = metadata.w > 0.5;
    if ((showPolygons == 0 && metadata.z > 0.5)
        || (renderPass == 1 && (selection == 0 || hole))
        || (renderPass == 2 && !hole)) {
        gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    }
}
"""

FRAGMENT_SHADER = """#version 150
in vec2 local;
flat in vec4 parameters;
flat in vec4 color;
flat in int shape;
flat in int selection;
uniform int renderPass;
uniform int selectionActive;
out vec4 outputColor;
const vec3 background = vec3(27.0, 29.0, 33.0) / 255.0;
float boxDistance(vec2 p, vec2 halfSize) {
    vec2 q = abs(p) - halfSize;
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
}
float ellipseDistance(vec2 p, vec2 radius) {
    radius = max(radius, vec2(1e-12));
    vec2 normalized = p / radius;
    float k = length(normalized);
    if (k < 1e-8) return -min(radius.x, radius.y);
    // Exact zero contour and unit gradient at the ellipse boundary. Filled
    // ellipses only need this local distance for one-pixel antialiasing.
    return (k - 1.0) * k / max(length(normalized / radius), 1e-12);
}
float distanceToShape() {
    if (shape == 1) {
        return length(vec2(max(abs(local.x) - parameters.x, 0.0), local.y))
               - parameters.y;
    }
    if (shape == 2) return boxDistance(local, parameters.xy);
    if (shape == 3) return boxDistance(local,
        vec2(parameters.x + parameters.y, parameters.y));
    if (shape == 4) return ellipseDistance(local, parameters.xy);
    if (shape == 5) {
        // Noncircular stroked ellipses are tessellated by the scene builder.
        return abs(length(local) - parameters.x) - parameters.z * 0.5;
    }
    if (shape == 6) {
        vec2 halfSize = parameters.xy;
        vec2 radius = min(max(parameters.zw, vec2(0.0)), halfSize);
        vec2 p = abs(local);
        if (min(radius.x, radius.y) > 0.0
            && p.x > halfSize.x - radius.x
            && p.y > halfSize.y - radius.y) {
            return ellipseDistance(p - (halfSize - radius), radius);
        }
        return max(p.x - halfSize.x, p.y - halfSize.y);
    }
    return -1.0;
}
float stripCoverage(float p, float radius, float pixelWidth) {
    pixelWidth = max(pixelWidth, 1e-12);
    return clamp(0.5 + (radius - p) / pixelWidth, 0.0, 1.0)
         - clamp(0.5 + (-radius - p) / pixelWidth, 0.0, 1.0);
}
float tinyCoverage(vec2 halfSize, float area, out bool tiny) {
    vec2 dx = dFdx(local), dy = dFdy(local);
    float determinant = dx.x * dy.y - dx.y * dy.x;
    tiny = false;
    if (abs(determinant) < 1e-20) return 0.0;
    vec2 axisX = vec2(dy.y, -dx.y) / determinant;
    vec2 axisY = vec2(-dy.x, dx.x) / determinant;
    vec2 extent = abs(axisX) * halfSize.x + abs(axisY) * halfSize.y;
    if (max(extent.x, extent.y) >= 0.5) return 0.0;
    tiny = true;
    vec2 offset = axisX * local.x + axisY * local.y;
    vec2 weight = max(vec2(1.0) - abs(offset), vec2(0.0));
    // A normalized tent retains projected area as a subpixel shape moves
    // between pixels, rather than giving every tiny shape half opacity.
    return clamp(area / abs(determinant), 0.0, 1.0) * weight.x * weight.y;
}
void main() {
    float coverage = 1.0;
    if (shape != 0) {
        float distance = distanceToShape();
        coverage = clamp(0.5 - distance / max(fwidth(distance), 1e-12), 0.0, 1.0);
        vec2 footprint = max(fwidth(local), vec2(1e-12));
        if (shape == 1) {
            float radius = parameters.y;
            float aa = max(fwidth(distance), footprint.y);
            coverage = clamp(0.5 - distance / aa, 0.0, 1.0)
                     - clamp(0.5 - (distance + 2.0 * radius) / aa, 0.0, 1.0);
            bool tiny;
            float small = tinyCoverage(vec2(parameters.x + radius, radius),
                4.0 * parameters.x * radius + 3.14159265359 * radius * radius, tiny);
            if (tiny) coverage = small;
        } else if (shape == 2 || shape == 3) {
            float halfLength = parameters.x + (shape == 3 ? parameters.y : 0.0);
            coverage = stripCoverage(local.x, halfLength, footprint.x)
                     * stripCoverage(local.y, parameters.y, footprint.y);
        } else if (shape == 4) {
            bool tiny;
            float small = tinyCoverage(parameters.xy,
                3.14159265359 * parameters.x * parameters.y, tiny);
            if (tiny) coverage = small;
        } else if (shape == 5) {
            float radius = parameters.x, halfWidth = parameters.z * 0.5;
            float radial = length(local);
            float aa = max(fwidth(radial), min(footprint.x, footprint.y));
            coverage = stripCoverage(radial - radius, halfWidth, aa);
            float outer = radius + halfWidth, inner = max(radius - halfWidth, 0.0);
            bool tiny;
            float small = tinyCoverage(vec2(outer),
                3.14159265359 * (outer * outer - inner * inner), tiny);
            if (tiny) coverage = small;
        } else if (shape == 6) {
            bool tiny;
            float area = 4.0 * parameters.x * parameters.y
                       - (4.0 - 3.14159265359) * parameters.z * parameters.w;
            float small = tinyCoverage(parameters.xy, area, tiny);
            if (tiny) coverage = small;
            else if (min(parameters.z, parameters.w) == 0.0) {
                coverage = stripCoverage(local.x, parameters.x, footprint.x)
                         * stripCoverage(local.y, parameters.y, footprint.y);
            }
        }
        if (coverage <= 0.0) discard;
    }
    vec3 rgb = color.rgb;
    if (renderPass == 0 && selectionActive != 0) {
        rgb = background + (rgb - background) * 0.15;
    } else if (renderPass == 1) {
        rgb = selection == 2 ? vec3(255.0, 224.0, 102.0) / 255.0
                             : vec3(57.0, 224.0, 243.0) / 255.0;
    }
    float alpha = color.a * coverage;
    outputColor = vec4(rgb * alpha, alpha);
}
"""


class RetainedGpuScene:
    """GL resources owned and accessed by their viewport's current context."""

    def __init__(self):
        self.context = self.gl = self.program = self.vao = None
        self.vertex_buffer = self.index_buffer = self.flags_texture = None
        self.scene = None
        self.geometry_uploads = self.selection_uploads = 0
        self.vertex_bytes = self.index_bytes = 0
        self.draw_calls = self.total_draw_calls = 0
        self._selection = self._order = None
        self._ordered_entries = []
        self._flags_width = self._flags_height = 1

    @property
    def vertexbytes(self):
        return self.vertex_bytes

    @property
    def indexbytes(self):
        return self.index_bytes

    @property
    def drawcalls(self):
        return self.draw_calls

    def _check_error(self, operation):
        error = self.gl.glGetError()
        if error:
            raise RuntimeError(
                f"Retained layout {operation} failed (OpenGL 0x{error:04x})."
            )

    def initialize(self, context):
        if self.program is not None and self.context == context:
            return
        if QOpenGLContext.currentContext() != context:
            raise RuntimeError(
                "Retained layout initialization needs its current context"
            )
        self.context, self.gl = context, context.functions()
        self.gl.initializeOpenGLFunctions()
        program = QOpenGLShaderProgram()
        if not program.addShaderFromSourceCode(
            QOpenGLShader.ShaderTypeBit.Vertex, VERTEX_SHADER
        ) or not program.addShaderFromSourceCode(
            QOpenGLShader.ShaderTypeBit.Fragment, FRAGMENT_SHADER
        ):
            raise RuntimeError("Retained layout shaders failed: " + program.log())
        attributes = (
            ("worldPosition", 0, 2),
            ("localPosition", 8, 2),
            ("shapeParameters", 16, 4),
            ("sourceColor", 32, 4),
            ("metadata", 48, 4),
            ("worldExpansion", 64, 2),
            ("localExpansion", 72, 2),
        )
        for location, (name, _offset, _size) in enumerate(attributes):
            program.bindAttributeLocation(name, location)
        if not program.link():
            raise RuntimeError(
                "Retained layout shader linking failed: " + program.log()
            )
        self.program = program
        self.vao = QOpenGLVertexArrayObject()
        self.vertex_buffer = QOpenGLBuffer(QOpenGLBuffer.Type.VertexBuffer)
        self.index_buffer = QOpenGLBuffer(QOpenGLBuffer.Type.IndexBuffer)
        if not all(
            resource.create()
            for resource in (self.vao, self.vertex_buffer, self.index_buffer)
        ):
            self.cleanup()
            raise RuntimeError("Retained layout buffers could not be created")
        self.vertex_buffer.setUsagePattern(QOpenGLBuffer.UsagePattern.StaticDraw)
        self.index_buffer.setUsagePattern(QOpenGLBuffer.UsagePattern.StaticDraw)
        self.vao.bind()
        self.vertex_buffer.bind()
        self.index_buffer.bind()
        program.bind()
        for location, (_name, offset, size) in enumerate(attributes):
            program.enableAttributeArray(location)
            program.setAttributeBuffer(location, 0x1406, offset, size, 80)
        program.release()
        self.vao.release()
        self.vertex_buffer.release()

    def set_scene(self, scene):
        if not scene.get("supported"):
            raise ValueError(
                scene.get("reason") or "Unsupported retained layout geometry"
            )
        if self.program is None:
            raise RuntimeError("Retained layout renderer has not been initialized")
        if scene is self.scene:
            return
        vertices, indices = scene["vertices"], scene["indices"]
        if len(vertices) % 80 or len(indices) % 4:
            raise ValueError("Invalid retained layout buffer stride")
        self.vao.bind()
        try:
            self.vertex_buffer.bind()
            self.vertex_buffer.allocate(vertices, len(vertices))
            self.index_buffer.bind()
            self.index_buffer.allocate(indices, len(indices))
        finally:
            self.vao.release()
            self.vertex_buffer.release()
        self._check_error("geometry upload")
        self.scene = scene
        self.vertex_bytes, self.index_bytes = len(vertices), len(indices)
        self.geometry_uploads += 1
        self._selection = self._order = None
        self._ordered_entries = []
        if self.flags_texture is not None:
            self.flags_texture.destroy()
        count = max(1, scene.get("object_count", 1))
        self._flags_width = min(1024, count)
        self._flags_height = (count + self._flags_width - 1) // self._flags_width
        maximum = self.gl.glGetIntegerv(0x0D33)
        maximum = int(maximum[0] if isinstance(maximum, (list, tuple)) else maximum)
        if self._flags_height > maximum:
            raise ValueError("Too many retained layout objects for the graphics driver")
        texture = QOpenGLTexture(QOpenGLTexture.Target.Target2D)
        texture.setFormat(QOpenGLTexture.TextureFormat.R8_UNorm)
        texture.setSize(self._flags_width, self._flags_height)
        texture.setMipLevels(1)
        texture.setMinMagFilters(
            QOpenGLTexture.Filter.Nearest, QOpenGLTexture.Filter.Nearest
        )
        texture.setWrapMode(QOpenGLTexture.WrapMode.ClampToEdge)
        texture.allocateStorage(
            QOpenGLTexture.PixelFormat.Red, QOpenGLTexture.PixelType.UInt8
        )
        if not texture.isStorageAllocated():
            texture.destroy()
            raise RuntimeError("The object selection lookup could not be allocated")
        self.flags_texture = texture
        self._check_error("selection lookup allocation")

    def _update_selection(self, components, nets):
        key = frozenset(components), frozenset(nets)
        if key == self._selection:
            return
        flags = bytearray(self._flags_width * self._flags_height)
        for names, mapping, value in (
            (key[1], self.scene.get("object_nets", {}), 1),
            (key[0], self.scene.get("object_components", {}), 2),
        ):
            for name in names:
                for identifier in mapping.get(name, ()):
                    if 0 < identifier < len(flags):
                        flags[identifier] = value
        pixels = bytes(flags)
        self.flags_texture.setData(
            QOpenGLTexture.PixelFormat.Red,
            QOpenGLTexture.PixelType.UInt8,
            VoidPtr(pixels),
        )
        self._check_error("selection lookup upload")
        self.selection_uploads += 1
        self._selection = key

    def _entries(self, order):
        order = tuple(order)
        if order == self._order:
            return self._ordered_entries
        entries = self.scene.get("entries", [])
        if not order:
            result = entries
        else:
            # Layerless background/outline slots remain in source order.
            blocks = []
            for entry in entries:
                if blocks and blocks[-1][0] == entry.get("layer", ""):
                    blocks[-1][1].append(entry)
                else:
                    blocks.append((entry.get("layer", ""), [entry]))
            ranks = {layer: index for index, layer in enumerate(order)}
            drills = set(self.scene.get("drill_layers", ()))
            layers = iter(
                sorted(
                    (block for block in blocks if block[0]),
                    key=lambda block: (block[0] in drills, ranks.get(block[0], -1)),
                )
            )
            result = []
            for layer, block in blocks:
                result.extend(next(layers)[1] if layer else block)
        self._order, self._ordered_entries = order, result
        return result

    def paint(self, canvas):
        self.draw_calls = 0
        if self.scene is None or not self.scene.get("entries"):
            return
        if QOpenGLContext.currentContext() != self.context:
            raise RuntimeError("Retained layout painting needs its owning context")
        self._update_selection(canvas.components, canvas.nets)
        origin = self.scene.get("origin", (0, 0))
        camera = QVector2D(canvas.camera.x() - origin[0], canvas.camera.y() - origin[1])
        program = self.program
        self.vao.bind()
        program.bind()
        self.flags_texture.bind(0)
        try:
            program.setUniformValue("objectFlags", 0)
            program.setUniformValue("flagsWidth", self._flags_width)
            program.setUniformValue("camera", camera)
            program.setUniformValue(
                "viewport", QVector2D(canvas.width(), canvas.height())
            )
            program.setUniformValue(
                "pixelMetrics",
                QVector2D(
                    canvas.scale,
                    1.0 / max(canvas.scale * canvas.devicePixelRatioF(), 1e-12),
                ),
            )
            program.setUniformValue("showPolygons", int(canvas.polygons))
            selected = bool(canvas.components or canvas.nets)
            program.setUniformValue("selectionActive", int(selected))
            entries = self._entries(canvas.layer_order)
            for render_pass in range(3 if selected else 1):
                program.setUniformValue("renderPass", render_pass)
                for entry in entries:
                    if entry.get("layer") and entry["layer"] not in canvas.visible:
                        continue
                    count = entry["count"]
                    if count:
                        self.gl.glDrawElements(
                            0x0004, count, 0x1405, VoidPtr(entry["first"] * 4)
                        )
                        self.draw_calls += 1
            self.total_draw_calls += self.draw_calls
        finally:
            self.flags_texture.release(0)
            program.release()
            self.vao.release()

    def cleanup(self):
        if self.flags_texture is not None:
            self.flags_texture.destroy()
        for buffer in (self.vertex_buffer, self.index_buffer):
            if buffer is not None:
                buffer.destroy()
        if self.vao is not None:
            self.vao.destroy()
        if self.program is not None:
            self.program.removeAllShaders()
        self.flags_texture = self.vertex_buffer = self.index_buffer = self.vao = None
        self.program = self.context = self.gl = self.scene = None
        self.vertex_bytes = self.index_bytes = self.draw_calls = 0
        self._selection = self._order = None
        self._ordered_entries = []
