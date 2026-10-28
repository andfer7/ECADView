"""Keep Altium's SVG output while avoiding repeated per-layer discovery work.

These small renderer hooks use the library's own layer resolution and emitters.
Pads and vias still go through its full multi-layer rendering path.
"""

from collections import defaultdict

from altium_monkey.altium_pcb_layer_ref import PcbLayerRef, PcbLayerResolutionError
from altium_monkey.altium_pcb_svg_renderer import PcbSvgRenderer


class IndexedPcbSvgRenderer(PcbSvgRenderer):
    def __init__(self, pcb, options):
        super().__init__(options)
        self._signatures = {}
        self._collections = {}
        for name in ("tracks", "arcs", "fills", "regions", "shapebased_regions"):
            collection = getattr(pcb, name)
            layers = defaultdict(list)
            for primitive in collection:
                ref = self._primitive_layer_ref(primitive)
                if ref is None:
                    # Preserve upstream handling of unresolved legacy layers.
                    break
                layers[ref].append(primitive)
            else:
                self._collections[id(collection)] = (collection, layers)

    def _to_svg_accepts_for_layer(self, to_svg):
        # Cache the function, not its bound method (which retains a primitive).
        function = getattr(to_svg, "__func__", to_svg)
        if function not in self._signatures:
            self._signatures[function] = super()._to_svg_accepts_for_layer(to_svg)
        return self._signatures[function]

    def _on_layer(self, collection, layer):
        indexed = self._collections.get(id(collection))
        if indexed is None or indexed[0] is not collection:
            return collection
        try:
            ref = layer.ref if hasattr(layer, "ref") else PcbLayerRef.from_legacy(layer)
        except PcbLayerResolutionError:
            return collection
        return indexed[1].get(ref, ())

    def _render_primitive_collection(self, ctx, collection, layer, color, **kwargs):
        return super()._render_primitive_collection(
            ctx, self._on_layer(collection, layer), layer, color, **kwargs
        )

    def _render_region_collection(self, ctx, collection, layer, color):
        return super()._render_region_collection(
            ctx, self._on_layer(collection, layer), layer, color
        )

    def _render_v7_ref_primitive_collection(self, ctx, collection, layer, color):
        return super()._render_v7_ref_primitive_collection(
            ctx, self._on_layer(collection, layer), layer, color
        )
