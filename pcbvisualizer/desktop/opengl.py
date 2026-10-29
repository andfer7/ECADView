"""Retained layout geometry with cached image fallback and native overlays."""

import time

from PySide6.QtCore import QRectF, Qt, Signal
from PySide6.QtGui import QImage, QOpenGLContext, QPainter, QSurfaceFormat
from PySide6.QtOpenGL import QOpenGLTexture, QOpenGLTextureBlitter
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from shiboken6 import VoidPtr


class LayoutOpenGLView(QOpenGLWidget):
    """GPU layout presentation owned by the canvas's native input controller.

    Supported documents upload geometry once; navigation updates the camera and
    highlighting updates a small object lookup. Cached overview/detail images
    provide the first preview and fallback for unsupported SVG composition.
    Qt's OpenGL painter draws captions and measurements above either scene.
    """

    failed = Signal(str)
    initialized = Signal(object)

    def __init__(self, canvas):
        super().__init__(canvas)
        surface = QSurfaceFormat()
        surface.setVersion(3, 2)
        surface.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
        surface.setSamples(4)
        surface.setDepthBufferSize(0)
        surface.setStencilBufferSize(0)
        self.setFormat(surface)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.canvas = canvas
        self.uploads = self.paint_count = 0
        self.last_paint_ms = self.paint_ms_total = 0.0
        self.vendor = self.renderer = self.version = ""
        self.max_texture_size = 0
        self.gl_info = {}
        self.gl = self.blitter = self._context = None
        self.textures = {}
        self.retained_renderer = None
        self._ready = self._failed = self._cleaning = False

    @property
    def texture_count(self):
        return len(self.textures)

    @property
    def texture_bytes(self):
        return sum(size for _texture, size in self.textures.values())

    def initializeGL(self):
        try:
            self._context = self.context()
            self.gl = self._context.functions()
            self.gl.initializeOpenGLFunctions()
            self.vendor = self.gl.glGetString(0x1F00) or ""  # GL_VENDOR
            self.renderer = self.gl.glGetString(0x1F01) or ""  # GL_RENDERER
            self.version = self.gl.glGetString(0x1F02) or ""  # GL_VERSION
            maximum = self.gl.glGetIntegerv(0x0D33)  # GL_MAX_TEXTURE_SIZE
            self.max_texture_size = int(
                maximum[0] if isinstance(maximum, (list, tuple)) else maximum
            )
            if self.max_texture_size < 1:
                raise RuntimeError("The graphics driver reported no texture support.")
            self.blitter = QOpenGLTextureBlitter()
            if not self.blitter.create():
                raise RuntimeError("The layout texture shaders could not be created.")
            self._context.aboutToBeDestroyed.connect(self.cleanup)
            self._ready, self._failed = True, False
            self.gl_info = {
                "vendor": self.vendor,
                "renderer": self.renderer,
                "version": self.version,
                "max_texture_size": self.max_texture_size,
            }
            self.initialized.emit(dict(self.gl_info))
        except Exception as exc:  # noqa: BLE001 - errors must not escape Qt callbacks
            self._report_failure(exc)

    def _report_failure(self, error):
        if not self._failed:
            self._failed = True
            self.failed.emit(f"OpenGL layout rendering failed: {error}")

    def _upload(self, image):
        width, height = image.width(), image.height()
        limit = min(4096, self.max_texture_size)
        if not 0 < width <= limit or not 0 < height <= limit:
            raise RuntimeError(
                f"The {width} × {height} layout image exceeds the {limit}-pixel texture limit."
            )
        # Upload the existing premultiplied pixels without QOpenGLTexture's
        # QImage overload, which converts back to straight alpha internally.
        pixels = image.convertToFormat(QImage.Format.Format_RGBA8888_Premultiplied)
        texture = QOpenGLTexture(QOpenGLTexture.Target.Target2D)
        try:
            texture.setFormat(QOpenGLTexture.TextureFormat.RGBA8_UNorm)
            texture.setSize(width, height)
            texture.setMipLevels(1)
            texture.setMinMagFilters(
                QOpenGLTexture.Filter.Linear, QOpenGLTexture.Filter.Linear
            )
            texture.setWrapMode(QOpenGLTexture.WrapMode.ClampToEdge)
            texture.allocateStorage(
                QOpenGLTexture.PixelFormat.RGBA, QOpenGLTexture.PixelType.UInt8
            )
            if not texture.isStorageAllocated():
                raise RuntimeError(
                    "The graphics driver could not allocate a layout texture."
                )
            texture.setData(
                QOpenGLTexture.PixelFormat.RGBA,
                QOpenGLTexture.PixelType.UInt8,
                VoidPtr(pixels.constBits()),
            )
            error = self.gl.glGetError()
            if error:
                raise RuntimeError(
                    f"The layout texture upload failed (OpenGL 0x{error:04x})."
                )
        except Exception:
            texture.destroy()
            raise
        self.uploads += 1
        return texture, width * height * 4

    def _sync_textures(self, frames):
        if len(frames) > 2:
            raise RuntimeError("The layout can display at most two cached frames.")
        keep = {}
        # Retain the overview even when the detail covers the entire viewport.
        # Zooming out can then expose it without another upload.
        for frame in [*frames, self.canvas.overview]:
            if frame is None or frame["image"].isNull():
                continue
            key = frame["image"].cacheKey()
            if key in keep or len(keep) < 2:
                keep[key] = frame["image"]
        for key in list(self.textures):
            if key not in keep:
                self.textures.pop(key)[0].destroy()
        for key, image in keep.items():
            if key not in self.textures:
                self.textures[key] = self._upload(image)

    def _paint_frames(self):
        frames = list(self.canvas.display_frames())
        scene = self.canvas.gpu_scene
        if scene is None:
            if self.retained_renderer is not None:
                self.retained_renderer.cleanup()
                self.retained_renderer = None
            self._sync_textures(frames)
        else:
            if self.retained_renderer is None:
                from .gpu_mesh import RetainedGpuScene

                self.retained_renderer = RetainedGpuScene()
                self.retained_renderer.initialize(self._context)
            self.retained_renderer.set_scene(scene)
            for texture, _size in self.textures.values():
                texture.destroy()
            self.textures.clear()
        gl = self.gl
        # QPainter and other Qt GL widgets share the context. Establish all
        # state used by the geometry/image pass, including after text.
        gl.glViewport(
            0,
            0,
            round(self.width() * self.devicePixelRatioF()),
            round(self.height() * self.devicePixelRatioF()),
        )
        gl.glDisable(0x0B71)  # GL_DEPTH_TEST
        gl.glDisable(0x0B90)  # GL_STENCIL_TEST
        gl.glDisable(0x0B44)  # GL_CULL_FACE
        gl.glDisable(0x0C11)  # GL_SCISSOR_TEST
        gl.glEnable(0x809D)  # GL_MULTISAMPLE for tessellated polygon contours
        gl.glColorMask(True, True, True, True)
        gl.glActiveTexture(0x84C0)  # GL_TEXTURE0
        gl.glEnable(0x0BE2)  # GL_BLEND
        gl.glBlendEquation(0x8006)  # GL_FUNC_ADD
        gl.glBlendFunc(1, 0x0303)  # premultiplied: GL_ONE, GL_ONE_MINUS_SRC_ALPHA
        gl.glClearColor(27 / 255, 29 / 255, 33 / 255, 1)
        gl.glClear(0x4000)  # GL_COLOR_BUFFER_BIT
        if scene is not None:
            self.retained_renderer.paint(self.canvas)
            return
        self.blitter.bind()
        try:
            for frame in frames:
                image, rect = frame["image"], frame["rect"]
                if image.isNull():
                    continue
                target = QRectF(
                    self.canvas.to_screen(rect.topLeft()),
                    self.canvas.to_screen(rect.bottomRight()),
                )
                transform = QOpenGLTextureBlitter.targetTransform(target, self.rect())
                self.blitter.blit(
                    self.textures[image.cacheKey()][0].textureId(),
                    transform,
                    QOpenGLTextureBlitter.Origin.OriginTopLeft,
                )
        finally:
            self.blitter.release()

    def paintGL(self):
        if not self._ready or self._failed:
            return
        started = time.perf_counter()
        self.paint_count += 1
        painter = QPainter(self)
        try:
            painter.beginNativePainting()
            try:
                self._paint_frames()
            finally:
                painter.endNativePainting()
            self.canvas.paint_overlays(painter)
        except Exception as exc:  # noqa: BLE001 - canvas falls back to its CPU painter
            self._report_failure(exc)
        finally:
            painter.end()
            self.last_paint_ms = (time.perf_counter() - started) * 1000
            self.paint_ms_total += self.last_paint_ms

    def cleanup(self):
        """Release geometry and images with their owning context current."""
        if self._cleaning:
            return
        self._cleaning = True
        context = self._context
        try:
            if context is not None:
                self.makeCurrent()
            if context is not None and QOpenGLContext.currentContext() == context:
                if self.retained_renderer is not None:
                    self.retained_renderer.cleanup()
                for texture, _size in self.textures.values():
                    texture.destroy()
                if self.blitter is not None:
                    self.blitter.destroy()
            self.textures.clear()
            self.retained_renderer = None
            self.blitter = None
            self._ready = False
        finally:
            if context is not None:
                self.doneCurrent()
                try:
                    context.aboutToBeDestroyed.disconnect(self.cleanup)
                except (RuntimeError, TypeError):
                    pass
            self.gl = self._context = None
            self._cleaning = False
