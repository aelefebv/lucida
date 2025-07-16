from vispy import scene
from PySide6 import QtWidgets

class ViewerController:
    """Create, collect, and configure VisPy views on demand."""
    def __init__(self):
        self.canvas:        scene.SceneCanvas       = self._setup_canvas() 
        self.qt_widget:     QtWidgets.QWidget       = self._setup_qt_widget()
        self.canvas_widget: scene.widgets.Widget    = self._setup_central_widget()
        self.grid:          scene.Grid              = self._setup_grid()
        
        self._views: dict[str, scene.ViewBox] = {}

    # ----- PUBLIC API
    def add_view(self, name: str = "default",
                 grid_xy: tuple[int, int] = (0, 0),
                 span_xy: tuple[int, int] = (1, 1), 
                 *,
                 camera_type: str = "Turntable",  # or "PanZoom"
                 border_color: str = 'white') -> scene.ViewBox:
        """Add a new view to the grid layout and returns it. Removes any existing view with the same name."""

        camera_cls = getattr(scene.cameras, camera_type + "Camera")
        view = scene.ViewBox(camera=camera_cls(), border_color=border_color)
        
        if name in self._views:
            self.grid.remove_widget(self._views[name])
        self._views[name] = view
        self.grid.add_widget(view, row=grid_xy[0], col=grid_xy[1], 
                             row_span=span_xy[0], col_span=span_xy[1])
        return view  

    @property
    def views(self) -> list[scene.ViewBox]:
        """Return a list of all views."""
        return [v for v in self._views.values()]
    
    def get_view(self, name: str) -> scene.ViewBox | None:
        """Get a view by name, or None if it doesn't exist."""
        return self._views.get(name, None)

    # ----- PRIVATE API
    def _setup_canvas(self) -> scene.SceneCanvas:
        """Create a VisPy canvas with a central widget."""
        return scene.SceneCanvas()

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