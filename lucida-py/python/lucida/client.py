from __future__ import annotations

import asyncio
import copy
import json
import os
import platform
import stat
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen


DEFAULT_SERVER = "http://localhost:9876"
KEYCHAIN_SERVICE = "lucida-cli"


class LucidaError(RuntimeError):
    """Structured client error shared by HTTP and WebSocket operations."""

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        status: int | None = None,
        body: str | None = None,
        diagnostic: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status
        self.body = body
        self.diagnostic = diagnostic

    def to_dict(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "kind": self.kind,
            "message": self.message,
        }
        if self.status is not None:
            error["status"] = self.status
        if self.diagnostic is not None:
            error["diagnostic"] = self.diagnostic
        return {"error": error}


@dataclass(frozen=True)
class EffectiveServer:
    url: str
    source: str


@dataclass(frozen=True)
class EffectiveToken:
    token: str
    source: str


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes
    headers: dict[str, str]

    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.text())


class UrllibTransport:
    """Small stdlib transport used so the server client stays dependency-light."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | None = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        request = Request(url, data=body, headers=headers or {}, method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                return HttpResponse(
                    status=response.status,
                    body=response.read(),
                    headers=dict(response.headers.items()),
                )
        except HTTPError as error:
            return HttpResponse(
                status=error.code,
                body=error.read(),
                headers=dict(error.headers.items()),
            )
        except URLError as error:
            raise LucidaError("unreachable_server", str(error)) from error


class ConfigStore:
    """Read and write the same local config file shape as the Rust CLI."""

    def __init__(self, path: str | os.PathLike[str] | None = None):
        self.path = Path(path) if path is not None else default_config_path()

    def load(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except json.JSONDecodeError as error:
            raise LucidaError("config", f"invalid config JSON: {error}") from error

    def save(self, config: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(config, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        try:
            self.path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass


def default_config_path() -> Path:
    if path := os.environ.get("LUCIDA_CONFIG_PATH"):
        return Path(path)
    if config_home := os.environ.get("XDG_CONFIG_HOME"):
        return Path(config_home) / "lucida" / "config.json"
    home = os.environ.get("HOME")
    if not home:
        raise LucidaError("config", "HOME is not set; set LUCIDA_CONFIG_PATH")
    return Path(home) / ".config" / "lucida" / "config.json"


def normalize_server_base_url(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise LucidaError("invalid_server", "server URL cannot be empty")
    if "://" not in trimmed:
        trimmed = f"http://{trimmed}"
    parsed = urlparse(trimmed)
    if parsed.scheme not in {"http", "https"}:
        raise LucidaError(
            "invalid_server",
            f"unsupported server URL scheme: {parsed.scheme}",
        )
    if not parsed.netloc:
        raise LucidaError("invalid_server", "server URL must include a host")
    normalized = urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path.rstrip("/"),
            "",
            "",
            "",
        )
    )
    return normalized.rstrip("/") or f"{parsed.scheme}://{parsed.netloc}"


def resolve_server(
    server: str | None = None,
    *,
    config: dict[str, Any] | None = None,
) -> EffectiveServer:
    if server is not None:
        return EffectiveServer(normalize_server_base_url(server), "flag")
    if config and config.get("server"):
        return EffectiveServer(normalize_server_base_url(str(config["server"])), "config")
    return EffectiveServer(DEFAULT_SERVER, "default")


def resolve_token(
    server_url: str,
    *,
    config: dict[str, Any] | None = None,
) -> EffectiveToken | None:
    env_token = os.environ.get("LUCIDA_TOKEN")
    if env_token and env_token.strip():
        return EffectiveToken(env_token, "env")
    keychain_token = read_keychain_token(server_url)
    if keychain_token:
        return EffectiveToken(keychain_token, "keychain")
    config_token = server_config(config, server_url).get("token")
    if isinstance(config_token, str) and config_token.strip():
        return EffectiveToken(config_token, "config")
    return None


def server_config(config: dict[str, Any] | None, server_url: str) -> dict[str, Any]:
    servers = (config or {}).get("servers")
    if not isinstance(servers, dict):
        return {}
    entry = servers.get(server_url)
    return entry if isinstance(entry, dict) else {}


def server_config_mut(config: dict[str, Any], server_url: str) -> dict[str, Any]:
    servers = config.setdefault("servers", {})
    if not isinstance(servers, dict):
        servers = {}
        config["servers"] = servers
    entry = servers.setdefault(server_url, {})
    if not isinstance(entry, dict):
        entry = {}
        servers[server_url] = entry
    return entry


def read_keychain_token(server_url: str) -> str | None:
    if platform.system() != "Darwin":
        return None
    try:
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                server_url,
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    token = result.stdout.strip()
    return token or None


class LucidaClient:
    """Workspace-first Python client for lucida-server."""

    def __init__(
        self,
        server: str | None = None,
        *,
        token: str | None = None,
        config_path: str | os.PathLike[str] | None = None,
        transport: Any | None = None,
        ws_connect: Any | None = None,
        timeout: float = 30.0,
    ):
        self.config_store = ConfigStore(config_path)
        self.config = self.config_store.load()
        self.server = resolve_server(server, config=self.config)
        self.effective_token = (
            EffectiveToken(token, "argument")
            if token is not None
            else resolve_token(self.server.url, config=self.config)
        )
        self.transport = transport or UrllibTransport()
        self.ws_connect = ws_connect
        self.timeout = timeout
        self.auth = AuthResource(self)
        self.workspaces = WorkspacesResource(self)
        self.server_api = ServerResource(self)

    @property
    def token(self) -> str | None:
        return self.effective_token.token if self.effective_token else None

    def status(self) -> dict[str, Any]:
        return self.server_api.status()

    def whoami(self) -> dict[str, Any]:
        return self.auth.whoami()

    def workspace(self, selector: str | None = None) -> "WorkspaceResource":
        return self.workspaces.resolve(selector)

    def _request_json(
        self,
        method: str,
        segments: list[str],
        *,
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        timeout: float | None = None,
    ) -> Any:
        response = self._request(method, segments, query=query, body=body, timeout=timeout)
        if response.status == 204:
            return None
        if 200 <= response.status < 300:
            try:
                return response.json()
            except json.JSONDecodeError as error:
                raise LucidaError(
                    "protocol",
                    f"{method} /{'/'.join(segments)} returned invalid JSON: {error}",
                    status=response.status,
                    body=response.text(),
                ) from error
        raise map_http_error(response)

    def _request_text(
        self,
        method: str,
        segments: list[str],
        *,
        timeout: float | None = None,
    ) -> HttpResponse:
        response = self._request(method, segments, timeout=timeout)
        if 200 <= response.status < 300:
            return response
        raise map_http_error(response)

    def _request(
        self,
        method: str,
        segments: list[str],
        *,
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        headers = {"Accept": "application/json"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return self.transport.request(
            method,
            build_url(self.server.url, segments, query),
            headers=headers,
            body=payload,
            timeout=self.timeout if timeout is None else timeout,
        )


class ServerResource:
    def __init__(self, client: LucidaClient):
        self._client = client

    def status(self) -> dict[str, Any]:
        checks = {
            "healthz": self._check_text(["healthz"]),
            "readyz": self._check_text(["readyz"]),
            "version": self._check_text(["version"]),
        }
        try:
            auth: dict[str, Any] = {
                "status": "authenticated",
                "principal": self._client.whoami(),
            }
        except LucidaError as error:
            if error.kind == "unauthenticated":
                auth = {"status": "unauthenticated"}
            else:
                auth = {"status": "unknown", "error": error.message}
        return {
            "server": {
                "url": self._client.server.url,
                "source": self._client.server.source,
            },
            "checks": checks,
            "auth": auth,
        }

    def _check_text(self, segments: list[str]) -> dict[str, Any]:
        try:
            response = self._client._request_text("GET", segments)
            return {
                "ok": True,
                "status": response.status,
                "body": response.text(),
            }
        except LucidaError as error:
            return {
                "ok": False,
                "status": error.status,
                "error": error.message,
            }


class AuthResource:
    def __init__(self, client: LucidaClient):
        self._client = client

    def whoami(self) -> dict[str, Any]:
        return self._client._request_json("GET", ["auth", "whoami"])


class WorkspacesResource:
    def __init__(self, client: LucidaClient):
        self._client = client

    def list(self, *, archived: bool = False) -> list[dict[str, Any]]:
        segments = ["api", "workspaces", "archived"] if archived else ["api", "workspaces"]
        return self._client._request_json("GET", segments)

    def create(self, name: str | None = None) -> "WorkspaceResource":
        record = self._client._request_json("POST", ["api", "workspaces"], body={"name": name})
        return WorkspaceResource(self._client, record)

    def get(self, workspace_id: str) -> "WorkspaceResource":
        record = self._client._request_json("GET", ["api", "workspaces", workspace_id])
        return WorkspaceResource(self._client, record)

    def open(self, workspace_id: str) -> "WorkspaceResource":
        record = self._client._request_json("POST", ["api", "workspaces", workspace_id])
        return WorkspaceResource(self._client, record)

    def resolve(
        self,
        selector: str | None = None,
        *,
        include_archived: bool = False,
    ) -> "WorkspaceResource":
        selector = selector or server_config(
            self._client.config,
            self._client.server.url,
        ).get("workspace")
        if not selector:
            raise LucidaError(
                "config",
                "no workspace selected; pass a workspace id/name or call workspaces.use(...)",
            )
        if looks_like_workspace_id(selector) and not include_archived:
            return self.get(selector)

        active = self.list(archived=False)
        archived = self.list(archived=True) if include_archived else []
        record = resolve_workspace_record(selector, active, archived)
        if record.get("archived_at"):
            return WorkspaceResource(self._client, record)
        return self.get(record["id"])

    def use(self, selector: str) -> "WorkspaceResource":
        workspace = self.resolve(selector)
        entry = server_config_mut(self._client.config, self._client.server.url)
        entry["workspace"] = workspace.id
        self._client.config_store.save(self._client.config)
        return workspace


class WorkspaceResource:
    def __init__(self, client: LucidaClient, record: dict[str, Any]):
        self._client = client
        self.record = record
        self.datasets = DatasetsResource(self)
        self.view = ViewResource(self)
        self.layer = LayerResource(self)
        self.channel = ChannelResource(self)
        self.saved_views = SavedViewsResource(self)
        self.debug = DebugResource(self)

    @property
    def id(self) -> str:
        return str(self.record["id"])

    @property
    def name(self) -> str:
        return str(self.record.get("name") or self.id)

    @property
    def web_url(self) -> str:
        return build_url(self._client.server.url, ["w", self.id])

    @property
    def ws_url(self) -> str:
        parsed = urlparse(self._client.server.url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        base = urlunparse((scheme, parsed.netloc, "", "", "", ""))
        return build_url(base, ["ws", "workspaces", self.id])

    def refresh(self) -> "WorkspaceResource":
        self.record = self._client._request_json("GET", ["api", "workspaces", self.id])
        return self

    def open(self) -> "WorkspaceResource":
        self.record = self._client._request_json("POST", ["api", "workspaces", self.id])
        return self

    def snapshot(self, *, timeout: float = 30.0) -> dict[str, Any]:
        return run_sync(self.async_snapshot(timeout=timeout))

    async def async_snapshot(self, *, timeout: float = 30.0) -> dict[str, Any]:
        async with self._connect_ws() as ws:
            return await recv_snapshot(ws, timeout)

    def _connect_ws(self) -> Any:
        headers = {}
        if self._client.token:
            headers["Authorization"] = f"Bearer {self._client.token}"
        if self._client.ws_connect is not None:
            return self._client.ws_connect(self.ws_url, headers)
        return default_ws_connect(self.ws_url, headers)


class DatasetsResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        snapshot = self._workspace.snapshot(timeout=timeout)
        return dataset_summaries_from_document(snapshot.get("document", {}))

    def info(self, dataset: str, *, timeout: float = 30.0) -> dict[str, Any]:
        snapshot = self._workspace.snapshot(timeout=timeout)
        return dataset_info_from_document(snapshot.get("document", {}), dataset)

    def open(self, source: str, *, timeout: float = 300.0) -> dict[str, Any]:
        return run_sync(self.async_open(source, timeout=timeout))

    async def async_open(self, source: str, *, timeout: float = 300.0) -> dict[str, Any]:
        async with self._workspace._connect_ws() as ws:
            snapshot = await recv_snapshot(ws, timeout)
            request_id = f"py-{uuid.uuid4().hex}"
            await send_json(
                ws,
                {
                    "type": "open_remote_dataset",
                    "request_id": request_id,
                    "url": source,
                },
            )
            deadline = asyncio.get_running_loop().time() + timeout
            progress: list[dict[str, Any]] = []
            while True:
                remaining = max(0.0, deadline - asyncio.get_running_loop().time())
                if remaining == 0.0:
                    raise LucidaError(
                        "rejected_command",
                        f"timed out waiting for dataset open after {timeout:g}s",
                    )
                message = await recv_json(ws, remaining)
                message_type = message.get("type")
                if message_type == "dataset_open_progress":
                    if message.get("request_id") != request_id:
                        continue
                    diagnostic = message.get("diagnostic")
                    if isinstance(diagnostic, dict):
                        progress.append(diagnostic)
                    continue
                if message_type == "open_dataset_failed":
                    if message.get("request_id") != request_id:
                        continue
                    diagnostic = message.get("diagnostic")
                    raise LucidaError(
                        dataset_open_error_kind(diagnostic),
                        f"dataset open failed for {message.get('url')!r}: {message.get('error')}",
                        diagnostic=diagnostic if isinstance(diagnostic, dict) else None,
                    )
                if message_type != "open_dataset_succeeded":
                    continue
                if message.get("request_id") != request_id:
                    continue
                opened = message.get("opened") or {}
                manifest = opened.get("manifest") or {}
                return dataset_open_summary(
                    manifest,
                    source=str(message.get("url") or source),
                    seq=message.get("seq", snapshot.get("seq", 0)),
                    workspace_id=self._workspace.id,
                    diagnostic=message.get("diagnostic"),
                    progress=progress,
                )

    def health(
        self, dataset: str | None = None, *, timeout: float = 30.0
    ) -> list[dict[str, Any]]:
        return run_sync(self.async_health(dataset, timeout=timeout))

    async def async_health(
        self, dataset: str | None = None, *, timeout: float = 30.0
    ) -> list[dict[str, Any]]:
        async with self._workspace._connect_ws() as ws:
            snapshot = await recv_snapshot(ws, timeout)
            dataset_id = None
            if dataset is not None:
                summaries = dataset_summaries_from_document(snapshot.get("document", {}))
                dataset_id = resolve_dataset_id(dataset, summaries)
            request_id = f"py-health-{uuid.uuid4().hex}"
            await send_json(
                ws,
                {
                    "type": "dataset_health",
                    "request_id": request_id,
                    "dataset_id": dataset_id,
                },
            )
            deadline = asyncio.get_running_loop().time() + timeout
            progress: list[dict[str, Any]] = []
            while True:
                remaining = max(0.0, deadline - asyncio.get_running_loop().time())
                if remaining == 0.0:
                    raise LucidaError(
                        "rejected_command",
                        f"timed out waiting for dataset health after {timeout:g}s",
                    )
                message = await recv_json(ws, remaining)
                if (
                    message.get("type") == "dataset_health"
                    and message.get("request_id") == request_id
                ):
                    datasets = message.get("datasets")
                    return datasets if isinstance(datasets, list) else []

    def retry(self, dataset: str, *, timeout: float = 300.0) -> dict[str, Any]:
        return run_sync(self.async_retry(dataset, timeout=timeout))

    async def async_retry(self, dataset: str, *, timeout: float = 300.0) -> dict[str, Any]:
        async with self._workspace._connect_ws() as ws:
            snapshot = await recv_snapshot(ws, timeout)
            summaries = dataset_summaries_from_document(snapshot.get("document", {}))
            dataset_id = resolve_dataset_id(dataset, summaries)
            request_id = f"py-retry-{uuid.uuid4().hex}"
            await send_json(
                ws,
                {
                    "type": "dataset_retry",
                    "request_id": request_id,
                    "dataset_id": dataset_id,
                },
            )
            deadline = asyncio.get_running_loop().time() + timeout
            progress: list[dict[str, Any]] = []
            while True:
                remaining = max(0.0, deadline - asyncio.get_running_loop().time())
                if remaining == 0.0:
                    raise LucidaError(
                        "rejected_command",
                        f"timed out waiting for dataset retry after {timeout:g}s",
                    )
                message = await recv_json(ws, remaining)
                message_type = message.get("type")
                if message_type == "dataset_open_progress":
                    if message.get("request_id") != request_id:
                        continue
                    diagnostic = message.get("diagnostic")
                    if isinstance(diagnostic, dict):
                        progress.append(diagnostic)
                    continue
                if message_type == "open_dataset_failed":
                    if message.get("request_id") != request_id:
                        continue
                    diagnostic = message.get("diagnostic")
                    raise LucidaError(
                        dataset_open_error_kind(diagnostic),
                        f"dataset retry failed for {message.get('url')!r}: {message.get('error')}",
                        diagnostic=diagnostic if isinstance(diagnostic, dict) else None,
                    )
                if message_type != "open_dataset_succeeded":
                    continue
                if message.get("request_id") != request_id:
                    continue
                opened = message.get("opened") or {}
                manifest = opened.get("manifest") or {}
                return dataset_open_summary(
                    manifest,
                    source=str(message.get("url") or dataset),
                    seq=message.get("seq", snapshot.get("seq", 0)),
                    workspace_id=self._workspace.id,
                    diagnostic=message.get("diagnostic"),
                    progress=progress,
                )


class ViewResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def pan(self, dx: float, dy: float, *, timeout: float = 30.0) -> dict[str, Any]:
        def mutate(presence: dict[str, Any]) -> None:
            camera = ensure_slice_camera(presence["camera"])
            zoom = float(camera.get("zoom") or 1.0)
            camera["center"][0] += dx / zoom
            camera["center"][1] += dy / zoom

        return self._apply(mutate, timeout=timeout)

    def zoom(self, factor: float, *, timeout: float = 30.0) -> dict[str, Any]:
        if factor <= 0:
            raise LucidaError("config", "view.zoom factor must be positive")

        def mutate(presence: dict[str, Any]) -> None:
            camera = ensure_slice_camera(presence["camera"])
            camera["zoom"] = float(camera.get("zoom") or 1.0) * factor

        return self._apply(mutate, timeout=timeout)

    def set_zoom(self, value: float, *, timeout: float = 30.0) -> dict[str, Any]:
        if value <= 0:
            raise LucidaError("config", "view.set_zoom value must be positive")

        def mutate(presence: dict[str, Any]) -> None:
            ensure_slice_camera(presence["camera"])["zoom"] = value

        return self._apply(mutate, timeout=timeout)

    def center(self, x: float, y: float, *, timeout: float = 30.0) -> dict[str, Any]:
        def mutate(presence: dict[str, Any]) -> None:
            ensure_slice_camera(presence["camera"])["center"] = [x, y]

        return self._apply(mutate, timeout=timeout)

    def slice(self, axis: str, index: int, *, timeout: float = 30.0) -> dict[str, Any]:
        axis = axis.lower()
        if axis not in {"z", "t", "c"}:
            raise LucidaError("config", f"unknown slice axis: {axis}")

        def mutate(presence: dict[str, Any]) -> None:
            view = presence["view"]
            if axis == "z":
                set_z_range(view, index, index + 1)
            else:
                view[axis] = index

        return self._apply(mutate, timeout=timeout)

    def z_range(self, start: int, end: int, *, timeout: float = 30.0) -> dict[str, Any]:
        if end <= start:
            raise LucidaError("config", "view.z_range end must be greater than start")

        def mutate(presence: dict[str, Any]) -> None:
            set_z_range(presence["view"], start, end)

        return self._apply(mutate, timeout=timeout)

    def viewport_size(self, width: int, height: int, *, timeout: float = 30.0) -> dict[str, Any]:
        if width <= 0 or height <= 0:
            raise LucidaError("config", "viewport dimensions must be positive")

        def mutate(presence: dict[str, Any]) -> None:
            presence["camera"]["viewport"] = [width, height]

        return self._apply(mutate, timeout=timeout)

    def _apply(self, mutator: Any, *, timeout: float) -> dict[str, Any]:
        return run_sync(self.async_apply(mutator, timeout=timeout))

    async def async_apply(self, mutator: Any, *, timeout: float = 30.0) -> dict[str, Any]:
        async with self._workspace._connect_ws() as ws:
            snapshot = await recv_snapshot(ws, timeout)
            presence = copy.deepcopy(own_presence(snapshot))
            messages = break_follow_messages(presence)
            mutator(presence)
            messages.append(
                {
                    "type": "presence",
                    "camera": presence["camera"],
                    "view": presence["view"],
                    "display": presence["display"],
                }
            )
            for message in messages:
                await send_json(ws, message)
            return {
                "snapshot_seq": snapshot.get("seq", 0),
                "own_client_id": snapshot.get("your_id"),
                "camera": presence["camera"],
                "view": presence["view"],
                "display": presence["display"],
            }


class LayerResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        snapshot = self._workspace.snapshot(timeout=timeout)
        presence = own_presence(snapshot)
        summaries = dataset_summaries_from_document(snapshot.get("document", {}))
        settings = presence.get("dataset_settings") or {}
        order = presence.get("dataset_order") or [item["workspace_dataset_id"] for item in summaries]
        return [
            {
                **summary,
                "settings": settings.get(summary["workspace_dataset_id"], default_dataset_settings()),
                "order_index": order.index(summary["workspace_dataset_id"])
                if summary["workspace_dataset_id"] in order
                else None,
            }
            for summary in summaries
        ]

    def order(self, datasets: list[str], *, timeout: float = 30.0) -> dict[str, Any]:
        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            summaries = dataset_summaries_from_document(snapshot.get("document", {}))
            presence["dataset_order"] = [resolve_dataset_id(item, summaries) for item in datasets]

        return self._apply(mutate, timeout=timeout)

    def visible(self, dataset: str, visible: bool, *, timeout: float = 30.0) -> dict[str, Any]:
        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            settings = ensure_dataset_settings(snapshot, presence, dataset)
            settings["visible"] = visible

        return self._apply(mutate, timeout=timeout)

    def opacity(self, dataset: str, opacity: float, *, timeout: float = 30.0) -> dict[str, Any]:
        if opacity < 0 or opacity > 1:
            raise LucidaError("config", "layer.opacity must be between 0 and 1")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            settings = ensure_dataset_settings(snapshot, presence, dataset)
            settings["opacity"] = opacity

        return self._apply(mutate, timeout=timeout)

    def contrast(
        self,
        dataset: str,
        min: float,
        max: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        if max <= min:
            raise LucidaError("config", "layer.contrast max must be greater than min")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            settings = ensure_dataset_settings(snapshot, presence, dataset)
            settings["contrast_min"] = min
            settings["contrast_max"] = max

        return self._apply(mutate, timeout=timeout)

    def gamma(self, dataset: str, gamma: float, *, timeout: float = 30.0) -> dict[str, Any]:
        if gamma <= 0:
            raise LucidaError("config", "layer.gamma must be positive")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            ensure_dataset_settings(snapshot, presence, dataset)["gamma"] = gamma

        return self._apply(mutate, timeout=timeout)

    def _apply(self, mutator: Any, *, timeout: float) -> dict[str, Any]:
        return run_sync(self.async_apply(mutator, timeout=timeout))

    async def async_apply(self, mutator: Any, *, timeout: float = 30.0) -> dict[str, Any]:
        async with self._workspace._connect_ws() as ws:
            snapshot = await recv_snapshot(ws, timeout)
            presence = copy.deepcopy(own_presence(snapshot))
            mutator(snapshot, presence)
            message = {
                "type": "dataset_presence",
                "dataset_order": presence.get("dataset_order") or [],
                "dataset_settings": presence.get("dataset_settings") or {},
            }
            await send_json(ws, message)
            return {
                "snapshot_seq": snapshot.get("seq", 0),
                "own_client_id": snapshot.get("your_id"),
                "dataset_order": message["dataset_order"],
                "dataset_settings": message["dataset_settings"],
            }


class ChannelResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def mode(self, mode: str, *, timeout: float = 30.0) -> dict[str, Any]:
        mode = mode.lower()
        if mode not in {"single", "multi"}:
            raise LucidaError("config", "channel.mode must be 'single' or 'multi'")

        def mutate(presence: dict[str, Any]) -> None:
            presence["view"]["multi_channel"] = mode == "multi"

        return self._workspace.view._apply(mutate, timeout=timeout)

    def visible(
        self,
        dataset: str,
        channel: int,
        visible: bool,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            ensure_channel_settings(snapshot, presence, dataset, channel)["visible"] = visible

        return self._workspace.layer._apply(mutate, timeout=timeout)

    def colormap(
        self,
        dataset: str,
        channel: int,
        colormap: str,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            ensure_channel_settings(snapshot, presence, dataset, channel)["colormap"] = colormap

        return self._workspace.layer._apply(mutate, timeout=timeout)

    def contrast(
        self,
        dataset: str,
        channel: int,
        min: float,
        max: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        if max <= min:
            raise LucidaError("config", "channel.contrast max must be greater than min")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            settings = ensure_channel_settings(snapshot, presence, dataset, channel)
            settings["contrast_min"] = min
            settings["contrast_max"] = max

        return self._workspace.layer._apply(mutate, timeout=timeout)

    def gamma(
        self,
        dataset: str,
        channel: int,
        gamma: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        if gamma <= 0:
            raise LucidaError("config", "channel.gamma must be positive")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            ensure_channel_settings(snapshot, presence, dataset, channel)["gamma"] = gamma

        return self._workspace.layer._apply(mutate, timeout=timeout)


class DebugResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def state(self, *, timeout: float = 30.0) -> dict[str, Any]:
        snapshot = self._workspace.snapshot(timeout=timeout)
        return {
            "workspace": self._workspace.record,
            "snapshot_seq": snapshot.get("seq", 0),
            "own_client_id": snapshot.get("your_id"),
            "datasets": dataset_summaries_from_document(snapshot.get("document", {})),
            "peers": snapshot.get("peers", []),
            "generated_availability": snapshot.get("generated_availability", {}),
            "document": snapshot.get("document", {}),
        }


class SavedViewsResource:
    """Workspace saved views, including the #699/#702 sharing layer.

    Thin HTTP wrappers over the already-shipped, already-tested REST endpoints;
    the server owns every permission and never-leak invariant. ``visibility`` is
    one of ``"shared"`` | ``"personal"`` | ``"proposed"`` and is present on every
    returned record. ``create`` defaults to ``"shared"`` so existing callers are
    unaffected.
    """

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    @property
    def _client(self) -> LucidaClient:
        return self._workspace._client

    def _segments(self, *suffix: str) -> list[str]:
        return ["api", "workspaces", self._workspace.id, "saved-views", *suffix]

    def list(self) -> list[dict[str, Any]]:
        return self._client._request_json("GET", self._segments())

    def get(self, saved_view_id: str) -> dict[str, Any]:
        return self._client._request_json("GET", self._segments(saved_view_id))

    def create(
        self,
        name: str,
        view: dict[str, Any],
        visibility: str = "shared",
    ) -> dict[str, Any]:
        return self._client._request_json(
            "POST",
            self._segments(),
            body={"name": name, "view": view, "visibility": visibility},
        )

    def set_visibility(self, saved_view_id: str, visibility: str) -> dict[str, Any]:
        return self._client._request_json(
            "PATCH",
            self._segments(saved_view_id, "visibility"),
            body={"visibility": visibility},
        )

    def approve(self, saved_view_id: str) -> dict[str, Any]:
        return self._client._request_json(
            "POST",
            self._segments(saved_view_id, "approve"),
        )

    def reject(self, saved_view_id: str) -> dict[str, Any]:
        return self._client._request_json(
            "POST",
            self._segments(saved_view_id, "reject"),
        )


def build_url(
    base_url: str,
    segments: list[str],
    query: dict[str, Any] | None = None,
) -> str:
    parsed = urlparse(base_url)
    path = "/" + "/".join(quote(str(segment), safe="") for segment in segments)
    encoded_query = ""
    if query:
        clean_query = {
            key: value
            for key, value in query.items()
            if value is not None
        }
        encoded_query = urlencode(clean_query)
    return urlunparse((parsed.scheme, parsed.netloc, path, "", encoded_query, ""))


def map_http_error(response: HttpResponse) -> LucidaError:
    message = error_detail(response.text())
    if response.status == 401:
        return LucidaError(
            "unauthenticated",
            "not authenticated; run `lucida auth login`",
            status=response.status,
            body=response.text(),
        )
    if response.status == 403:
        return LucidaError(
            "unauthorized",
            message or "request was forbidden",
            status=response.status,
            body=response.text(),
        )
    if response.status == 404:
        return LucidaError(
            "missing_resource",
            message or "resource was not found",
            status=response.status,
            body=response.text(),
        )
    if response.status in {409, 410}:
        return LucidaError(
            "archived_workspace",
            message or "workspace is archived",
            status=response.status,
            body=response.text(),
        )
    if response.status == 400:
        return LucidaError(
            "config",
            message or "request was invalid",
            status=response.status,
            body=response.text(),
        )
    return LucidaError(
        "protocol",
        message or f"unexpected response: HTTP {response.status}",
        status=response.status,
        body=response.text(),
    )


def error_detail(body: str) -> str | None:
    text = body.strip()
    if not text:
        return None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(value, dict):
        detail = value.get("detail") or value.get("error")
        if isinstance(detail, str) and detail.strip():
            return detail
    return text


def looks_like_workspace_id(selector: str) -> bool:
    parts = selector.split("-")
    is_uuidish = (
        len(parts) == 5
        and [len(part) for part in parts] == [8, 4, 4, 4, 12]
    )
    is_opaque_id = len(selector) >= 24 and not any(char.isspace() for char in selector)
    return is_uuidish or is_opaque_id


def resolve_workspace_record(
    selector: str,
    active: list[dict[str, Any]],
    archived: list[dict[str, Any]],
) -> dict[str, Any]:
    candidates = [*active, *archived]
    for workspace in candidates:
        if workspace.get("id") == selector:
            return workspace
    matches = [workspace for workspace in candidates if workspace.get("name") == selector]
    if not matches:
        raise LucidaError("missing_resource", f"no workspace named or identified by {selector!r}")
    if len(matches) > 1:
        ids = ", ".join(str(workspace.get("id")) for workspace in matches)
        raise LucidaError("ambiguous_name", f"workspace name {selector!r} is ambiguous: {ids}")
    return matches[0]


def dataset_summaries_from_document(document: dict[str, Any]) -> list[dict[str, Any]]:
    manifests = document.get("manifests") or {}
    return [
        dataset_summary(document, manifest)
        for manifest in manifests.values()
    ]


def dataset_summary(document: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    images = manifest.get("images") or []
    entities = manifest.get("entities") or []
    first_level = None
    if images:
        levels = ((images[0].get("multiscale") or {}).get("levels") or [])
        first_level = levels[0] if levels else None
    dataset_id = str(manifest.get("dataset_id") or "")
    return {
        "workspace_dataset_id": dataset_id,
        "name": manifest.get("name") or dataset_id,
        "kind": str(manifest.get("kind") or "").lower(),
        "image_count": len(images),
        "entity_count": len(entities),
        "channel_count": (first_level.get("shape") or [None, None])[1]
        if first_level
        else None,
        "dimensions": first_level.get("shape") if first_level else None,
        "active_layout_id": active_layout_id(document, manifest),
    }


def dataset_info_from_document(document: dict[str, Any], selector: str) -> dict[str, Any]:
    summaries = dataset_summaries_from_document(document)
    summary = resolve_dataset_id_or_name(selector, summaries)
    manifest = (document.get("manifests") or {}).get(summary["workspace_dataset_id"])
    if not manifest:
        raise LucidaError("missing_resource", "dataset was not found")
    images = []
    for image in manifest.get("images") or []:
        levels = ((image.get("multiscale") or {}).get("levels") or [])
        first_level = levels[0] if levels else None
        images.append(
            {
                "image_id": image.get("image_id"),
                "owner": image.get("owner"),
                "data_type": (image.get("multiscale") or {}).get("data_type"),
                "level_count": len(levels),
                "level_indices": [level.get("level_index") for level in levels],
                "dimensions": first_level.get("shape") if first_level else None,
                "channel_count": (first_level.get("shape") or [None, None])[1]
                if first_level
                else None,
            }
        )
    dataset_id = summary["workspace_dataset_id"]
    return {
        **summary,
        "default_layout_id": manifest.get("default_layout_id"),
        "source_layout_count": len(manifest.get("source_layouts") or []),
        "registered_layout_count": len(
            (document.get("registered_layouts") or {}).get(dataset_id) or []
        ),
        "images": images,
    }


def active_layout_id(document: dict[str, Any], manifest: dict[str, Any]) -> str | None:
    dataset_id = manifest.get("dataset_id")
    active = (document.get("active_layout_ids") or {}).get(dataset_id)
    if active:
        return active
    if manifest.get("default_layout_id"):
        return manifest["default_layout_id"]
    source_layouts = manifest.get("source_layouts") or []
    if source_layouts:
        return source_layouts[0].get("id")
    return None


def resolve_dataset_id_or_name(selector: str, summaries: list[dict[str, Any]]) -> dict[str, Any]:
    for summary in summaries:
        if summary["workspace_dataset_id"] == selector:
            return summary
    matches = [summary for summary in summaries if summary.get("name") == selector]
    if not matches:
        raise LucidaError("missing_resource", f"no dataset named or identified by {selector!r}")
    if len(matches) > 1:
        ids = ", ".join(summary["workspace_dataset_id"] for summary in matches)
        raise LucidaError("ambiguous_name", f"dataset name {selector!r} is ambiguous: {ids}")
    return matches[0]


def resolve_dataset_id(selector: str, summaries: list[dict[str, Any]]) -> str:
    return resolve_dataset_id_or_name(selector, summaries)["workspace_dataset_id"]


def dataset_open_summary(
    manifest: dict[str, Any],
    *,
    source: str,
    seq: int,
    workspace_id: str,
    diagnostic: Any = None,
    progress: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    images = manifest.get("images") or []
    entities = manifest.get("entities") or []
    result = {
        "workspace_id": workspace_id,
        "workspace_dataset_id": manifest.get("dataset_id"),
        "name": manifest.get("name"),
        "image_count": len(images),
        "entity_count": len(entities),
        "seq": seq,
        "source": source,
    }
    if isinstance(diagnostic, dict):
        result["diagnostic"] = diagnostic
    if progress:
        result["progress"] = progress
    return result


def dataset_open_error_kind(diagnostic: Any) -> str:
    if not isinstance(diagnostic, dict):
        return "dataset_open_failure"
    kind = diagnostic.get("kind")
    if kind == "authorization":
        return "unauthorized"
    if kind == "session_closed":
        return "session_disconnect"
    if kind in {"local_path", "missing_object", "missing_metadata"}:
        return "missing_resource"
    if kind in {"cloud_configuration", "unsupported_scheme"}:
        return "config"
    return "dataset_open_failure"


def own_presence(snapshot: dict[str, Any]) -> dict[str, Any]:
    own_id = snapshot.get("your_id")
    for peer in snapshot.get("peers") or []:
        if peer.get("client_id") == own_id:
            return peer
    raise LucidaError("protocol", "workspace snapshot did not include this client presence")


def break_follow_messages(presence: dict[str, Any]) -> list[dict[str, Any]]:
    if presence.get("following") is None:
        return []
    presence["following"] = None
    return [{"type": "follow", "target": None}]


def ensure_slice_camera(camera: dict[str, Any]) -> dict[str, Any]:
    if camera.get("mode") != "slice":
        raise LucidaError("config", "operation requires slice camera mode")
    camera.setdefault("center", [0.0, 0.0])
    camera.setdefault("zoom", 1.0)
    camera.setdefault("viewport", [800, 600])
    return camera


def set_z_range(view: dict[str, Any], start: int, end: int) -> None:
    existing = view.get("z_range")
    if isinstance(existing, list):
        view["z_range"] = [start, end]
    else:
        view["z_range"] = {"start": start, "end": end}


def default_dataset_settings(channel_count: int = 0) -> dict[str, Any]:
    return {
        "visible": True,
        "opacity": 1.0,
        "contrast_min": 0.0,
        "contrast_max": 65535.0,
        "gamma": 1.0,
        "blend_mode": "alpha",
        "render_mode": "translucent",
        "channel_settings": [
            default_channel_settings(index)
            for index in range(channel_count)
        ],
        "channel_blend_mode": "additive",
        "detail_level_override": None,
    }


def default_channel_settings(index: int = 0) -> dict[str, Any]:
    colormaps = ["magenta", "green", "cyan"]
    return {
        "visible": True,
        "colormap": colormaps[index % len(colormaps)],
        "contrast_min": 0.0,
        "contrast_max": 65535.0,
        "gamma": 1.0,
    }


def ensure_dataset_settings(
    snapshot: dict[str, Any],
    presence: dict[str, Any],
    dataset: str,
) -> dict[str, Any]:
    summaries = dataset_summaries_from_document(snapshot.get("document", {}))
    summary = resolve_dataset_id_or_name(dataset, summaries)
    dataset_id = summary["workspace_dataset_id"]
    settings_by_dataset = presence.setdefault("dataset_settings", {})
    if dataset_id not in settings_by_dataset:
        settings_by_dataset[dataset_id] = default_dataset_settings(
            int(summary.get("channel_count") or 0)
        )
    if not presence.get("dataset_order"):
        presence["dataset_order"] = [item["workspace_dataset_id"] for item in summaries]
    return settings_by_dataset[dataset_id]


def ensure_channel_settings(
    snapshot: dict[str, Any],
    presence: dict[str, Any],
    dataset: str,
    channel: int,
) -> dict[str, Any]:
    if channel < 0:
        raise LucidaError("config", "channel index must be non-negative")
    dataset_settings = ensure_dataset_settings(snapshot, presence, dataset)
    channels = dataset_settings.setdefault("channel_settings", [])
    while len(channels) <= channel:
        channels.append(default_channel_settings(len(channels)))
    return channels[channel]


async def recv_snapshot(ws: Any, timeout: float) -> dict[str, Any]:
    while True:
        message = await recv_json(ws, timeout)
        message_type = message.get("type")
        if message_type == "snapshot":
            return message
        if message_type == "workspace_archived":
            raise LucidaError("archived_workspace", "workspace is archived")


async def recv_json(ws: Any, timeout: float) -> dict[str, Any]:
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    if isinstance(raw, bytes):
        raise LucidaError("protocol", "unexpected binary WebSocket message")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise LucidaError("protocol", f"invalid workspace server message: {error}") from error


async def send_json(ws: Any, message: dict[str, Any]) -> None:
    await ws.send(json.dumps(message, separators=(",", ":")))


def default_ws_connect(url: str, headers: dict[str, str]) -> Any:
    try:
        import websockets
    except ImportError as error:
        raise LucidaError(
            "config",
            "websockets is required for workspace session operations; in a source checkout run from lucida-py with `uv run python ...` or install dependencies with `uv sync`",
        ) from error

    kwargs: dict[str, Any] = {"max_size": None}
    if headers:
        kwargs["additional_headers"] = headers
    try:
        return websockets.connect(url, **kwargs)
    except TypeError:
        if headers:
            kwargs.pop("additional_headers", None)
            kwargs["extra_headers"] = headers
        return websockets.connect(url, **kwargs)


def run_sync(coro: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    raise LucidaError("config", "use the async_* method inside a running event loop")


__all__ = [
    "AuthResource",
    "ConfigStore",
    "DatasetsResource",
    "DebugResource",
    "EffectiveServer",
    "EffectiveToken",
    "HttpResponse",
    "LayerResource",
    "LucidaClient",
    "LucidaError",
    "SavedViewsResource",
    "ServerResource",
    "UrllibTransport",
    "ViewResource",
    "WorkspaceResource",
    "WorkspacesResource",
    "normalize_server_base_url",
    "resolve_token",
]
