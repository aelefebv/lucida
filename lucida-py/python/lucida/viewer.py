import asyncio
import json
import threading

import websockets

from lucida.lucida import PyScene


class Viewer:
    """High-level wrapper around PyScene that connects to a lucida-server relay."""

    def __init__(self, width: int = 800, height: int = 600, port: int = 9876):
        self._scene = PyScene(width, height)
        self._port = port
        self._url = f"ws://localhost:{port}"
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ws = None
        self._connected = threading.Event()

    # -- WebSocket client --------------------------------------------------

    def start(self, timeout: float = 5.0):
        """Connect to the lucida-server relay in a background thread.

        Blocks until the WebSocket connection is established or timeout is reached.
        """
        if self._thread is not None:
            return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        if not self._connected.wait(timeout):
            print(f"warning: could not connect to {self._url} within {timeout}s")

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._connect())

    async def _connect(self):
        while True:
            try:
                async with websockets.connect(self._url) as ws:
                    self._ws = ws
                    self._connected.set()
                    async for message in ws:
                        try:
                            msg = json.loads(message)
                            msg_type = msg.get("type")
                            if msg_type == "snapshot":
                                self._scene.load_document(json.dumps(msg["document"]))
                            elif msg_type == "command_broadcast":
                                self._scene.apply_command(json.dumps(msg["command"]))
                            elif msg_type == "ack":
                                pass  # client already applied optimistically
                        except Exception:
                            pass
            except Exception:
                self._ws = None
                await asyncio.sleep(2)

    def _send(self, message: str):
        if self._loop is None or self._ws is None:
            return
        asyncio.run_coroutine_threadsafe(self._do_send(message), self._loop)

    async def _do_send(self, message: str):
        ws = self._ws
        if ws is not None:
            try:
                await ws.send(message)
            except Exception:
                pass

    def _send_presence(self):
        """Send current viewport state as a presence update."""
        self._send(self._scene.presence_json())

    def _send_command(self, cmd_json: str):
        """Wrap a document command in a ClientMessage envelope and send."""
        cmd = json.loads(cmd_json)
        self._send(json.dumps({"type": "command", "command": cmd}))

    # -- Viewport commands (local only + presence) -------------------------

    def pan(self, dx: float, dy: float):
        self._scene.pan(dx, dy)
        self._send_presence()

    def zoom_by(self, factor: float):
        self._scene.zoom_by(factor)
        self._send_presence()

    def set_center(self, x: float, y: float):
        self._scene.set_center(x, y)
        self._send_presence()

    def set_zoom(self, value: float):
        self._scene.set_zoom(value)
        self._send_presence()

    def set_z(self, z: int):
        self._scene.set_z(z)
        self._send_presence()

    def set_t(self, t: int):
        self._scene.set_t(t)
        self._send_presence()

    def set_c(self, c: int):
        self._scene.set_c(c)
        self._send_presence()

    # -- Document commands (apply locally + send wrapped) ------------------

    def apply_command(self, cmd_json: str):
        self._scene.apply_command(cmd_json)
        self._send_command(cmd_json)

    # -- Read-only accessors -----------------------------------------------

    def zoom(self) -> float:
        return self._scene.zoom()

    def center(self) -> tuple[float, float]:
        return self._scene.center()

    def z(self) -> int:
        return self._scene.z()

    def t(self) -> int:
        return self._scene.t()

    def c(self) -> int:
        return self._scene.c()

    def chunk_plan(self) -> dict:
        return json.loads(self._scene.chunk_plan())

    def add_layer(
        self,
        name: str,
        visible: bool,
        num_levels: int,
        chunk_x: int,
        chunk_y: int,
        chunk_z: int,
        shape_x: int,
        shape_y: int,
        shape_z: int,
    ):
        self._scene.add_layer(
            name, visible, num_levels,
            chunk_x, chunk_y, chunk_z,
            shape_x, shape_y, shape_z,
        )
