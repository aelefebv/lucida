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
        self._snapshot_received = threading.Event()
        self._client_id: int | None = None
        self._peers: dict[int, dict] = {}
        self._follow_target: int | None = None

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
        if not self._snapshot_received.wait(timeout):
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
                                self._client_id = msg.get("your_id")
                                self._scene.load_document(json.dumps(msg["document"]))
                                self._peers = {}
                                for p in msg.get("peers", []):
                                    cid = p.get("client_id")
                                    if cid is not None:
                                        self._peers[cid] = p
                                self._follow_target = None
                                self._snapshot_received.set()
                            elif msg_type == "command_broadcast":
                                self._scene.apply_command(json.dumps(msg["command"]))
                            elif msg_type == "ack":
                                pass  # client already applied optimistically
                            elif msg_type == "presence_update":
                                cid = msg.get("client_id")
                                if cid is not None:
                                    self._peers.setdefault(cid, {}).update({
                                        "camera": msg["camera"],
                                        "view": msg["view"],
                                        "display": msg["display"],
                                    })
                                    if self._follow_target == cid:
                                        presence = json.dumps({
                                            "camera": msg["camera"],
                                            "view": msg["view"],
                                            "display": msg["display"],
                                        })
                                        self._scene.import_presence(presence)
                            elif msg_type == "follow_changed":
                                cid = msg.get("client_id")
                                target = msg.get("target")
                                if cid is not None and cid in self._peers:
                                    self._peers[cid]["following"] = target
                                if cid == self._client_id:
                                    self._follow_target = target
                            elif msg_type == "peer_joined":
                                cid = msg.get("client_id")
                                if cid is not None:
                                    self._peers[cid] = msg.get("presence", {})
                            elif msg_type == "peer_left":
                                cid = msg.get("client_id")
                                self._peers.pop(cid, None)
                                if self._follow_target == cid:
                                    self._follow_target = None
                        except Exception:
                            pass
            except Exception:
                self._ws = None
                self._snapshot_received.clear()
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

    # -- Follow mode --------------------------------------------------------

    def _break_follow(self):
        if self._follow_target is not None:
            self._follow_target = None
            self._send(json.dumps({"type": "follow", "target": None}))

    def follow(self, target_id: int):
        """Follow another client's viewport in real-time."""
        self._follow_target = target_id
        self._send(json.dumps({"type": "follow", "target": target_id}))
        peer = self._peers.get(target_id)
        if peer and "camera" in peer:
            presence = json.dumps({
                "camera": peer["camera"],
                "view": peer["view"],
                "display": peer["display"],
            })
            self._scene.import_presence(presence)

    def unfollow(self):
        """Stop following any client."""
        self._follow_target = None
        self._send(json.dumps({"type": "follow", "target": None}))

    @property
    def client_id(self) -> int | None:
        """Our server-assigned client ID."""
        return self._client_id

    @property
    def follow_target(self) -> int | None:
        """The client ID we are currently following, or None."""
        return self._follow_target

    @property
    def peers(self) -> dict[int, dict]:
        """Copy of the current peer presence map."""
        return dict(self._peers)

    def peer_ids(self) -> list[int]:
        """List of connected peer IDs."""
        return list(self._peers.keys())

    # -- Viewport commands (local only + presence) -------------------------

    def pan(self, dx: float, dy: float):
        self._break_follow()
        self._scene.pan(dx, dy)
        self._send_presence()

    def zoom_by(self, factor: float):
        self._break_follow()
        self._scene.zoom_by(factor)
        self._send_presence()

    def set_center(self, x: float, y: float):
        self._break_follow()
        self._scene.set_center(x, y)
        self._send_presence()

    def set_zoom(self, value: float):
        self._break_follow()
        self._scene.set_zoom(value)
        self._send_presence()

    def set_z(self, z: int):
        self._break_follow()
        self._scene.set_z(z)
        self._send_presence()

    def set_t(self, t: int):
        self._break_follow()
        self._scene.set_t(t)
        self._send_presence()

    def set_c(self, c: int):
        self._break_follow()
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
