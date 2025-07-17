import numpy as np
from vispy import scene, app
from PySide6 import QtWidgets

from lucida.backend.canvas import LucidaCanvas
from lucida.backend.layer_manager import Layer, LayerManager
from lucida.core.signal_bus import SignalBus
from lucida.frontend.dim_slider import DimSlider
from lucida.backend.camera import LucidaFlyCamera
from vispy.visuals import VolumeVisual
from vispy.util.quaternion import Quaternion

available_cameras = {
    "Fly": LucidaFlyCamera,
    "Turntable": scene.cameras.TurntableCamera,
    "PanZoom": scene.cameras.PanZoomCamera,
}

class View(scene.ViewBox):
    """A custom ViewBox that can be used in the ViewManager."""
    def __init__(self, bus: SignalBus, **kwargs):
        self._bus = bus
        self.layer_manager = LayerManager(bus=self._bus, view=self)
        self.dim_sliders: dict[str, DimSlider] = {}
        self.largest_zyx = {"Z": 1, "Y": 1, "X": 1}  # Default to 1 for all dimensions
        super().__init__(**kwargs)
        
    def add_layer(self, layer: Layer, use_clipper: bool = True):
        for dim in layer.order:
            if dim not in "ZYX":
                self._add_dim_slider(dim, layer.data.shape[layer.order.index(dim)])
        visual = self.layer_manager.add_layer(layer)
        
        render_shape = layer.render_shape
        if render_shape:
            if 'Z' in layer.order and render_shape[-3] > self.largest_zyx["Z"]:
                self.largest_zyx["Z"] = render_shape[-3]
            if 'Y' in layer.order and render_shape[-2] > self.largest_zyx["Y"]:
                self.largest_zyx["Y"] = render_shape[-2]
            if 'X' in layer.order and render_shape[-1] > self.largest_zyx["X"]:
                self.largest_zyx["X"] = render_shape[-1]
                
        if use_clipper and isinstance(self.camera, LucidaFlyCamera):
            if isinstance(visual, VolumeVisual):
                self.camera.register_volume(visual)
            else:
                visual.attach(self.camera._clipper)
            
        self.add(visual)  # type: ignore            
            
    def set_default_camera_state(self):
        self.camera.set_range()
        
        layer_center = (self.largest_zyx["X"] // 2,
                        self.largest_zyx["Y"] // 2,
                        self.largest_zyx["Z"] * 8)
        self.camera.center = np.array(layer_center)

        # set the rotation to look down the -Z axis
        angles = (np.pi, np.pi, 0)
        q1 = Quaternion.create_from_axis_angle(angles[0], -1, 0, 0)
        q2 = Quaternion.create_from_axis_angle(angles[1], 0, 1, 0)
        q3 = Quaternion.create_from_axis_angle(angles[2], 0, 0, -1)
        q = q1 * q2 * q3
        self.camera._rotation1 = q.normalize()
        self.camera.set_default_state()   
                
    def _add_dim_slider(self, dim: str, size: int) -> DimSlider:
        """Add a dimension slider for the given dimension."""
        if dim not in self.dim_sliders:
            slider = DimSlider(bus=self._bus, dim=dim, size=size)
            self.dim_sliders[dim] = slider
        else:
            slider = self.dim_sliders[dim]
            slider.set_range(min_val=0, max_val=size - 1)
        return self.dim_sliders[dim]

class ViewManager:
    """Create, collect, and configure VisPy views on demand."""
    def __init__(self, bus: SignalBus):
        self._bus = bus
        self.canvas:        LucidaCanvas            = self._setup_canvas() 
        self.qt_widget:     QtWidgets.QWidget       = self._setup_qt_widget()
        self.canvas_widget: scene.widgets.Widget    = self._setup_central_widget()
        self.grid:          scene.Grid              = self._setup_grid()
        
        self._views: dict[str, View] = {}
        self._default_view_name = "default"
        self._timer = app.Timer(interval=0.1, connect=self._update_canvas, start=True)


    # ----- PUBLIC API
    def add_view(self, name: str | None = None, 
                 grid_xy: tuple[int, int] = (0, 0),
                 span_xy: tuple[int, int] = (1, 1), 
                 *,
                 camera_type: str = "Turntable",  # or "PanZoom"
                 border_color: str = 'white') -> View:
        """Add a new view to the grid layout and returns it. Removes any existing view with the same name."""
        camera_cls = available_cameras.get(camera_type, LucidaFlyCamera)
        view = View(bus=self._bus, camera=camera_cls(), border_color=border_color)

        name = name or self._default_view_name
        if name in self._views:
            self.grid.remove_widget(self._views[name])
        self._views[name] = view
        self.grid.add_widget(view, row=grid_xy[0], col=grid_xy[1], 
                             row_span=span_xy[0], col_span=span_xy[1])
        return view  

    @property
    def views(self) -> dict[str, View]:
        """Return all views."""
        return self._views
    
    def get_view(self, name: str | None) -> View | None:
        """Get a view by name, or None if it doesn't exist."""
        name = name or self._default_view_name
        return self._views.get(name, None)

    # ----- PRIVATE API
    def _setup_canvas(self) -> LucidaCanvas:
        """Create a VisPy canvas with a central widget."""
        return LucidaCanvas(self._bus)

    def _setup_qt_widget(self) -> QtWidgets.QWidget:
        """Return the Qt widget for the canvas."""
        qt_widget: QtWidgets.QWidget = self.canvas.native
        qt_widget.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )
        return qt_widget
    
    def _setup_central_widget(self) -> scene.widgets.Widget:
        """Create a central widget for the canvas."""
        return self.canvas.central_widget

    def _setup_grid(self) -> scene.Grid:
        """Create a grid layout for the central widget."""
        grid = scene.Grid()
        grid.padding = 6
        self.canvas_widget.add_widget(grid)
        return grid
    
    def _update_canvas(self, event):
        """Update the canvas periodically."""
        # Let's print the camera state for debugging
        self.canvas.update()
        for name, view in self._views.items():
            view.update()