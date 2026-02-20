from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, Sequence
from uuid import uuid4


DEFAULT_SOCKET_PATH = os.environ.get("LUCIDA_SOCKET_PATH", "/tmp/lucida.sock")
PROTOCOL_VERSION = "0.1.0"


class LucidaError(RuntimeError):
    """Raised when a daemon request fails."""


@dataclass(frozen=True)
class SubscriptionHandle:
    """Handle for a live event subscription."""

    stop: Callable[[], None]


class _RpcConnection:
    def __init__(self, socket_path: str) -> None:
        if os.name != "posix":
            raise LucidaError("Slice 1 Python SDK transport currently supports Unix domain sockets only")
        self._socket_path = socket_path
        self._socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket.connect(socket_path)
        self._reader = self._socket.makefile("r", encoding="utf-8")
        self._writer = self._socket.makefile("w", encoding="utf-8")
        self._lock = threading.Lock()

    def close(self) -> None:
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

        try:
            try:
                self._writer.close()
            finally:
                self._reader.close()
        finally:
            self._socket.close()

    def rpc(self, method: str, params: Mapping[str, Any] | None = None, session_id: str | None = None) -> Any:
        payload = {
            "jsonrpc": "2.0",
            "protocol_version": PROTOCOL_VERSION,
            "session_id": session_id,
            "request_id": str(uuid4()),
            "method": method,
            "params": dict(params or {}),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        with self._lock:
            self._writer.write(json.dumps(payload))
            self._writer.write("\n")
            self._writer.flush()

            response_line = self._reader.readline()
            if not response_line:
                raise LucidaError("daemon disconnected while waiting for response")

        response = json.loads(response_line)
        if response.get("error"):
            error = response["error"]
            raise LucidaError(f"{error.get('code')}: {error.get('message')}")

        return response.get("result")


class SessionAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def create(self) -> str:
        result = self._client._rpc("session.create", {})
        return str(result["session_id"])

    def close(self, session_id: str) -> dict[str, Any]:
        result = self._client._rpc("session.close", {}, session_id=session_id)
        return dict(result)

    def inspect(self, session_id: str) -> dict[str, Any]:
        result = self._client._rpc("session.inspect", {}, session_id=session_id)
        return dict(result)


class DatasetAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def open(
        self,
        session_id: str,
        uri: str,
        axis_map: Mapping[str, str] | None = None,
        read_only: bool = True,
    ) -> dict[str, Any]:
        result = self._client._rpc(
            "dataset.open",
            {
                "uri": uri,
                "axis_map": dict(axis_map or {}),
                "read_only": read_only,
            },
            session_id=session_id,
        )
        return dict(result)

    def close(self, session_id: str) -> dict[str, Any]:
        result = self._client._rpc("dataset.close", {}, session_id=session_id)
        return dict(result)


class LayerAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def add_image(
        self,
        session_id: str,
        layer_id: str | None = None,
        channel: int | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"metadata": dict(metadata or {})}
        if layer_id is not None:
            params["layer_id"] = layer_id
        if channel is not None:
            params["channel"] = channel
        result = self._client._rpc("layer.add_image", params, session_id=session_id)
        return dict(result)

    def add_points(
        self,
        session_id: str,
        positions: Sequence[Sequence[float]],
        layer_id: str | None = None,
        color_by: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "positions": [list(point) for point in positions],
            "metadata": dict(metadata or {}),
        }
        if layer_id is not None:
            params["layer_id"] = layer_id
        if color_by is not None:
            params["color_by"] = color_by
        result = self._client._rpc("layer.add_points", params, session_id=session_id)
        return dict(result)

    def update(
        self,
        session_id: str,
        layer_id: str,
        visible: bool | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"layer_id": layer_id}
        if visible is not None:
            params["visible"] = visible
        if metadata is not None:
            params["metadata"] = dict(metadata)
        result = self._client._rpc("layer.update", params, session_id=session_id)
        return dict(result)

    def remove(self, session_id: str, layer_id: str) -> dict[str, Any]:
        result = self._client._rpc("layer.remove", {"layer_id": layer_id}, session_id=session_id)
        return dict(result)

    def set_sampling(
        self,
        session_id: str,
        layer_id: str,
        sampling_mode: Literal["nearest", "linear"],
    ) -> dict[str, Any]:
        result = self._client._rpc(
            "layer.set_sampling",
            {"layer_id": layer_id, "sampling_mode": sampling_mode},
            session_id=session_id,
        )
        return dict(result)

    def set_contrast_limits(
        self,
        session_id: str,
        layer_id: str,
        min_value: int,
        max_value: int,
    ) -> dict[str, Any]:
        result = self._client._rpc(
            "layer.set_contrast_limits",
            {"layer_id": layer_id, "min": min_value, "max": max_value},
            session_id=session_id,
        )
        return dict(result)

    def auto_contrast(
        self,
        session_id: str,
        layer_id: str,
        method: str = "robust_percentile_1_99",
    ) -> dict[str, Any]:
        result = self._client._rpc(
            "layer.auto_contrast",
            {"layer_id": layer_id, "method": method},
            session_id=session_id,
        )
        return dict(result)


class ViewAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def set_axis(self, session_id: str, axis: str, index: int) -> dict[str, Any]:
        result = self._client._rpc("view.set_axis", {"axis": axis, "index": index}, session_id=session_id)
        return dict(result)

    def reorder_axes(self, session_id: str, order: Sequence[str]) -> dict[str, Any]:
        result = self._client._rpc("view.reorder_axes", {"order": list(order)}, session_id=session_id)
        return dict(result)

    def set_channel_order(self, session_id: str, order: Sequence[int]) -> dict[str, Any]:
        result = self._client._rpc("view.set_channel_order", {"order": list(order)}, session_id=session_id)
        return dict(result)

    def set_render_mode(
        self,
        session_id: str,
        mode: Literal["2d", "2d_stub", "3d", "graph_stub"],
    ) -> dict[str, Any]:
        result = self._client._rpc("view.set_render_mode", {"mode": mode}, session_id=session_id)
        return dict(result)


class CameraAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def set_mode(self, session_id: str, mode: str) -> dict[str, Any]:
        result = self._client._rpc("camera.set_mode", {"mode": mode}, session_id=session_id)
        return dict(result)

    def set_pose(self, session_id: str, pose: Mapping[str, Any]) -> dict[str, Any]:
        result = self._client._rpc("camera.set_pose", {"pose": dict(pose)}, session_id=session_id)
        return dict(result)


class EventsAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def subscribe(
        self,
        callback: Callable[[dict[str, Any]], None],
        session_id: str | None = None,
    ) -> SubscriptionHandle:
        event_conn = _RpcConnection(self._client.socket_path)
        event_conn.rpc("events.subscribe", {}, session_id=session_id)

        stop_event = threading.Event()

        def listener() -> None:
            while not stop_event.is_set():
                line = event_conn._reader.readline()
                if not line:
                    break
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "event" in payload:
                    callback(payload)

        thread = threading.Thread(target=listener, daemon=True, name="lucida-events-listener")
        thread.start()

        def stop() -> None:
            if stop_event.is_set():
                return
            stop_event.set()
            event_conn.close()
            thread.join(timeout=1)
            if stop in self._client._subscriptions:
                self._client._subscriptions.remove(stop)

        self._client._subscriptions.append(stop)
        return SubscriptionHandle(stop=stop)


class CommandLogAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def export(self) -> dict[str, Any]:
        result = self._client._rpc("command_log.export", {})
        return dict(result)

    def import_log(self, exported: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "protocol_version": exported.get("protocol_version"),
            "log_schema_version": exported.get("log_schema_version"),
            "replay_log": list(exported.get("replay_log", [])),
        }

    def replay(self, entries: Sequence[Mapping[str, Any]] | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if entries is not None:
            params["entries"] = [dict(entry) for entry in entries]
        result = self._client._rpc("command_log.replay", params)
        return dict(result)


class FrameChannelAPI:
    def __init__(self, client: "LucidaClient") -> None:
        self._client = client

    def open(self, session_id: str) -> dict[str, Any]:
        result = self._client._rpc("frame.channel.open", {}, session_id=session_id)
        return dict(result)


class LucidaClient:
    def __init__(self, connection: _RpcConnection, socket_path: str, process: subprocess.Popen[str] | None = None) -> None:
        self._connection = connection
        self.socket_path = socket_path
        self._process = process
        self._subscriptions: list[Callable[[], None]] = []

        self.session = SessionAPI(self)
        self.dataset = DatasetAPI(self)
        self.layer = LayerAPI(self)
        self.view = ViewAPI(self)
        self.camera = CameraAPI(self)
        self.events = EventsAPI(self)
        self.command_log = CommandLogAPI(self)
        self.frame_channel = FrameChannelAPI(self)

    @classmethod
    def connect(cls, socket_path: str = DEFAULT_SOCKET_PATH) -> "LucidaClient":
        connection = _RpcConnection(socket_path)
        return cls(connection=connection, socket_path=socket_path)

    @classmethod
    def launch_or_connect(
        cls,
        socket_path: str = DEFAULT_SOCKET_PATH,
        daemon_cmd: Sequence[str] | None = None,
        daemon_cwd: str | None = None,
        startup_timeout_s: float = 10.0,
    ) -> "LucidaClient":
        try:
            return cls.connect(socket_path=socket_path)
        except OSError:
            pass

        if daemon_cmd is None:
            daemon_cmd = [
                "cargo",
                "run",
                "-p",
                "lucida-daemon",
                "--",
                "--socket",
                socket_path,
            ]
            daemon_cwd = daemon_cwd or str(Path(__file__).resolve().parents[2] / "rust")

        process = subprocess.Popen(
            list(daemon_cmd),
            cwd=daemon_cwd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )

        deadline = time.time() + startup_timeout_s
        while time.time() < deadline:
            try:
                client = cls.connect(socket_path=socket_path)
                client._process = process
                return client
            except OSError:
                if process.poll() is not None:
                    raise LucidaError(f"daemon exited early with code {process.returncode}")
                time.sleep(0.1)

        process.terminate()
        raise LucidaError("timed out waiting for daemon startup")

    def close(self) -> None:
        for stop in list(self._subscriptions):
            try:
                stop()
            except OSError:
                pass
        self._subscriptions.clear()

        self._connection.close()

        if self._process is not None and self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()

    def _rpc(self, method: str, params: Mapping[str, Any], session_id: str | None = None) -> Any:
        return self._connection.rpc(method=method, params=params, session_id=session_id)

    def capabilities(self) -> dict[str, Any]:
        result = self._rpc("server.capabilities", {})
        return dict(result)

    def health(self) -> dict[str, Any]:
        result = self._rpc("health.ping", {})
        return dict(result)


__all__ = ["LucidaClient", "LucidaError", "SubscriptionHandle", "DEFAULT_SOCKET_PATH"]
