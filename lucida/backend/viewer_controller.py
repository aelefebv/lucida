from vispy import scene, app
from PySide6 import QtWidgets


class ViewerController:
    """Create, collect, and configure VisPy views on demand."""
    def __init__(self):
        self._views = {}
        self.canvas = scene.SceneCanvas(
            keys="interactive",
            bgcolor="black",
        )
        self.canvas.create_native()
        self.canvas.native.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )
        self.grid = self.canvas.central_widget.add_grid()
        self.grid.padding = 6

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------
    def add_view(
        self, grid_x: int, grid_y: int, camera_type: str = "Turntable",  # or "PanZoom"
    ) -> scene.widgets.ViewBox:

        view = scene.widgets.ViewBox(border_color='white')
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
# Quick demo usage
# ----------------------------------------------------------------------
if __name__ == "__main__":
    app.use_app("pyside6")  # ensure VisPy knows to use Qt6
    qt_app = QtWidgets.QApplication([])

    main = QtWidgets.QMainWindow()
    splitter = QtWidgets.QSplitter()
    main.setCentralWidget(splitter)

    vc = ViewerController(parent=splitter)
    splitter.addWidget(vc.add_view())                       # view 1
    splitter.addWidget(vc.add_view(camera_type="PanZoom"))  # view 2

    main.resize(1200, 600)
    main.show()
    qt_app.exec()