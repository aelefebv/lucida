from __future__ import annotations
from lucida.core.events import DimIndexChanged
from lucida.core.layer import Layer
from lucida.core.signal_bus import SignalBus


class DimController:
    """Listens for DimIndexChanged and updates registered layers."""

    def __init__(self, bus: SignalBus) -> None:
        self._bus = bus
        self._layers: list[Layer] = []
        bus.subscribe(DimIndexChanged, self._on_dim_changed)

    # ----- Public API
    def register(self, layer: Layer) -> None:
        if layer not in self._layers:
            self._layers.append(layer)

    # ----- Internals
    def _on_dim_changed(self, ev: DimIndexChanged) -> None:
        # update every layer that *has* this dimension
        for layer in self._layers:
            if ev.dim in layer.order:
                layer.set_index(ev.dim, ev.value)
                