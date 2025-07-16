from vispy import scene
from PySide6 import QtWidgets


class ViewerController:
    """Create, collect, and configure VisPy views on demand."""
    def __init__(self):
        self._views = {}
        self.canvas:        scene.SceneCanvas       = self._setup_canvas() 
        self.qt_widget:     QtWidgets.QWidget       = self._setup_qt_widget()
        self.canvas_widget: scene.widgets.Widget    = self._setup_central_widget()
        self.grid:          scene.Grid              = self._setup_grid()

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------
    def add_view(
        self, grid_x: int, grid_y: int, camera_type: str = "Turntable",  # or "PanZoom"
    ) -> scene.ViewBox:

        view = scene.ViewBox(border_color='white')
        camera_cls = getattr(scene.cameras, camera_type + "Camera")
        view.camera = camera_cls()
        self._views[grid_x, grid_y] = view
        self.grid.add_widget(view, grid_x, grid_y)
        return view            # <-- drop this into your GUI

    # Convenience accessor if you need all active views
    @property
    def views(self):
        return [v for v in self._views.values()]

    # ----------------------------------------------------------------------
    # PRIVATE API
    def _setup_canvas(self) -> scene.SceneCanvas:
        """Create a VisPy canvas with a central widget."""
        canvas = scene.SceneCanvas(
            keys="interactive",
            bgcolor="black",
        )
        return canvas

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