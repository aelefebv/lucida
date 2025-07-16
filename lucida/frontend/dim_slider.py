from lucida.core.events import DimIndexChanged
from lucida.core.signal_bus import SignalBus
from PySide6 import QtWidgets, QtCore

class DimSlider(QtWidgets.QSlider):
    def __init__(self, bus: SignalBus, dim: str, size: int) -> None:
        super().__init__(QtCore.Qt.Orientation.Horizontal)
        self._bus = bus
        self._dim = dim
        
        self.min_val = 0
        self.max_val = size - 1
        self.setRange(self.min_val, self.max_val)
        
        self.valueChanged.connect(self._on_change)

    def _on_change(self, val: int):
        """Emit a DimIndexChanged event when the slider value changes."""
        self._bus.emit(DimIndexChanged(self._dim, val))
        
    def set_range(self, min_val: int, max_val: int):
        """Set the range of the slider."""
        changed = False
        if min_val < self.min_val:
            changed = True  
            self.min_val = min_val
        if max_val > self.max_val:
            changed = True
            self.max_val = max_val
        if changed:
            self.setRange(min_val, max_val)
        