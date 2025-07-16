from PySide6.QtWidgets import (
    QApplication,
    QMainWindow,
    QWidget,
    QLabel,
    QVBoxLayout,
    QToolBar,
    QStatusBar,
    QMessageBox,
    QDockWidget,
)
from PySide6.QtGui import QIcon, QAction
from PySide6.QtCore import QSize, Qt
import sys
from PySide6.QtWidgets import QApplication

from lucida.core.signal_bus import SignalBus
from lucida.frontend.dim_slider import DimSlider

class MainApplication(QApplication):
    """Main application class for Lucida."""
    def __init__(self, bus: SignalBus):
        self._bus = bus
        super().__init__()
        self.setApplicationName("Lucida")
        self.setApplicationVersion("0.0.1")
        self.setOrganizationName("Austin E. Y. T. Lefebvre")
        self.setOrganizationDomain("https://github.com/aelefebv")

class MainWindow(QMainWindow):
    """Main window for the Lucida application."""
    def __init__(self, bus: SignalBus):
        self._bus = bus
        super().__init__()
        self._setup_window()

        # --- Central widget ---
        central = QWidget()
        layout = QVBoxLayout(central)
        
        label = QLabel("Hello, PySide6!")
        label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(label)
        self.setCentralWidget(central)
        
        # --- Bottom Slider VBox ---
        
        dock = QDockWidget("Dimension Sliders", self)
        self._dim_slider_widget = QWidget()
        # TODO(austin): Should put an HBox so I can put the label too
        self.dim_slider_vbox = QVBoxLayout(self._dim_slider_widget)
        self._dim_slider_widget.setLayout(self.dim_slider_vbox)
        dock.setWidget(self._dim_slider_widget)
        dock.setAllowedAreas(Qt.DockWidgetArea.BottomDockWidgetArea)
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, dock)
        

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
        
    def clear_dim_sliders(self):
        """Clear all dimension sliders from the main window."""
        for slider in self.dim_slider_vbox.children():
            if isinstance(slider, DimSlider):
                self.dim_slider_vbox.removeWidget(slider)
                slider.deleteLater()
        self.dim_slider_vbox.update()
        
    def add_dim_slider(self, slider: DimSlider):
        """Add a dimension slider to the main window."""
        self.dim_slider_vbox.addWidget(slider)
        self.dim_slider_vbox.update()
    
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
