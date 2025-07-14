from __future__ import annotations
import numpy as np
from vispy.scene.canvas import SceneCanvas
from vispy import app
from vispy.scene import ViewBox
from vispy import scene
from vispy.scene.visuals import Volume, Image

from lucida.core.events import SignalBus
from lucida.core.layer import Layer, LayerUpdateEvent
from lucida.core.utils import get_current_ipython
    
class Viewer:
    def __init__(self) -> None:
        app.use_app('pyqt6')
        self.bus = SignalBus()
        self.ipython = get_current_ipython()
        self.scene_canvas: SceneCanvas = SceneCanvas(keys='interactive', show=True)
        self.view: ViewBox = self.scene_canvas.central_widget.add_view()
        self.view.camera = scene.cameras.TurntableCamera(fov=60)
        
        self.bus.subscribe(LayerUpdateEvent, self._on_layer_update)
    
    ## ----- Public API
    def run(self) -> None:
        self.scene_canvas.show()
        app.run()
        
    def add_image(self, data: np.ndarray, 
                  order: str = "TCZYX",
                  cmap: str = "gray",
                  interp: str = "nearest",) -> Layer:
        layer = Layer(data=data, order=order, bus=self.bus, colormap=cmap, interpolation=interp)
        arr = layer.as_render_array()
        visual_cls = Volume if arr.ndim == 3 else Image
        visual = visual_cls(arr, cmap=layer.colormap,
                            interpolation=layer.interpolation)
        layer.visual = visual
        self.view.add(visual)  # type: ignore
        return layer
        
    ## ----- Internals
    def _update_canvas(self) -> None:
        """Update the canvas to reflect changes."""
        self.scene_canvas.update()

    def _on_layer_update(self, ev: LayerUpdateEvent) -> None:
        if ev.layer.visual is None:
            print(f"Warning: Layer {ev.layer.name!r} has no visual to update.")
            return
        ev.layer.visual.cmap = ev.layer.colormap
        ev.layer.visual.set_data(ev.layer.as_render_array())

