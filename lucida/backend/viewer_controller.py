from vispy import scene, app
from PySide6 import QtWidgets


class ViewerController:
    """Create, collect, and configure VisPy views on demand."""
    def __init__(self, parent: QtWidgets.QWidget | None = None):
        self._parent = parent           # keeps Qt ownership tidy
        self._views = []                # [(canvas, view, camera), ...]

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------
    def add_view(
        self,
        camera_type: str = "Turntable",
        canvas_kwargs: dict | None = None,
        camera_kwargs: dict | None = None,
    ) -> scene.SceneCanvas:
        """
        Create a SceneCanvas + ViewBox + Camera and return a QWidget you can
        embed anywhere (e.g. a splitter, grid, dock).

        Parameters
        ----------
        camera_type : {'turntable', 'panzoom', 'fly', ...}
            Any camera available in ``vispy.scene.cameras``.
        canvas_kwargs, camera_kwargs : dict | None
            Extra keyword args forwarded to SceneCanvas / Camera ctors.

        Returns
        -------
        widget : QtWidgets.QWidget
            ``canvas.native`` – the Qt wrapper around the GL canvas.
        """
        canvas_kwargs = canvas_kwargs or {}
        camera_kwargs = camera_kwargs or {}

        # 1. Build a SceneCanvas that lives inside Qt
        canvas = scene.SceneCanvas(
            parent=self._parent,
            keys="interactive",
            bgcolor="black",
            **canvas_kwargs,
        )
        canvas.create_native()          # make the .native QWidget
        canvas.native.setSizePolicy(
            QtWidgets.QSizePolicy.Policy.Expanding,
            QtWidgets.QSizePolicy.Policy.Expanding,
        )

        # 2. Attach a ViewBox in the usual grid-layout style
        view = canvas.central_widget.add_view()

        # 3. Choose and configure a camera
        CameraCls = getattr(scene.cameras, f"{camera_type}Camera")
        cam = CameraCls(**camera_kwargs)
        view.camera = cam

        # 4. Track everything in case you want cross-view logic later
        self._views.append((canvas, view, cam))
        return canvas            # <-- drop this into your GUI

    # Convenience accessor if you need all active views
    @property
    def views(self):
        return [v for _c, v, _cam in self._views]

    # Example: synchronize all cameras (optional)
    def link_cameras(self, source_view):
        for _canvas, view, _cam in self._views:
            if view is not source_view:
                view.camera.link(source_view.camera)


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