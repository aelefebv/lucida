from vispy.scene.canvas import SceneCanvas
from vispy import app

from lucida.core.events import KeyPressed
from lucida.core.signal_bus import SignalBus

class LucidaCanvas(SceneCanvas):
    def __init__(self, bus: SignalBus) -> None:
        self._bus = bus
        super().__init__(
            keys='interactive', 
            show=False, 
            title="Lucida")

    def on_key_press(self, event: app.KeyEvent) -> None:
        if event.handled:          # camera already used it
            return
        self._bus.emit(
            KeyPressed(
                key=event.key,  # If user pressed S, event.key == 'S' is True
                modifiers=tuple(event.modifiers),
            )
        )