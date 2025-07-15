from __future__ import annotations
import numpy as np
from vispy import app
from vispy import scene
from vispy.scene import ViewBox
from vispy.scene.visuals import Volume, Image

from lucida.core.canvas import LucidaCanvas
from lucida.core.signal_bus import SignalBus
from lucida.core.layer import Layer, LayerUpdateEvent
from lucida.core.logging import init_logging
from lucida.core.utils import get_current_ipython
from lucida.gui.control_panel import ControlPanel
from lucida.gui.controller import DimController
    
    
class Viewer:
    def __init__(self) -> None:
        app.use_app('pyqt6')
        self._bus = SignalBus()
        self.canvas = LucidaCanvas(self._bus)
        
        self._ipython = get_current_ipython()
        self._view: ViewBox = self.canvas.central_widget.add_view()
        self._view.camera = scene.cameras.TurntableCamera(fov=60)
        self._log_level = "INFO"
        
        self._controller = DimController(self._bus)
        self._control_panel: ControlPanel | None = None

        self._bus.subscribe(LayerUpdateEvent, self._on_layer_update)
        
    ## ----- Public API
    def run(self) -> None:
        self.canvas.show()
        app.run()
        
    def add_image(self, data: np.ndarray, 
                  order: str,
                  cmap: str = "grays",
                  interp: str = "nearest",) -> Layer:
        
        # Create the layer and register it
        layer = Layer(data=data, order=order, bus=self._bus, 
                      colormap=cmap, interpolation=interp)
        self._controller.register(layer)
        
        # Create control panel if needed
        if self._control_panel is None:
            self._control_panel = ControlPanel(self._bus, layer)
            self._control_panel.show()
        
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
