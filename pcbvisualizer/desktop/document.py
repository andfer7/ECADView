"""Worker-owned SVG painting and spatial indexes for native document views."""

import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass

from PySide6.QtCore import QByteArray, QObject, QRectF, Qt, Signal, Slot
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer
from shapely.geometry import box
from shapely.strtree import STRtree

from pcbvisualizer.rendering import render_file

from .text import properties

SVG = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG)
GRAPHICS = {
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "use",
}
SELECTION_CONTEXT = 0.15
SCHEMATIC_SELECTION_CONTEXT = 0.45
SCHEMATIC_SELECTION_COLOR = "#008a3b"


def faded_paint(value, background, contrast=SELECTION_CONTEXT):
    """Keep geometry opaque while reducing its contrast against the canvas.

    Fading colors instead of object opacity preserves drill cutouts, overlapping
    copper and the hit-test alpha of thin, unselected wires.
    """
    color = QColor(value)
    if not color.isValid() or color.alpha() == 0:
        return value
    channels = [
        round(bg + (fg - bg) * contrast)
        for fg, bg in zip(color.getRgb()[:3], background.getRgb()[:3], strict=True)
    ]
    if color.alpha() < 255:
        return f"rgba({channels[0]},{channels[1]},{channels[2]},{color.alphaF()})"
    return QColor(*channels).name()


def set_paint(node, overrides):
    # Qt ignores inline styles beginning with an empty declaration. Replace
    # existing declarations as well as attributes so both use the same paint.
    inline = {
        key.strip(): value.strip()
        for declaration in node.get("style", "").split(";")
        if ":" in declaration
        for key, value in [declaration.split(":", 1)]
    }
    inline.update(overrides)
    node.set("style", ";".join(f"{key}:{value}" for key, value in inline.items()))
    for name, value in overrides.items():
        node.set(name, value)


def tag(node):
    return node.tag.rsplit("}", 1)[-1]


def default_layer(node):
    token = node.get("data-layer-token", "").upper()
    role = node.get("data-layer-role", "")
    name = node.get("data-layer-name", "").lower()
    return (
        node.get("id") == "board-outline"
        or role in ("copper", "drill")
        or node.get("data-layer-family") in ("signal", "internal_plane")
        or token in ("TOP", "BOTTOM", "TOPOVERLAY", "DRILLS", "MULTILAYER")
        or token.startswith(("MID", "PLANE"))
        or node.get("id", "").lower()
        in ("layer-top", "layer-bottom", "layer-topoverlay", "layer-drills")
        or name in ("top copper", "bottom copper", "top overlay")
    )


@dataclass
class Primitive:
    id: str
    bounds: QRectF
    layer: str
    polygon: bool
    component: str = ""
    net: str = ""
    pin: str = ""
    schematic_components: tuple = ()
    schematic_nets: tuple = ()
    hole: bool = False
    fill: bool = True
    stroke: bool = False


