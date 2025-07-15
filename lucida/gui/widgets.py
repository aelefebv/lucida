from PyQt6 import QtWidgets, QtCore
from lucida.core.events import DimIndexChanged
from lucida.core.signal_bus import SignalBus


class IndexSlider(QtWidgets.QSlider):
    """Horizontal slider that publishes a DimIndexChanged event."""
    def __init__(self, dim: str, max_val: int, bus: SignalBus) -> None:
        super().__init__(QtCore.Qt.Orientation.Horizontal)
        self.dim = dim
        self.setRange(0, max_val - 1)
        self._bus = bus
        self.valueChanged.connect(self._on_change)  # Qt → our callback

    # ----- Internals
    def _on_change(self, value: int) -> None:
        self._bus.emit(DimIndexChanged(self.dim, value))