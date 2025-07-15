from __future__ import annotations
import numpy as np
from vispy import app
from vispy import scene
from vispy.scene import ViewBox
from vispy.scene.visuals import Volume, Image
from PyQt6 import QtWidgets
from PyQt6.QtCore import Qt

from lucida.core.canvas import LucidaCanvas
from lucida.core.signal_bus import SignalBus
from lucida.core.layer import Layer, LayerUpdateEvent
from lucida.core.logging import init_logging
from lucida.core.utils import get_current_ipython
from lucida.gui.widgets import DimSlider
    
    
class Viewer(QtWidgets.QMainWindow):
    def __init__(self) -> None:
        self.bus = SignalBus()
        self.canvas = LucidaCanvas(self.bus)
        
        super().__init__()
        self.setWindowTitle("Lucida")
        
        # Central canvas
        self.setCentralWidget(self.canvas.native)
        
        # Bottom control area
        self._controls_bar = QtWidgets.QWidget()
        self._controls_layout = QtWidgets.QHBoxLayout(self._controls_bar)
        self._controls_layout.setContentsMargins(4, 4, 4, 4)
        self._controllers = {}
        
        dock = QtWidgets.QDockWidget("Controls", self)
        dock.setWidget(self._controls_bar)
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, dock)
        self._ipython = get_current_ipython()
        self._log_level = "INFO"
        
        self._view: ViewBox = self.canvas.central_widget.add_view()
        self._view.camera = scene.cameras.TurntableCamera(fov=60)
        self.bus.subscribe(LayerUpdateEvent, self._on_layer_update)
        
    def add_control(self, widget_cls, *args, **kwargs) -> QtWidgets.QWidget:
        widget = widget_cls(self.bus, *args, **kwargs)
        self._controls_layout.addWidget(widget)
        return widget

    ## ----- Public API
    def run(self, size=(1080, 720)) -> None:
        self.resize(*size)
        self.show()
        app.run()

    def add_image(self, data: np.ndarray, 
                  order: str,
                  cmap: str = "grays",
                  interp: str = "nearest",) -> Layer:
        
        # Create the layer and register it
        layer = Layer(data=data, order=order, bus=self.bus, 
                      colormap=cmap, interpolation=interp)
    
        for dim in order:
            if dim not in "ZYX":
                if dim not in self._controllers:
                    dim_slider = self.add_control(DimSlider, dim=dim, size=layer.data.shape[order.index(dim)])
                    self._controllers[dim] = dim_slider
                else:
                    current_size = self._controllers[dim].maximum() + 1
                    new_size = layer.data.shape[order.index(dim)]
                    if new_size > current_size:
                        # remove old slider and add a new one
                        self._controls_layout.removeWidget(self._controllers[dim])
                        dim_slider = self.add_control(DimSlider, dim=dim, size=layer.data.shape[order.index(dim)])
                        self._controllers[dim] = dim_slider
                
        
        # Show the layer
        arr = layer.as_render_array()
        visual_cls = Volume if arr.ndim == 3 else Image
        visual = visual_cls(arr, cmap=layer.colormap,
                            interpolation=layer.interpolation)
        layer.visual = visual
        self._view.add(visual)  # type: ignore
        return layer
        
    def set_logging(self, stdout: bool = True, level: str = "INFO") -> None:
        init_logging(std_out=stdout, level=level)
        self._log_level = level
        
    ## ----- Internals
    def _update_canvas(self) -> None:
        """Update the canvas to reflect changes."""
        self.canvas.update()

    def _on_layer_update(self, ev: LayerUpdateEvent) -> None:
        if ev.layer.visual is None:
            print(f"Warning: Layer {ev.layer.name!r} has no visual to update.")
            return
        ev.layer.visual.cmap = ev.layer.colormap
        ev.layer.visual.set_data(ev.layer.as_render_array())
