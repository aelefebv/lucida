
from PySide6.QtWidgets import QApplication, QDockWidget
from PySide6.QtCore import Qt
import numpy as np

from lucida.backend.viewer_controller import ViewerController
from lucida.frontend.main_window import MainWindow
from vispy.scene.visuals import Volume

def main():
    app = QApplication()
    main = MainWindow()
    vc = ViewerController()
    canvas_view = vc.add_view(camera_type="PanZoom")
    main.setCentralWidget(canvas_view.native)  # or use a layout, splitter, dock, etc

    mini = vc.add_view(camera_type="PanZoom")
    dock = QDockWidget("Mini View")
    dock.setWidget(mini.native)
    main.addDockWidget(Qt.DockWidgetArea.RightDockWidgetArea, dock)
    
    data = np.random.rand(30, 40, 50).astype(np.float32)  # 3D volume
    vol = Volume(data, interpolation='nearest', cmap='viridis')
    vol2 = Volume(data, interpolation='nearest', cmap='viridis')
    vc.views[0].add(vol)
    vc.views[1].add(vol2)

    main.show()
    app.exec()