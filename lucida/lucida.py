from __future__ import annotations

import numpy as np
from lucida.backend.layer_manager import Layer
from lucida.backend.view_manager import ViewManager
from lucida.core.events import ViewerInitialized
from lucida.core.logging import init_logging
from lucida.core.signal_bus import SignalBus
from lucida.core.utils import get_current_ipython
from lucida.frontend.main_window import MainApplication, MainWindow
from vispy import app
    
def run():
    app.run()
    
class Viewer:
    """Main entry point for the Lucida viewer application."""
    def __init__(self, *, log_level: str = "INFO", stdout_log: bool = True):
        self._bus = SignalBus()
        self.app =  MainApplication(self._bus)
        self.wnd =  MainWindow(self._bus)
        self.vwm =  ViewManager(self._bus)        
        
        self.wnd.set_central_widget(self.vwm.qt_widget)  
        self.ipython = get_current_ipython() 
        init_logging(std_out=stdout_log, level=log_level)
        self._bus.emit(ViewerInitialized())
        self.wnd.show()
        
    def add_image(self, data: np.ndarray, order: str, *,
                  layer_name: str = "layer",
                  colormap: str = "grays",
                  interpolation: str = "nearest",
                  view_name: str | None = None):
        """Add an image layer to the viewer."""
        view = self.vwm.get_view(view_name) or self.vwm.add_view(name=view_name)
        
        layer = Layer(bus=self._bus, data=data, order=order,
                      name=layer_name, colormap=colormap, interpolation=interpolation)
        view.add_layer(layer)
        # Clear existing dim sliders and add new ones from the view
        self.wnd.clear_dim_sliders()
        for slider in view.dim_sliders.values():
            self.wnd.add_dim_slider(slider)
        # Center the camera on the new layer
        WHY DOES IT UPDATE THE CAMERA AFTER THIS???
        view._center_camera(layer.render_shape, layer.order)
