import asyncio
import json
import math
import struct
import threading
import uuid

import numpy as np
import websockets

from lucida.lucida import PyScene
from lucida.zarr_reader import (
    LevelMeta,
    ViewportData,
    assemble_chunks,
    decompress_chunk,
    read_chunk_from_file,
    read_level_meta,
)


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
        self._document: dict | None = None
        self._pending_chunks: dict[str, threading.Event] = {}
        self._chunk_data: dict[str, bytes] = {}
        self._served_chunks: dict[str, dict[str, bytes]] = {}
        self._served_meta: dict[str, dict] = {}

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
                async with websockets.connect(self._url, max_size=None) as ws:
                    self._ws = ws
                    self._connected.set()
                    async for message in ws:
                        try:
                            if isinstance(message, bytes):
                                self._handle_binary(message)
                                continue
                            msg = json.loads(message)
                            msg_type = msg.get("type")
                            if msg_type == "snapshot":
                                self._client_id = msg.get("your_id")
                                self._document = msg.get("document")
                                self._scene.load_document(json.dumps(msg["document"]))
                                self._peers = {}
                                for p in msg.get("peers", []):
                                    cid = p.get("client_id")
                                    if cid is not None:
                                        self._peers[cid] = p
                                self._follow_target = None
                                self._snapshot_received.set()
                            elif msg_type == "command_broadcast":
                                cmd = msg["command"]
                                self._scene.apply_command(json.dumps(cmd))
                                self._update_document_from_command(cmd)
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
                                        self._send_presence()
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
                            elif msg_type == "chunk_fetch":
                                self._serve_chunk(msg["client_id"], msg["dataset_id"], msg["key"])
                        except Exception:
                            pass
            except Exception:
                self._ws = None
                self._snapshot_received.clear()
                await asyncio.sleep(2)

    def _handle_binary(self, data: bytes):
        """Parse binary chunk response: [client_id:4B][key_len:2B][key][chunk_data]."""
        if len(data) < 6:
            return
        key_len = struct.unpack_from("<H", data, 4)[0]
        if len(data) < 6 + key_len:
            return
        key = data[6:6 + key_len].decode("utf-8")
        chunk_data = data[6 + key_len:]
        self._chunk_data[key] = chunk_data
        event = self._pending_chunks.get(key)
        if event is not None:
            event.set()

    def _update_document_from_command(self, cmd: dict):
        """Keep self._document in sync with document commands."""
        if self._document is None:
            return
        cmd_type = cmd.get("type")
        if cmd_type == "add_dataset":
            datasets = self._document.setdefault("datasets", [])
            # Replace existing or append
            for i, ds in enumerate(datasets):
                if ds.get("id") == cmd.get("id"):
                    datasets[i] = cmd
                    return
            datasets.append(cmd)
        elif cmd_type == "remove_dataset":
            datasets = self._document.get("datasets", [])
            self._document["datasets"] = [
                ds for ds in datasets if ds.get("id") != cmd.get("id")
            ]

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

    def _send_bytes(self, data: bytes):
        if self._loop is None or self._ws is None:
            return
        asyncio.run_coroutine_threadsafe(self._do_send_bytes(data), self._loop)

    async def _do_send_bytes(self, data: bytes):
        ws = self._ws
        if ws is not None:
            try:
                await ws.send(data)
            except Exception:
                pass

    def _serve_chunk(self, client_id: int, dataset_id: str, key: str):
        ds_chunks = self._served_chunks.get(dataset_id)
        if ds_chunks is None:
            return
        raw = ds_chunks.get(key)
        if raw is None:
            meta = self._served_meta[dataset_id]
            cz, cy, cx = meta["chunk_shape"]
            raw = np.zeros((cz, cy, cx), dtype=meta["dtype"]).tobytes()
        composite = f"{dataset_id}/{key}"
        key_bytes = composite.encode("utf-8")
        header = struct.pack("<IH", client_id, len(key_bytes))
        self._send_bytes(header + key_bytes + raw)

    def _send_presence(self):
        """Send current viewport state as a presence update."""
        self._send(self._scene.presence_json())

    def _send_command(self, cmd_json: str):
        """Wrap a document command in a ClientMessage envelope and send."""
        cmd = json.loads(cmd_json)
        self._send(json.dumps({"type": "command", "command": cmd}))

    # -- Steer --------------------------------------------------------------

    def steer(self, client_id: int):
        """Make another client follow this viewer (remote-control their viewport)."""
        self._send(json.dumps({"type": "steer", "client": client_id}))

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
            self._send_presence()

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
    def camera(self) -> dict:
        """The local camera state as a dict."""
        return json.loads(self._scene.camera_json())

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

    def set_mode_2d(self):
        self._break_follow()
        self._scene.set_mode_2d()
        self._send_presence()

    def set_mode_3d(self):
        self._break_follow()
        self._scene.set_mode_3d()
        self._send_presence()

    def rotate(self, theta: float = 0.0, phi: float = 0.0, *, degrees: bool = True):
        """Rotate the 3D camera.

        Args:
            theta: Horizontal rotation.
            phi: Vertical rotation.
            degrees: If True (default), angles are in degrees. If False, radians.
        """
        if degrees:
            theta = math.radians(theta)
            phi = math.radians(phi)
        self._break_follow()
        self._scene.rotate_3d(theta, phi)
        self._send_presence()

    @property
    def is_3d(self) -> bool:
        return self._scene.is_3d()

    # -- Document commands (apply locally + send wrapped) ------------------

    def apply_command(self, cmd_json: str):
        self._scene.apply_command(cmd_json)
        self._update_document_from_command(json.loads(cmd_json))
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

    @property
    def datasets(self) -> list[dict]:
        """List of datasets in the document."""
        if self._document is None:
            return []
        return self._document.get("datasets", [])

    def _resolve_dataset(self, dataset: int | str) -> dict:
        """Resolve a dataset specifier (id str, name str, or int index) to its document dict."""
        datasets = self.datasets
        if isinstance(dataset, int):
            if dataset >= len(datasets):
                raise IndexError(f"Dataset index {dataset} out of range (have {len(datasets)})")
            return datasets[dataset]
        for ds in datasets:
            if ds["id"] == dataset:
                return ds
        for ds in datasets:
            if ds.get("name") == dataset:
                return ds
        raise KeyError(f"No dataset matching {dataset!r}")

    def chunk_plan(self) -> dict:
        return json.loads(self._scene.chunk_plan())

    def chunk_plan_for(self, dataset: int | str = 0) -> dict:
        """Chunk plan for a specific dataset (by index, id, or name)."""
        ds = self._resolve_dataset(dataset)
        return json.loads(self._scene.chunk_plan_for(ds["id"]))

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

    # -- Viewport data reading ------------------------------------------------

    def read_viewport(
        self, store_path: str | None = None, *, dataset: int | str = 0, timeout: float = 30.0
    ) -> ViewportData:
        """Read all chunks in the current viewport and assemble as a numpy array.

        Args:
            store_path: Path to the ``.ome.zarr`` store on disk (local mode).
                If ``None``, chunks are fetched through the server (remote mode).
            dataset: Dataset index, id, or name.
            timeout: Seconds to wait for each remote chunk response.

        Returns:
            A :class:`ViewportData` with the assembled volume.
        """
        ds = self._resolve_dataset(dataset)
        dataset_id = ds["id"]

        plan = json.loads(self._scene.chunk_plan_for(dataset_id))
        needed = plan.get("needed", [])
        if not needed:
            raise ValueError(f"No chunks in viewport for dataset {dataset!r}")

        level = needed[0]["level"]
        t_val = needed[0]["t"]
        c_val = needed[0]["c"]

        if store_path is not None:
            return self._read_viewport_local(store_path, needed, level, t_val, c_val)
        else:
            return self._read_viewport_remote(needed, level, t_val, c_val, ds, timeout)

    def _read_viewport_local(
        self,
        store_path: str,
        needed: list[dict],
        level: int,
        t_val: int,
        c_val: int,
    ) -> ViewportData:
        meta = read_level_meta(store_path, level)
        chunks_dict: dict[str, np.ndarray] = {}
        for ch in needed:
            arr = read_chunk_from_file(
                store_path, level, ch["t"], ch["c"], ch["z"], ch["y"], ch["x"], meta
            )
            chunks_dict[ch["key"]] = arr

        data, origin = assemble_chunks(
            chunks_dict, needed, meta.chunk_shape, meta.shape, meta.dtype
        )
        return ViewportData(
            data=data,
            origin=origin,
            level=level,
            level_shape=meta.shape,
            chunk_shape=meta.chunk_shape,
            t=t_val,
            c=c_val,
        )

    def _read_viewport_remote(
        self,
        needed: list[dict],
        level: int,
        t_val: int,
        c_val: int,
        ds: dict,
        timeout: float,
    ) -> ViewportData:
        dataset_id = ds["id"]
        client_meta = ds.get("client_metadata")
        if client_meta is None:
            raise ValueError(f"Dataset {dataset_id!r} has no client_metadata")

        level_meta = client_meta["levels"][level]
        # chunkShape and shape are [T, C, Z, Y, X]
        chunk_shape_zyx = (level_meta["chunkShape"][2], level_meta["chunkShape"][3], level_meta["chunkShape"][4])
        shape_zyx = (level_meta["shape"][2], level_meta["shape"][3], level_meta["shape"][4])
        dtype = np.dtype(level_meta["dataType"])
        codecs = level_meta.get("codecs", [])

        # Set up events for each chunk using composite keys (datasetId/key)
        # to match the key format the web data source encodes in binary responses.
        events: dict[str, threading.Event] = {}
        for ch in needed:
            composite = f"{dataset_id}/{ch['key']}"
            event = threading.Event()
            events[composite] = event
            self._pending_chunks[composite] = event

        # Send chunk requests
        for ch in needed:
            self._send(json.dumps({
                "type": "chunk_request",
                "dataset_id": dataset_id,
                "key": ch["key"],
            }))

        # Wait for all responses
        for composite, event in events.items():
            if not event.wait(timeout):
                # Clean up
                for k in events:
                    self._pending_chunks.pop(k, None)
                    self._chunk_data.pop(k, None)
                raise TimeoutError(f"Timed out waiting for chunk {composite!r}")

        # Decompress and reshape
        chunks_dict: dict[str, np.ndarray] = {}
        cz, cy, cx = chunk_shape_zyx
        for ch in needed:
            composite = f"{dataset_id}/{ch['key']}"
            raw = self._chunk_data.pop(composite)
            self._pending_chunks.pop(composite, None)
            decompressed = decompress_chunk(raw, codecs)
            arr = np.frombuffer(decompressed, dtype=dtype).reshape((cz, cy, cx))
            chunks_dict[ch["key"]] = arr

        # Extract physical scale (Z, Y, X) from level metadata
        level_scale = level_meta.get("scale", [1.0, 1.0, 1.0, 1.0, 1.0])
        scale_zyx = (level_scale[2], level_scale[3], level_scale[4])

        data, origin = assemble_chunks(
            chunks_dict, needed, chunk_shape_zyx, shape_zyx, dtype
        )
        return ViewportData(
            data=data,
            origin=origin,
            level=level,
            level_shape=shape_zyx,
            chunk_shape=chunk_shape_zyx,
            t=t_val,
            c=c_val,
            scale=scale_zyx,
        )

    # -- Write viewport data as a new dataset ---------------------------------

    def write_viewport(self, viewport_data: ViewportData, *, name: str = "Python Result") -> str:
        """Upload modified viewport data as a new dataset visible to all clients.

        Args:
            viewport_data: A :class:`ViewportData` (e.g. from :meth:`read_viewport`).
            name: Human-readable name for the new dataset.

        Returns:
            The generated dataset ID.
        """
        dataset_id = uuid.uuid4().hex[:12]
        data = viewport_data.data
        oz, oy, ox = viewport_data.origin
        cz, cy, cx = viewport_data.chunk_shape
        level = viewport_data.level
        t_val = viewport_data.t
        c_val = viewport_data.c
        dz, dy, dx = data.shape
        dtype = data.dtype

        # Compute chunk grid coordinates
        gz0 = oz // cz
        gy0 = oy // cy
        gx0 = ox // cx

        nz = math.ceil(dz / cz)
        ny = math.ceil(dy / cy)
        nx = math.ceil(dx / cx)

        chunks: dict[str, bytes] = {}
        for iz in range(nz):
            for iy in range(ny):
                for ix in range(nx):
                    # Slice from data
                    sz = iz * cz
                    sy = iy * cy
                    sx = ix * cx
                    ez = min(sz + cz, dz)
                    ey = min(sy + cy, dy)
                    ex = min(sx + cx, dx)
                    block = data[sz:ez, sy:ey, sx:ex]

                    # Zero-pad to full chunk size if needed
                    if block.shape != (cz, cy, cx):
                        padded = np.zeros((cz, cy, cx), dtype=dtype)
                        padded[:block.shape[0], :block.shape[1], :block.shape[2]] = block
                        block = padded

                    key = f"{level}/{t_val}/{c_val}/{gz0 + iz}/{gy0 + iy}/{gx0 + ix}"
                    chunks[key] = block.tobytes()

        self._served_chunks[dataset_id] = chunks
        self._served_meta[dataset_id] = {
            "chunk_shape": (cz, cy, cx),
            "dtype": dtype,
        }

        # Build level shape from viewport_data
        lz, ly, lx = viewport_data.level_shape
        sz, sy, sx = viewport_data.scale

        add_dataset_cmd = {
            "type": "add_dataset",
            "id": dataset_id,
            "name": name,
            "layers": [{
                "name": "main",
                "visible": True,
                "num_levels": 1,
                "chunk_size": [int(cx), int(cy), int(cz)],
                "data_shape": [int(lx), int(ly), int(lz)],
            }],
            "volume_shape": [int(lz), int(ly), int(lx)],
            "volume_scale": [sz, sy, sx],
            "client_metadata": {
                "axes": [
                    {"name": "t", "type": "time"},
                    {"name": "c", "type": "channel"},
                    {"name": "z", "type": "space"},
                    {"name": "y", "type": "space"},
                    {"name": "x", "type": "space"},
                ],
                "levels": [{
                    "path": "0",
                    "shape": [1, 1, int(lz), int(ly), int(lx)],
                    "chunkShape": [1, 1, int(cz), int(cy), int(cx)],
                    "dataType": str(dtype),
                    "scale": [1.0, 1.0, sz, sy, sx],
                    "codecs": [],
                }],
            },
        }

        self.apply_command(json.dumps(add_dataset_cmd))
        return dataset_id
