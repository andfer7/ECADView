"""Render Altium documents and build selection metadata for the viewer."""

from dataclasses import replace
from io import BytesIO
from pathlib import Path
import re
import zlib

import freetype
from altium_monkey import AltiumDesign, AltiumPcbDoc, AltiumSchDoc, PcbSvgRenderOptions, SchSvgRenderOptions
from altium_monkey.altium_pcb_surface import PCB_SurfaceSide
from altium_monkey.altium_ttf_metrics import get_font_path_with_style

from .scene3d import build_scene


def prepare_embedded_fonts(pcb: AltiumPcbDoc) -> list[str]:
    """Replace fonts FreeType cannot read in the parsed copy of the board."""
    fonts, warnings = [], []
    for font in pcb.embedded_fonts:
        try:
            freetype.Face(BytesIO(font.decompress()))
        except freetype.FT_Exception:
            style = f"{font.name} {font.style}".lower()
            font_path = get_font_path_with_style(
                font.name, bold="bold" in style,
                italic="italic" in style or "oblique" in style,
            )
            if not font_path:
                raise RuntimeError(f'Embedded font "{font.name}" is unreadable and no replacement font is available.')
            try:
                replacement = Path(font_path).read_bytes()
                freetype.Face(BytesIO(replacement))
            except (OSError, freetype.FT_Exception) as exc:
                raise RuntimeError(f'Could not load a replacement for unreadable embedded font "{font.name}".') from exc
            fonts.append(replace(font, compressed_data=zlib.compress(replacement), raw_data=b""))
            warnings.append(
                f'Embedded font "{font.name}" could not be read; using "{Path(font_path).stem}". '
                'Text shape and spacing may differ.'
            )
        else:
            fonts.append(font)
    pcb.embedded_fonts = fonts
    return warnings


def resolve_polygon_nets(pcb: AltiumPcbDoc) -> None:
    """Give poured copper its parent polygon's net in the parsed rendering copy."""
    def valid_index(index: int | None, size: int) -> bool:
        return isinstance(index, int) and 0 <= index < size and index not in (0xFFFF, 0xFFFFFFFF)

    for collection in ("regions", "shapebased_regions", "tracks", "arcs", "fills"):
        for primitive in getattr(pcb, collection, []):
            if valid_index(primitive.net_index, len(pcb.nets)):
                continue
            polygon_index = getattr(primitive, "polygon_index", None)
            if not valid_index(polygon_index, len(pcb.polygons)):
                continue
            net_index = pcb.polygons[polygon_index].net
            if valid_index(net_index, len(pcb.nets)):
                primitive.net_index = net_index


def schematic_selection(schematic: AltiumSchDoc) -> dict:
    """Link selectable source components and compiled nets to their SVG groups."""
    components = [
        {"id": component.record.unique_id, "name": component.designator or component.record.unique_id,
         "elements": [component.record.unique_id],
         "body_elements": [graphic.unique_id for graphic in component.record.graphics]}
        for component in schematic.get_components()
    ]
    nets = []
    # Logical nets retain wire-only and single-pin networks that manufacturing
    # netlist output may omit. Each tab contains one source sheet.
    for net in AltiumDesign(schdocs=[schematic]).compile().nets:
        if net.scope != "logical_local":
            continue
        elements = {item.element_id for item in net.items if not item.removed}
        nets.append({"id": f"net-{len(nets)}", "name": net.name, "elements": sorted(elements - {""}),
                     "aliases": list(net.aliases),
                     "terminals": [{"component": terminal.designator, "pin": terminal.pin} for terminal in net.terminals]})
    return {"components": components, "nets": nets}


def polygon_element_ids(pcb: AltiumPcbDoc, svg: str) -> list[str]:
    """Identify polygon pours without confusing unlinked regions with custom pads.

    The renderer's deterministic IDs encode primitive kind and collection index;
    one source primitive can appear on several layers in a surface rendering.
    Read IDs without reserializing SVG (including its embedded fonts and styles).
    """
    linked = set()
    for collection, kind in (("regions", "region"), ("shapebased_regions", "shapebased-region"),
                             ("tracks", "track"), ("arcs", "arc"), ("fills", "fill")):
        for index, primitive in enumerate(getattr(pcb, collection, [])):
            polygon_index = getattr(primitive, "polygon_index", None)
            if (isinstance(polygon_index, int) and 0 <= polygon_index < len(pcb.polygons)
                    and polygon_index not in (0xFFFF, 0xFFFFFFFF)):
                linked.add((kind, index))
    pattern = r'\bid="(pcb-(shapebased-region|region|track|arc|fill)-(\d+)(?:-[^"]*)?)"'
    return [element_id for element_id, kind, index in re.findall(pattern, svg) if (kind, int(index)) in linked]


def render_file(path: Path, side: str = "all", clip: bool = False,
                pour_color: str | None = None, polygon_outlines: bool = False) -> dict:
    if path.suffix.lower() == ".schdoc":
        schematic = AltiumSchDoc(path)
        return {
            "svg": schematic.to_svg(options=SchSvgRenderOptions(embed_bundled_fallback_fonts=True)),
            "name": path.name,
            "kind": "schematic",
            "selection": schematic_selection(schematic),
            "warnings": [],
            "stats": {
                "components": len(schematic.components),
                "wires": len(schematic.wires),
                "net_labels": len(schematic.net_labels),
            },
        }
    if path.suffix.lower() != ".pcbdoc":
        raise ValueError("Open an Altium .PcbDoc or .SchDoc file.")
    pcb = AltiumPcbDoc.from_file(path)
    warnings = prepare_embedded_fonts(pcb)
    resolve_polygon_nets(pcb)
    options = PcbSvgRenderOptions(
        show_board_outline=True,
        clip_copper_to_board_outline=clip,
        polygon_overlay_color=pour_color or None,
        include_polygon_definition_overlays=polygon_outlines,
        svg_display_scale=4.0,
    )
    if side == "top":
        svg = pcb.to_surface_svg(PCB_SurfaceSide.TOP, options=options)
    elif side == "bottom":
        svg = pcb.to_surface_svg(PCB_SurfaceSide.BOTTOM, options=options)
    else:
        svg = pcb.to_svg(options=options)
    # An unsupported 3D record must not prevent opening the existing 2D view.
    try:
        scene = build_scene(pcb)
    except Exception as exc:
        scene = {"board": [], "notes": [f"3D is unavailable for this document: {type(exc).__name__}: {exc}"]}
    return {
        "svg": svg,
        "scene3d": scene,
        "name": path.name,
        "kind": "pcb",
        "polygon_elements": polygon_element_ids(pcb, svg),
        "layout_components": [
            {"name": component.designator, "source_name": component.source_designator,
             "source_id": component.source_unique_id_segments[-1] if component.source_unique_id_segments else ""}
            for component in pcb.components
        ],
        "warnings": warnings,
        "stats": {
            "components": len(pcb.components),
            "pads": len(pcb.pads),
            "tracks": len(pcb.tracks),
            "vias": len(pcb.vias),
            "polygons": len(pcb.polygons),
            "regions": len(pcb.regions),
        },
    }
