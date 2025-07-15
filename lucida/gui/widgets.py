from dataclasses import dataclass
from PyQt6 import QtWidgets, QtCore
from lucida.core.events import DimIndexChanged, Event
from lucida.core.signal_bus import SignalBus


# a widget that *only* emits that event ----------------
class DimSlider(QtWidgets.QSlider):
    def __init__(self, bus: SignalBus, dim: str, size: int) -> None:
        super().__init__(QtCore.Qt.Orientation.Horizontal)
        self._bus = bus
        self._dim = dim
        self.setRange(0, size - 1)
        self.valueChanged.connect(self._on_change)

    def _on_change(self, val: int):
        self._bus.emit(DimIndexChanged(self._dim, val))
        