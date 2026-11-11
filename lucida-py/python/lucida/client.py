from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import shutil
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
# The CLI's default too, so both clients change one viewer unless told otherwise.
DEFAULT_VIEWER_PROFILE = "default"
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
    """One workspace. ``view``, ``camera``, ``layer`` and ``channel`` change
    the viewer profile ``viewer_profile`` names; see :class:`ViewerResource`."""

    def __init__(
        self,
        client: LucidaClient,
        record: dict[str, Any],
        *,
        viewer_profile: str = DEFAULT_VIEWER_PROFILE,
    ):
        self._client = client
        self.record = record
        self.viewer_profile = viewer_profile
        self.datasets = DatasetsResource(self)
        self.viewer = ViewerResource(self)
        self.view = ViewResource(self)
        self.camera = CameraResource(self)
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

    def _run_cli(self, args: list[str], *, timeout: float) -> dict[str, Any]:
        """Run the ``lucida`` CLI against this workspace and return its JSON.
        It reads this client's config file and token, so it reaches the
        server as this client does."""
        client = self._client
        env = dict(os.environ)
        env["LUCIDA_CONFIG_PATH"] = str(client.config_store.path)
        if client.token:
            env["LUCIDA_TOKEN"] = client.token
        argv = [
            *cli_command(),
            "--server",
            client.server.url,
            "--workspace",
            self.id,
            "--json",
            *args,
        ]
        try:
            completed = subprocess.run(
                argv, env=env, capture_output=True, text=True, timeout=timeout + 30
            )
        except subprocess.TimeoutExpired as error:
            raise LucidaError("session_disconnect", f"the lucida CLI ran past {timeout}s") from error
        if completed.returncode != 0:
            try:
                error = json.loads(completed.stderr)["error"]
                kind, message = error["kind"], error["message"]
            except (json.JSONDecodeError, KeyError, TypeError):
                kind, message = "unexpected", completed.stderr.strip() or "the lucida CLI failed"
            raise LucidaError(kind, message)
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise LucidaError("protocol", f"the lucida CLI printed invalid JSON: {error}") from error

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

    def explore(
        self,
        dataset: str,
        *,
        view: dict[str, Any] | None = None,
        viewport: tuple[int, int] = (960, 720),
        depth: int = 0,
        breadcrumb: list[str] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Plan a guided-exploration step from a view of ``dataset``.

        Reads the workspace document from a snapshot, then enumerates the
        sensible next moves (Home / rotate / zoom / step Z) as re-openable child
        views, returning a decoded ``ExplorationSidecar`` dict (``v``,
        ``current``, ``cells``).

        Pass ``view`` (a ``SavedView`` dict — e.g. a child cell's ``view`` from a
        previous call) to descend from an explicit view; omit it to start from
        the dataset's Home view (a 3D Arcball for a volume, a 2D Slice for a flat
        image, fitted to the whole dataset as the viewer fits it). ``depth`` and
        ``breadcrumb`` are stamped on the returned current node so a stateless
        caller can keep an honest trail across calls.

        Each cell carries a full ``view`` object, which you pass back as
        ``view=`` to descend, and a ``url`` that opens that view in the viewer.
        """
        extension = native_extension()

        document = self._workspace.snapshot(timeout=timeout).get("document", {})
        summary = dataset_info_from_document(document, dataset)
        ds_id = summary["workspace_dataset_id"]
        view_json = json.dumps(view) if view is not None else None
        result = json.loads(
            extension.explore(
                json.dumps(document),
                ds_id,
                viewport,
                view_json,
                depth,
                breadcrumb or [],
            )
        )
        for cell in result.get("cells") or []:
            payload = extension.encode_view_payload(json.dumps(cell["view"]))
            cell["url"] = f"{self._workspace.web_url}#view={payload}"
        return result

    def open(self, source: str, *, timeout: float = 300.0) -> dict[str, Any]:
        return run_sync(self.async_open(source, timeout=timeout))

    async def async_open(self, source: str, *, timeout: float = 300.0) -> dict[str, Any]:
        source = absolute_dataset_source(source)
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


class ViewerResource:
    """The workspace's durable viewer profile.

    The view, camera, layer and channel resources change this view rather than
    a connection's presence, which the server drops when the connection
    closes. The server keeps one profile per user and name, the same one the
    CLI's ``--viewer-profile`` names, and a page opened at :attr:`web_url`
    shows it. Every change goes through the compiled extension, which applies
    it with the viewer's own commands, clamps and defaults.
    """

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    @property
    def profile(self) -> str:
        return self._workspace.viewer_profile

    @property
    def web_url(self) -> str:
        """The page that opens this profile's view."""
        return build_url(
            self._workspace._client.server.url,
            ["w", self._workspace.id],
            {"viewer_profile": self.profile},
        )

    def state(self, *, timeout: float = 30.0) -> dict[str, Any]:
        return run_sync(self.async_state(timeout=timeout))

    async def async_state(self, *, timeout: float = 30.0) -> dict[str, Any]:
        snapshot = await self._workspace.async_snapshot(timeout=timeout)
        return self._state(snapshot)

    def apply(
        self, command: Any, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        return run_sync(self.async_apply(command, view=view, timeout=timeout))

    async def async_apply(
        self, command: Any, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        """Apply one viewport command to the profile and store the result.

        ``command`` is a command in the core's tagged form, such as
        ``{"type": "pan", "dx": 10.0, "dy": 0.0}``, or a function of the
        workspace snapshot and the stored view that returns one. With
        ``view``, it acts in the view at that place in the layout, counted
        from 0, which becomes the active view first, as a press there makes
        it; without, in the active view.
        """

        def change(scene: Any, snapshot: dict[str, Any]) -> Any:
            built = command
            if callable(built):
                built = built(snapshot, json.loads(scene.saved_view_json()))
            scene.apply(json.dumps(built), view)
            return built

        snapshot = await self._workspace.async_snapshot(timeout=timeout)
        return self._change(snapshot, change)

    def _apply_change(self, change: Any, *, timeout: float = 30.0) -> dict[str, Any]:
        """Change the profile through its compiled scene and store the result.

        ``change`` is a function of the scene and the workspace snapshot that
        changes the scene with its methods, such as ``lay_out`` or
        ``show_in``, and returns the command it applied, if one describes it.
        """
        snapshot = self._workspace.snapshot(timeout=timeout)
        return self._change(snapshot, change)

    def screenshot(
        self,
        output: str | os.PathLike[str],
        *,
        view: int | None = None,
        each_view: bool = False,
        width: int = 1200,
        height: int = 800,
        device_pixel_ratio: float = 1.0,
        scale_bar: bool = True,
        plane_lines: bool = False,
        timeout: float = 60.0,
    ) -> dict[str, Any]:
        """Capture this profile's view once every view has settled.

        Writes the viewer page to ``output``; with ``view``, that view alone;
        with ``each_view``, the canvas alone and each view beside it as
        ``<stem>-view-<N>.png``, all from one load. A view or the canvas
        alone leaves out four-up's plane lines unless ``plane_lines`` asks
        for them. Returns what the CLI's ``viewer screenshot --json``
        reports, whose ``captured`` lists each image written.

        The capture runs the ``lucida`` CLI, which drives a local Chrome, so
        both clients share one browser driver. It takes the CLI from
        ``LUCIDA_CLI``, else from ``PATH``.
        """
        args = ["screenshot", os.fspath(output)]
        if view is not None:
            args += ["--view", str(view)]
        if each_view:
            args.append("--each-view")
        args += [
            "--width",
            str(width),
            "--height",
            str(height),
            "--device-pixel-ratio",
            str(device_pixel_ratio),
            "--timeout-seconds",
            str(max(1, round(timeout))),
        ]
        if not scale_bar:
            args.append("--no-scale-bar")
        if plane_lines:
            args.append("--plane-lines")
        return self._workspace._run_cli(
            ["viewer", "--profile", self.profile, *args], timeout=timeout
        )

    def _state(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        record, view, seed_source = self._current()
        scene = open_profile_scene(snapshot, view)
        if seed_source is not None:
            record = self._store(scene, seed_source)
        return self._result(snapshot, record, scene, None)

    def _change(self, snapshot: dict[str, Any], change: Any) -> dict[str, Any]:
        _, view, seed_source = self._current()
        scene = open_profile_scene(snapshot, view)
        try:
            command = change(scene, snapshot)
        except LookupError as error:
            raise LucidaError("missing_resource", str(error)) from error
        except ValueError as error:
            raise LucidaError("config", str(error)) from error
        record = self._store(scene, seed_source)
        return self._result(snapshot, record, scene, command)

    def _current(self) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
        """The stored record and its view, or, for a profile not stored yet,
        the view it starts from and where that came from. A ``None`` view
        starts with the visible datasets framed."""
        record = self._workspace._client._request_json("GET", self._segments())
        if record is not None:
            return record, record["view"], None
        default_id = self._workspace.record.get("default_saved_view_id")
        if default_id:
            saved = self._workspace.saved_views.get(default_id)
            return None, saved["view"], f"default_saved_view:{default_id}"
        return None, None, "workspace_snapshot"

    def _store(self, scene: Any, seed_source: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {"view": json.loads(scene.saved_view_json())}
        if seed_source is not None:
            body["seed_source"] = seed_source
        return self._workspace._client._request_json("PUT", self._segments(), body=body)

    def _segments(self) -> list[str]:
        return ["api", "workspaces", self._workspace.id, "viewer-profiles", self.profile]

    def _result(
        self,
        snapshot: dict[str, Any],
        record: dict[str, Any],
        scene: Any,
        command: dict[str, Any] | None,
    ) -> dict[str, Any]:
        view = json.loads(scene.saved_view_json())
        links = scene.links_json()
        return {
            "workspace_id": self._workspace.id,
            "profile": record["profile"],
            "user_email": record["user_email"],
            "updated_at": record["updated_at"],
            "seed_source": record.get("seed_source"),
            "snapshot_seq": snapshot.get("seq", 0),
            "web_url": self.web_url,
            "command": command,
            "camera": view["camera"],
            "view": view["view"],
            "display": view["display"],
            "dataset_order": view["dataset_order"],
            "dataset_settings": view["dataset_settings"],
            "views": json.loads(scene.views_json()),
            "links": None if links is None else json.loads(links),
            "saved_view": view,
        }


class ViewResource:
    """The viewer profile's views: how the canvas divides among them, what
    each shows and how two link, and each one's 2D slice camera and selected
    Z and T.

    Views are counted from 0 in the layout's order, as ``viewer.state()``
    lists them under ``views``. A camera or position change acts in the view
    ``view=`` names, which becomes the active view first, or in the active
    view.
    """

    _LAYOUTS = {"single", "columns", "rows", "grid", "four_up"}

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def pan(
        self, dx: float, dy: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        """Pan the slice camera by ``dx``, ``dy`` screen pixels."""
        return self._apply({"type": "pan", "dx": dx, "dy": dy}, view, timeout)

    def zoom(
        self, factor: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply({"type": "zoom_by", "factor": factor}, view, timeout)

    def set_zoom(
        self, value: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply({"type": "set_zoom", "value": value}, view, timeout)

    def center(
        self, x: float, y: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply({"type": "set_center", "x": x, "y": y}, view, timeout)

    def slice(
        self, axis: str, index: int, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        axis = axis.lower()
        if axis == "c":
            raise LucidaError(
                "config", "channels are shown per layer; use channel.solo(dataset, channel)"
            )
        if axis not in {"z", "y", "x", "t"}:
            raise LucidaError("config", f"unknown slice axis: {axis}")
        return self._apply({"type": f"set_{axis}", axis: index}, view, timeout)

    def plane(
        self, plane: str, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        """Cut the slice view along ``"xy"``, ``"xz"`` or ``"yz"``. An xz view
        moves along Y, and a yz view along X."""
        return self._apply({"type": "set_slice_plane", "plane": plane.lower()}, view, timeout)

    def z_range(
        self, start: int, end: int, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply({"type": "set_z_range", "start": start, "end": end}, view, timeout)

    def viewport_size(self, width: int, height: int, *, timeout: float = 30.0) -> dict[str, Any]:
        return self._apply({"type": "set_viewport", "width": width, "height": height}, None, timeout)

    def layout(
        self,
        layout: str,
        datasets: list[str] | None = None,
        *,
        view: int | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Divide the canvas: ``"single"``, ``"columns"`` (1×2), ``"rows"``
        (2×1), ``"grid"`` (2×2) or ``"four_up"``.

        Each of ``datasets``, by id or unambiguous name, moves into the view
        at its place, as a layer dropped on a view moves there. Four-up shows
        the same datasets as an XY, a YZ and an XZ slice and a volume crossing
        at one point, so there each shows in all four. Two views of datasets
        over one region link by default; see :meth:`link`.
        """
        layout = layout.lower().replace("-", "_")
        if layout not in self._LAYOUTS:
            raise LucidaError("config", f"a layout is one of {sorted(self._LAYOUTS)}, not {layout}")

        def change(scene: Any, snapshot: dict[str, Any]) -> None:
            ids = [snapshot_dataset_id(snapshot, item) for item in datasets or []]
            scene.lay_out(layout, ids, view)

        return self._workspace.viewer._apply_change(change, timeout=timeout)

    def show(
        self,
        datasets: str | list[str],
        *,
        view: int,
        keep: bool = False,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Show ``datasets`` in ``view``: moved there and out of every other
        view, or with ``keep`` as well as wherever they show."""
        names = [datasets] if isinstance(datasets, str) else list(datasets)

        def change(scene: Any, snapshot: dict[str, Any]) -> None:
            ids = [snapshot_dataset_id(snapshot, item) for item in names]
            scene.show_in(view, ids, keep)

        return self._workspace.viewer._apply_change(change, timeout=timeout)

    def activate(self, view: int, *, timeout: float = 30.0) -> dict[str, Any]:
        """Make ``view`` the one later commands steer."""
        return self._workspace.viewer._apply_change(
            lambda scene, _snapshot: scene.apply(
                json.dumps({"type": "set_active_view", "view": scene.view_id(view)})
            ),
            timeout=timeout,
        )

    def maximize(self, view: int | None, *, timeout: float = 30.0) -> dict[str, Any]:
        """Show ``view`` alone across the canvas, or every view again with ``None``."""

        def change(scene: Any, _snapshot: dict[str, Any]) -> None:
            shown = None if view is None else scene.view_id(view)
            scene.apply(json.dumps({"type": "maximize_view", "view": shown}))

        return self._workspace.viewer._apply_change(change, timeout=timeout)

    def link(
        self, property: str, mode: str, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        """Link ``property`` (``"pan"``, ``"zoom"``, ``"orientation"``, ``"z"``,
        ``"t"``, ``"contrast"`` or ``"colormap"``) between the two views of a
        layout of two, ``"linked"``, ``"relative"`` or ``"off"``. A linked
        property takes the active view's value, or ``view``'s."""
        command = {"type": "set_view_link", "property": property, "mode": mode}
        return self._apply(command, view, timeout)

    def compare(
        self,
        a: str,
        b: str,
        *,
        swipe: float | None = None,
        blink: float | bool | None = None,
        view: int | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Compare two datasets that line up, by id or name, in ``view`` or
        the active view.

        Splits the view by a divider, ``a`` left of it (``swipe``, the
        default, at that fraction of the view's width), or shows them in turn
        (``blink``: ``True`` to wait to be flipped, or 1, 2 or 4 flips a
        second). Every other dataset the view shows is set aside while they
        compare. A capture of a blink shows ``a``.
        """
        if swipe is not None and blink not in (None, False):
            raise LucidaError("config", "a comparison is a swipe or a blink, not both")
        blinking = blink not in (None, False)

        def change(scene: Any, snapshot: dict[str, Any]) -> None:
            pair = [snapshot_dataset_id(snapshot, item) for item in (a, b)]
            mode = "blink" if blinking else "swipe"
            scene.apply(json.dumps({"type": "compare", "a": pair[0], "b": pair[1], "mode": mode}), view)
            if not blinking:
                at = 0.5 if swipe is None else swipe
                scene.apply(json.dumps({"type": "set_comparison_divider", "at": at}))
            elif blink is not True:
                scene.apply(json.dumps({"type": "set_blink_rate", "rate": blink}))

        return self._workspace.viewer._apply_change(change, timeout=timeout)

    def end_comparison(self, *, view: int | None = None, timeout: float = 30.0) -> dict[str, Any]:
        """Stop comparing in ``view`` or the active view."""
        return self._apply({"type": "end_comparison"}, view, timeout)

    def _apply(self, command: dict[str, Any], view: int | None, timeout: float) -> dict[str, Any]:
        return self._workspace.viewer.apply(command, view=view, timeout=timeout)


class CameraResource:
    """The viewer profile's camera mode and its 3D cameras.

    A rotate, pan or zoom here switches the camera to arcball, and a fly tick
    to fly, as the viewer's 3D controls do. The 2D slice camera moves through
    :class:`ViewResource`, which refuses to move a 3D camera. ``view=``
    names the view whose camera moves, which becomes the active view first.
    """

    _MODES = {"slice": "set_mode_slice", "arcball": "set_mode_arcball", "fly": "set_mode_fly"}

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def mode(self, mode: str, *, view: int | None = None, timeout: float = 30.0) -> dict[str, Any]:
        command = self._MODES.get(mode.lower())
        if command is None:
            raise LucidaError("config", "camera.mode must be 'slice', 'arcball' or 'fly'")
        return self._apply({"type": command}, timeout, view)

    def rotate(
        self, d_theta: float, d_phi: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        """Orbit the arcball camera by ``d_theta`` and ``d_phi`` radians."""
        command = {"type": "arcball_rotate", "d_theta": d_theta, "d_phi": d_phi}
        return self._apply(command, timeout, view)

    def pan(
        self, dx: float, dy: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply({"type": "arcball_pan", "dx": dx, "dy": dy}, timeout, view)

    def zoom(
        self, delta: float, *, view: int | None = None, timeout: float = 30.0
    ) -> dict[str, Any]:
        """Scale the arcball distance by ``1 + delta``, so a negative delta moves in."""
        return self._apply({"type": "arcball_zoom", "delta": delta}, timeout, view)

    def fly_tick(
        self,
        *,
        dt: float = 1.0 / 60.0,
        forward: float = 0.0,
        right: float = 0.0,
        up: float = 0.0,
        yaw: float = 0.0,
        pitch: float = 0.0,
        roll: float = 0.0,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return self._apply(
            {
                "type": "fly_tick",
                "dt": dt,
                "forward": forward,
                "right": right,
                "up": up,
                "yaw": yaw,
                "pitch": pitch,
                "roll": roll,
            },
            timeout,
        )

    def _apply(
        self, command: dict[str, Any], timeout: float, view: int | None = None
    ) -> dict[str, Any]:
        return self._workspace.viewer.apply(command, view=view, timeout=timeout)


class LayerResource:
    """Per-dataset display settings in the viewer profile."""

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        """Each dataset with its display settings, in layer order.

        ``settings["detail_level_override"]`` is the dataset's level pin:
        ``None`` means the target level follows the screen, and a number pins
        it to that source level, 0 being the finest. ``level_pin`` says the
        same thing in words.
        """
        snapshot = self._workspace.snapshot(timeout=timeout)
        state = self._workspace.viewer._state(snapshot)
        summaries = {
            summary["workspace_dataset_id"]: summary
            for summary in dataset_summaries_from_document(snapshot.get("document", {}))
        }
        return [
            {
                **summaries[dataset_id],
                "settings": state["dataset_settings"][dataset_id],
                "level_pin": level_pin_label(state["dataset_settings"][dataset_id]),
                "order_index": index,
            }
            for index, dataset_id in enumerate(state["dataset_order"])
        ]

    def order(self, datasets: list[str], *, timeout: float = 30.0) -> dict[str, Any]:
        """Put ``datasets`` first, keeping the rest in their current order."""
        return self._workspace.viewer.apply(
            lambda snapshot, _view: {
                "type": "set_dataset_order",
                "order": [snapshot_dataset_id(snapshot, item) for item in datasets],
            },
            timeout=timeout,
        )

    def visible(self, dataset: str, visible: bool, *, timeout: float = 30.0) -> dict[str, Any]:
        return self._apply("set_dataset_visible", dataset, {"visible": visible}, timeout)

    def opacity(self, dataset: str, opacity: float, *, timeout: float = 30.0) -> dict[str, Any]:
        return self._apply("set_dataset_opacity", dataset, {"opacity": opacity}, timeout)

    def contrast(
        self,
        dataset: str,
        min: float,
        max: float,
        *,
        channel: int | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Set the contrast window of ``channel``, or of the channel the layer
        shows first, as the layer panel does. It also stops auto-contrast for
        the layer."""
        return self._apply(
            "set_channel_contrast", dataset, {"min": min, "max": max}, timeout, channel=channel
        )

    def gamma(
        self,
        dataset: str,
        gamma: float,
        *,
        channel: int | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Set the gamma of ``channel``, or of the channel the layer shows first."""
        return self._apply("set_channel_gamma", dataset, {"gamma": gamma}, timeout, channel=channel)

    def _apply(
        self,
        command_type: str,
        dataset: str,
        fields: dict[str, Any],
        timeout: float,
        *,
        channel: int | None = None,
    ) -> dict[str, Any]:
        def command(snapshot: dict[str, Any], view: dict[str, Any]) -> dict[str, Any]:
            built = {
                "type": command_type,
                "dataset_id": snapshot_dataset_id(snapshot, dataset),
                **fields,
            }
            if command_type.startswith("set_channel_"):
                built["channel"] = (
                    current_channel(snapshot, view, built["dataset_id"])
                    if channel is None
                    else channel
                )
            return built

        return self._workspace.viewer.apply(command, timeout=timeout)


class ChannelResource:
    """Per-channel display settings in the viewer profile."""

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def solo(
        self,
        dataset: str,
        channel: int | None = None,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Show one channel of a layer alone, or its composite with `channel=None`.

        Other layers keep what they show.
        """
        if channel is not None and channel < 0:
            raise LucidaError("config", "channel index must be non-negative")
        return self._workspace.viewer.apply(
            lambda snapshot, _view: {
                "type": "set_channel_solo",
                "dataset_id": snapshot_dataset_id(snapshot, dataset),
                "channel": channel,
            },
            timeout=timeout,
        )

    def visible(
        self, dataset: str, channel: int, visible: bool, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply("set_channel_visible", dataset, channel, {"visible": visible}, timeout)

    def colormap(
        self, dataset: str, channel: int, colormap: str, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply(
            "set_channel_colormap", dataset, channel, {"colormap": colormap}, timeout
        )

    def contrast(
        self,
        dataset: str,
        channel: int,
        min: float,
        max: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Set the channel's contrast window. It also stops auto-contrast for
        the layer, as setting it by hand in the viewer does."""
        return self._apply(
            "set_channel_contrast", dataset, channel, {"min": min, "max": max}, timeout
        )

    def gamma(
        self, dataset: str, channel: int, gamma: float, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return self._apply("set_channel_gamma", dataset, channel, {"gamma": gamma}, timeout)

    def _apply(
        self,
        command_type: str,
        dataset: str,
        channel: int,
        fields: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        return self._workspace.layer._apply(command_type, dataset, fields, timeout, channel=channel)


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
    """Workspace saved views, including the sharing layer.

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


def effective_multiscale(manifest: dict[str, Any], image: dict[str, Any]) -> dict[str, Any]:
    """The image's multiscale description, resolving the shared-once wire form.

    Collection manifests carry each multiscale shared by several images ONCE,
    in the manifest's top-level ``multiscales`` table, with sharing images
    holding a ``multiscale_ref`` index; images with a unique multiscale (and
    all payloads from before the compact encoding) inline it instead.
    """
    inline = image.get("multiscale")
    if isinstance(inline, dict):
        return inline
    ref = image.get("multiscale_ref")
    table = manifest.get("multiscales") or []
    if isinstance(ref, int) and 0 <= ref < len(table):
        shared = table[ref]
        if isinstance(shared, dict):
            return shared
    return {}


def dataset_summary(document: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    images = manifest.get("images") or []
    entities = manifest.get("entities") or []
    first_level = None
    if images:
        levels = effective_multiscale(manifest, images[0]).get("levels") or []
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
        multiscale = effective_multiscale(manifest, image)
        levels = multiscale.get("levels") or []
        first_level = levels[0] if levels else None
        images.append(
            {
                "image_id": image.get("image_id"),
                "owner": image.get("owner"),
                "data_type": multiscale.get("data_type"),
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


_URL_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]+://")
_DRIVE_LETTER = re.compile(r"[A-Za-z]:")


def absolute_dataset_source(source: str) -> str:
    """Resolve a relative path against this process's working directory.

    The server cannot know the client's working directory. A URL, an
    absolute path, a drive-letter or UNC path, or an empty string passes
    through unchanged for the server to judge, by the same rules as its
    location parser.
    """
    if (
        not source
        or _URL_SCHEME.match(source)
        or _DRIVE_LETTER.match(source)
        or source.startswith(("/", "\\\\"))
    ):
        return source
    return os.path.abspath(source)


def dataset_open_error_kind(diagnostic: Any) -> str:
    if not isinstance(diagnostic, dict):
        return "dataset_open_failure"
    kind = diagnostic.get("kind")
    if kind in {"authorization", "source_not_allowed"}:
        return "unauthorized"
    if kind == "session_closed":
        return "session_disconnect"
    if kind in {"local_path", "missing_object", "missing_metadata"}:
        return "missing_resource"
    if kind in {"cloud_configuration", "unsupported_scheme", "invalid_location"}:
        return "config"
    return "dataset_open_failure"


def level_pin_label(settings: dict[str, Any]) -> str:
    """How a dataset's level pin reads. An absent pin follows the screen."""
    level = settings.get("detail_level_override")
    if level is None:
        return "follows the screen"
    return f"pinned to level {level}"


def current_channel(snapshot: dict[str, Any], view: dict[str, Any], dataset_id: str) -> int:
    """The channel a change that names none acts on: the layer's solo, else
    the first channel its composite shows."""
    layers = json.loads(open_profile_scene(snapshot, view).resolved_layers())
    layer = next((layer for layer in layers if layer["dataset_id"] == dataset_id), None)
    return layer["channels"][0]["channel"] if layer else 0


def snapshot_dataset_id(snapshot: dict[str, Any], selector: str) -> str:
    summaries = dataset_summaries_from_document(snapshot.get("document", {}))
    return resolve_dataset_id(selector, summaries)


def cli_command() -> list[str]:
    """The ``lucida`` CLI: ``LUCIDA_CLI``, else the one on ``PATH``."""
    configured = os.environ.get("LUCIDA_CLI")
    if configured:
        return [configured]
    found = shutil.which("lucida")
    if found:
        return [found]
    raise LucidaError(
        "config",
        "screenshots run the lucida CLI, which drives a local Chrome; put `lucida` on PATH "
        "or name it in LUCIDA_CLI",
    )


def native_extension() -> Any:
    try:
        from lucida import lucida as extension  # noqa: PLC0415
    except ImportError as error:
        raise LucidaError(
            "config",
            "the compiled lucida extension is unavailable; build it with "
            "`uv run maturin develop` in lucida-py",
        ) from error
    return extension


def open_profile_scene(snapshot: dict[str, Any], view: dict[str, Any] | None) -> Any:
    """``view`` opened over the snapshot's document, or, when it is ``None``,
    the view a new viewer profile starts from."""
    document = json.dumps(snapshot.get("document") or {})
    try:
        return native_extension().ProfileScene(
            document, None if view is None else json.dumps(view)
        )
    except ValueError as error:
        raise LucidaError("protocol", str(error)) from error


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
    "CameraResource",
    "ChannelResource",
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
    "ViewerResource",
    "WorkspaceResource",
    "WorkspacesResource",
    "normalize_server_base_url",
    "resolve_token",
]
