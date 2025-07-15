from __future__ import annotations
from PyQt6 import QtWidgets
from lucida.core.layer import Layer
from lucida.core.signal_bus import SignalBus
from .widgets import IndexSlider


class ControlPanel(QtWidgets.QWidget):
    """A vertical stack of sliders, one per varying dimension."""

    def __init__(self, bus: SignalBus, layer: Layer) -> None:
        super().__init__()
        self.setWindowTitle("Lucida Controls")
        layout = QtWidgets.QVBoxLayout(self)

        for dim, size in layer.shape_by_dim.items():   # {'T':23,'C':10,'Y':1000,'X':1000}
            if size == 1:
                continue  # no slider for singleton dim
            if dim in "ZYX":
                continue
            lbl = QtWidgets.QLabel(f"{dim} 0–{size-1}")
            layout.addWidget(lbl)
            slider = IndexSlider(dim, size, bus)
            layout.addWidget(slider)
            
        print(f"ControlPanel: created for layer {layer.name!r} with dims {layer.shape_by_dim}")

        layout.addStretch()