class NativeDocument:
    """Only constructed/accessed by its document's worker thread.

    The GUI receives plain metadata, bounds and implicitly shared QImages. SVG
    objects and the spatial index never run on the GUI thread.
    """

    def __init__(self, data):
        self.data, self.root = data, ET.fromstring(data["svg"])
        from .text import outline_text

        outline_text(self.root)
        self.scene = next(
            (el for el in self.root.iter() if el.get("id") == "scene"), self.root
        )
        self.elements = {}
        for index, el in enumerate(self.root.iter()):
            if tag(el) in GRAPHICS and not el.get("id"):
                el.set("id", f"native-{index}")
            if el.get("id"):
                self.elements[el.get("id")] = el
        self.source = ET.tostring(self.root)
        self.renderer = QSvgRenderer(QByteArray(self.source))
        self.renderer.setAnimationEnabled(False)
        if not self.renderer.isValid():
            raise ValueError("Qt could not read the rendered document.")
        self.home = self.renderer.viewBoxF()
        self.layers = []
        if data.get("kind", "pcb") == "pcb":
            for node in self.scene:
                if tag(node) == "g":
                    self.layers.append(
                        {
                            "id": node.get("id"),
                            "name": node.get("data-layer-display-name")
                            or node.get("data-layer-name")
                            or node.get("id"),
                            "visible": default_layer(node),
                        }
                    )
        self.layer_ids = {layer["id"] for layer in self.layers}
        self.parents = {
            child: parent for parent in self.root.iter() for child in parent
        }
        self.polygon_ids = set(data.get("polygon_elements", []))
        components, nets = defaultdict(list), defaultdict(list)
        self.component_rows, self.net_rows = {}, {}
        for key, output, lookup in (
            ("components", self.component_rows, components),
            ("nets", self.net_rows, nets),
        ):
            for row in data.get("selection", {}).get(key, []):
                output[row["id"]] = row
                for identifier in row["elements"]:
                    lookup[identifier].append(row["id"])
        self.primitives, self.component_bounds, self.net_bounds = (
            [],
            defaultdict(list),
            defaultdict(list),
        )
        self.body_bounds = []
        self.paints = {}
        for node in self.root.iter():
            if tag(node) not in GRAPHICS:
                continue
            ancestors, parent = [], node
            while parent is not None:
                ancestors.append(parent)
                parent = self.parents.get(parent)
            if any(
                tag(p) in ("defs", "clipPath", "mask", "pattern") for p in ancestors
            ):
                continue

            def attr(name, chain=ancestors):
                return next((p.get(name) for p in chain if p.get(name)), "")

            layer = next(
                (p.get("id") for p in ancestors if p.get("id") in self.layer_ids), ""
            )
            cs = tuple(
                dict.fromkeys(c for p in ancestors for c in components[p.get("id")])
            )
            ns = tuple(dict.fromkeys(n for p in ancestors for n in nets[p.get("id")]))
            component, net = attr("data-component"), attr("data-net")
            hole = bool(attr("data-hole-owner")) or attr("data-primitive").endswith(
                "-hole"
            )
            identifier = node.get("id")
            # Resolve inherited paint before selection so open paths stay open
            # and filled pads/text do not acquire an extra outline.
            paint = {"fill": "black", "stroke": "none"}
            for ancestor in reversed(ancestors):
                declarations = properties(ancestor, {})
                for name in paint:
                    value = declarations.get(name, "inherit")
                    if value != "inherit":
                        paint[name] = value
            self.paints[identifier] = paint
            if not (component or net or cs or ns or hole):
                continue
            bounds = self.bounds(identifier)
            if bounds.isEmpty():
                bounds = bounds.adjusted(-0.01, -0.01, 0.01, 0.01)
            primitive = Primitive(
                identifier,
                bounds,
                layer,
                any(
                    p.get("id") in self.polygon_ids
                    or p.get("data-primitive") in ("polygon-outline", "polygon-cutout")
                    for p in ancestors
                ),
                component,
                net,
                attr("data-pad-number") or attr("data-pad-designator"),
                cs,
                ns,
                hole,
                paint["fill"] != "none",
                paint["stroke"] != "none",
            )
            self.primitives.append(primitive)
            for c in cs or ([component] if component else []):
                self.component_bounds[c].append(bounds)
            for n in ns or ([net] if net else []):
                self.net_bounds[n].append(bounds)
        for cid, row in self.component_rows.items():
            for identifier in row.get("body_elements", []):
                if identifier in self.elements:
                    self.body_bounds.append((cid, self.bounds(identifier)))
        self.tree = STRtree(
            [
                box(
                    p.bounds.left(), p.bounds.top(), p.bounds.right(), p.bounds.bottom()
                )
                for p in self.primitives
            ]
        )
        self.component_layers, self.net_layers, self.terminals = (
            defaultdict(set),
            defaultdict(set),
            defaultdict(set),
        )
        for p in self.primitives:
            if p.component and p.pin and p.net:
                self.terminals[(p.component, p.pin)].add(p.net)
            for name in p.schematic_components or (
                [p.component] if p.component else []
            ):
                self.component_layers[name].add(p.layer)
            for name in p.schematic_nets or ([p.net] if p.net else []):
                self.net_layers[name].add(p.layer)
        self.style = None
        self.render_count = 0

    def bounds(self, identifier):
        return self.renderer.transformForElement(identifier).mapRect(
            self.renderer.boundsOnElement(identifier)
        )

    def info(self):
        def union(rects):
            result = QRectF()
            for rect in rects:
                result = result.united(rect)
            return result

        return {
            "name": self.data["name"],
            "kind": self.data.get("kind", "pcb"),
            "stats": self.data.get("stats", {}),
            "warnings": self.data.get("warnings", []),
            "layers": self.layers,
            "home": self.home,
            "components": self.component_rows
            or {name: {"name": name, "id": name} for name in self.component_bounds},
            "nets": self.net_rows
            or {name: {"name": name, "id": name} for name in self.net_bounds},
            "component_bounds": {
                key: union(rows) for key, rows in self.component_bounds.items()
            },
            "net_bounds": {key: union(rows) for key, rows in self.net_bounds.items()},
            "layout_components": self.data.get("layout_components", []),
            "terminals": dict(self.terminals),
            "captions": [
                (p.bounds, p.pin, p.net, p.layer, p.polygon, p.component)
                for p in self.primitives
                if p.pin and not p.hole
            ],
            "component_layers": dict(self.component_layers),
            "net_layers": dict(self.net_layers),
            "scene3d": self.data.get("scene3d", {}),
        }

    def apply_style(self, visible, polygons, selected_components, selected_nets):
        style = (
            frozenset(visible),
            polygons,
            frozenset(selected_components),
            frozenset(selected_nets),
        )
        if style == self.style:
            return
        self.style = style
        root = deepcopy(self.root)
        elements = {el.get("id"): el for el in root.iter() if el.get("id")}
        hidden = set(self.layer_ids) - set(visible)
        for identifier in hidden:
            elements[identifier].set("display", "none")
        if not polygons:
            for identifier in self.polygon_ids:
                if identifier in elements:
                    elements[identifier].set("display", "none")
        selected = {}
        schematic_components = set()
        schematic = self.data.get("kind") == "schematic"
        component_color = SCHEMATIC_SELECTION_COLOR if schematic else "#ffe066"
        net_color = SCHEMATIC_SELECTION_COLOR if schematic else "#39e0f3"
        context_contrast = (
            SCHEMATIC_SELECTION_CONTEXT if schematic else SELECTION_CONTEXT
        )
        holes = {p.id for p in self.primitives if p.hole}
        for p in self.primitives:
            if p.hole:
                continue
            component_selected = p.component in selected_components or set(
                p.schematic_components
            ).intersection(selected_components)
            if (
                component_selected
                or p.net in selected_nets
                or set(p.schematic_nets).intersection(selected_nets)
            ):
                selected[p.id] = component_color if component_selected else net_color
                if component_selected and schematic:
                    schematic_components.add(p.id)
        if selected_components or selected_nets:
            background = QColor(
                "#fffcf8" if self.data.get("kind") == "schematic" else "#1b1d21"
            )
            for identifier, paint in self.paints.items():
                if identifier in holes:
                    continue
                node = elements[identifier]
                contour_only = (
                    identifier in schematic_components
                    and node.get("data-native-text") != "true"
                )
                overrides = {}
                for name, value in paint.items():
                    if contour_only and name == "fill":
                        # A schematic symbol's interior is not a selection wash.
                        # Glyphs remain filled so references/values stay legible.
                        overrides[name] = value
                    elif value == "none" or QColor(value).alpha() == 0:
                        overrides[name] = value
                    elif identifier in selected:
                        overrides[name] = selected[identifier]
                    else:
                        overrides[name] = faded_paint(
                            value, background, context_contrast
                        )
                if (
                    contour_only
                    and paint["stroke"] == "none"
                    and paint["fill"] != "none"
                    and QColor(paint["fill"]).alpha() != 0
                ):
                    # Filled-only symbol shapes still need a visible contour;
                    # use their inherited SVG stroke width (default one unit).
                    overrides["stroke"] = selected[identifier]
                set_paint(node, overrides)

            # Draw the selection above faded layers so an unselected crossing
            # cannot hide a route. Keep ancestor transforms/clips and drill paint.
            def selection_branch(node):
                if tag(node) in GRAPHICS:
                    return (
                        deepcopy(node)
                        if node.get("id") in selected or node.get("id") in holes
                        else None
                    )
                branch = ET.Element(node.tag, node.attrib)
                for child in node:
                    copy = selection_branch(child)
                    if copy is not None:
                        branch.append(copy)
                return branch if len(branch) else None

            if selected:
                overlay = selection_branch(root)
                # The outer SVG already supplies its viewport and inherited
                # properties; the overlay is only another paint group within it.
                overlay.tag = f"{{{SVG}}}g"
                overlay.attrib.clear()
                for node in overlay.iter():
                    node.attrib.pop("id", None)
                root.append(overlay)
        self.renderer.load(QByteArray(ET.tostring(root)))
        self.renderer.setAnimationEnabled(False)
        self.renderer.setAspectRatioMode(Qt.AspectRatioMode.IgnoreAspectRatio)

    def raster(self, request):
        self.apply_style(*request["style"])
        rect, width, height = request["rect"], request["width"], request["height"]
        image = QImage(width, height, QImage.Format.Format_ARGB32_Premultiplied)
        image.fill(QColor("#1b1d21"))
        painter = QPainter(image)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.renderer.setViewBox(rect)
        self.renderer.render(painter, QRectF(0, 0, width, height))
        painter.end()
        self.render_count += 1
        return {
            "image": image,
            "rect": rect,
            "token": request["token"],
            "renders": self.render_count,
        }

    def pick(self, position, tolerance, visible, polygons):
        indices = self.tree.query(
            box(
                position.x() - tolerance,
                position.y() - tolerance,
                position.x() + tolerance,
                position.y() + tolerance,
            )
        )
        # Test paint, not just bounding boxes: holes, empty symbol outlines and
        # curved routes must remain click-through.
        for index in sorted(indices, reverse=True):
            p = self.primitives[index]
            if p.layer and p.layer not in visible or p.polygon and not polygons:
                continue
            image = QImage(9, 9, QImage.Format.Format_ARGB32_Premultiplied)
            image.fill(0)
            painter = QPainter(image)
            painter.translate(4.5, 4.5)
            painter.scale(4 / tolerance, 4 / tolerance)
            painter.translate(-position.x(), -position.y())
            painter.setTransform(self.renderer.transformForElement(p.id), True)
            self.renderer.render(painter, p.id, self.renderer.boundsOnElement(p.id))
            painter.end()
            if any(
                image.pixelColor(x, y).alpha() > 32 for x in range(9) for y in range(9)
            ):
                return (
                    None
                    if p.hole
                    else {
                        "components": list(p.schematic_components)
                        or ([p.component] if p.component else []),
                        "nets": list(p.schematic_nets) or ([p.net] if p.net else []),
                    }
                )
        for cid, bounds in reversed(self.body_bounds):
            if bounds.contains(position):
                return {"components": [cid], "nets": []}
        return None


