from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QWidget,
    QLabel,
    QVBoxLayout,
    QToolBar,
    QStatusBar,
    QMessageBox,
)
from PySide6.QtGui import QIcon, QAction
from PySide6.QtCore import QSize, Qt
import sys
from PySide6.QtWidgets import QApplication

class MainApplication(QApplication):
    def __init__(self):
        super().__init__()
        self.setApplicationName("Lucida")
        self.setApplicationVersion("0.0.1")
        self.setOrganizationName("Austin E. Y. T. Lefebvre")
        self.setOrganizationDomain("https://github.com/aelefebv")

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self._setup_window()

        # --- Central widget ---
        central = QWidget()
        layout = QVBoxLayout(central)
        label = QLabel("Hello, PySide6!")
        label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(label)
        self.setCentralWidget(central)

        # --- Toolbar ---
        toolbar = QToolBar("Main toolbar", movable=False)
        toolbar.setIconSize(QSize(16, 16))
        self.addToolBar(toolbar)

        # create a QAction with an icon, a name, and a triggered slot
        greet_action = QAction(QIcon.fromTheme("face-smile"), "Greet", self)
        greet_action.setStatusTip("Show a friendly greeting")
        greet_action.triggered.connect(self.say_hello)
        toolbar.addAction(greet_action)

        # --- Status bar ---
        self.setStatusBar(QStatusBar())
    
    def _setup_window(self):
        self.set_title("Lucida")
        self.set_default_size()
    
    def set_title(self, title: str):
        self.setWindowTitle(title)
        
    def set_default_size(self):
         # Get screen geometry
        screen_geometry = self.screen().availableGeometry()
        
        # Set minimum size as a fraction of screen size
        width = int(screen_geometry.width() * 0.8)
        height = int(screen_geometry.height() * 0.8)
        
        self.resize(width, height)
    
    def set_central_widget(self, widget: QWidget):
        """Set the central widget of the main window."""
        self.setCentralWidget(widget)

    # Slot (any callable can be a slot in PyQt 6)
    def say_hello(self):
        QMessageBox.information(self, "Hi there!", "Thanks for clicking me 😊")


def main():
    app = QApplication(sys.argv)

    # create, show, and execute main event loop
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()