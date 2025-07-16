from lucida.backend.viewer_controller import ViewerController
from lucida.frontend.main_window import MainApplication, MainWindow

class Viewer:
    def __init__(self):
        self.app =      MainApplication()
        self.window =   MainWindow()
        self.vc =       ViewerController()        
        self.window.set_central_widget(self.vc.qt_widget)   
        
    # def 
        