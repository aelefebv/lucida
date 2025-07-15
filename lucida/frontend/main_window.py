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


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()

        # --- Window meta ---
        self.setWindowTitle("PySide6 Main Window Demo")
        self.setMinimumSize(QSize(480, 320))  # width, height

        # --- Central widget ---
        central = QWidget()
        layout = QVBoxLayout(central)
        label = QLabel("Hello, PySide6!")
        label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(label)
        self.setCentralWidget(central)

        # --- Toolbar ---
        toolbar = QToolBar("Main toolbar")
        toolbar.setIconSize(QSize(16, 16))
        self.addToolBar(toolbar)

        # create a QAction with an icon, a name, and a triggered slot
        greet_action = QAction(QIcon.fromTheme("face-smile"), "Greet", self)
        greet_action.setStatusTip("Show a friendly greeting")
        greet_action.triggered.connect(self.say_hello)
        toolbar.addAction(greet_action)

        # --- Status bar ---
        self.setStatusBar(QStatusBar())

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