class DocumentWorker(QObject):
    loaded = Signal(object)
    frame = Signal(object)
    picked = Signal(object)
    mesh = Signal(object)
    failed = Signal(str)

    def __init__(self, path):
        super().__init__()
        self.path, self.document = path, None

    @Slot()
    def load(self):
        try:
            started = time.perf_counter()
            self.document = NativeDocument(render_file(self.path))
            info = self.document.info()
            info["load_seconds"] = time.perf_counter() - started
            self.loaded.emit(info)
        except Exception as exc:  # noqa: BLE001 - worker boundary reports third-party parser errors to the window
            self.failed.emit(f"{type(exc).__name__}: {exc}")

    @Slot(object)
    def render(self, request):
        try:
            if self.document:
                self.frame.emit(self.document.raster(request))
        except Exception as exc:  # noqa: BLE001 - keep Qt callbacks from swallowing renderer errors
            self.failed.emit(f"Rendering failed: {exc}")

    @Slot(object)
    def pick(self, request):
        if self.document:
            self.picked.emit(
                {
                    "result": self.document.pick(*request["args"]),
                    "shift": request["shift"],
                }
            )

    @Slot()
    def build_mesh(self):
        try:
            from .solid import build_mesh

            self.mesh.emit(build_mesh(self.document.data.get("scene3d", {})))
        except Exception as exc:  # noqa: BLE001 - preserve 2D when third-party geometry cannot be meshed
            self.failed.emit(f"3D is unavailable: {exc}")

    @Slot()
    def shutdown(self):
        self.document = None
        self.thread().quit()
