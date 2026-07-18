from __future__ import annotations

import asyncio
import copy
import ipaddress
import json
import math
import os
import stat
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_SERVER = "http://localhost:9876"
MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024
MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024
SUPPORTED_COLORMAPS = frozenset(
    {
        "gray",
        "magenta",
        "green",
        "cyan",
        "red",
        "blue",
        "yellow",
        "viridis",
        "inferno",
        "plasma",
        "magma",
        "turbo",
        "hot",
        "cool",
        "jet",
    }
)

try:
    from lucida.lucida import read_keychain_token as _native_read_keychain_token
except (ImportError, ModuleNotFoundError):
    # Pure-Python source checkouts remain usable without the optional native
    # extension. Credential resolution then falls through to config; it never
    # shells out to a command that returns the token through stdout.
    _native_read_keychain_token = None

# Mirrors lucida_protocol::FailureCode exhaustively. This mapping is only from
# a typed server code to the Python client's broad operational error kind;
# display messages never participate.
DATASET_OPEN_CODE_TO_ERROR_KIND = {
    "authorization": "unauthorized",
    "session_closed": "session_disconnect",
    "workspace_lookup": "network",
    "unsupported_scheme": "config",
    "invalid_locator": "config",
    "local_path": "missing_resource",
    "missing_object": "missing_resource",
    "permission": "unauthorized",
    "cloud_configuration": "config",
    "http": "network",
    "storage_backend": "network",
    "unsupported_codec": "dataset_open_failure",
    "decode_failure": "dataset_open_failure",
    "unsupported_layout": "dataset_open_failure",
    "chunk_out_of_bounds": "dataset_open_failure",
    "resource_limit": "dataset_open_failure",
    "malformed_metadata": "dataset_open_failure",
    "missing_metadata": "missing_resource",
    "import": "dataset_open_failure",
    "unknown_dataset": "missing_resource",
    "unknown_image": "missing_resource",
    "missing_chunk_metadata": "dataset_open_failure",
    "invalid_chunk_key": "protocol",
    "protocol": "protocol",
    "persistence": "network",
    "internal": "unexpected",
}


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
        self.failure_category = (
            diagnostic.get("category") if isinstance(diagnostic, dict) else None
        )
        self.failure_code = (
            diagnostic.get("code", diagnostic.get("kind"))
            if isinstance(diagnostic, dict)
            else None
        )
        self.retryable = (
            diagnostic.get("retryable") if isinstance(diagnostic, dict) else None
        )

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


class _NoRedirectHandler(HTTPRedirectHandler):
    """Expose redirects to callers instead of replaying credentialed requests."""

    def redirect_request(
        self,
        request: Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> None:
        del request, file_pointer, code, message, headers, new_url
        return None


class UrllibTransport:
    """Small stdlib transport used so the server client stays dependency-light."""

    def __init__(self, *, max_response_bytes: int = MAX_HTTP_RESPONSE_BYTES):
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        self.max_response_bytes = max_response_bytes
        # urllib's default redirect handler forwards caller-supplied headers,
        # including Authorization, to a new origin. Redirects are therefore a
        # response for the product client to interpret, never an implicit
        # second credentialed request.
        self._opener = build_opener(_NoRedirectHandler())

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
            with self._opener.open(request, timeout=timeout) as response:
                return HttpResponse(
                    status=response.status,
                    body=self._read_bounded(response),
                    headers=dict(response.headers.items()),
                )
        except HTTPError as error:
            return HttpResponse(
                status=error.code,
                body=self._read_bounded(error),
                headers=dict(error.headers.items()),
            )
        except URLError as error:
            raise LucidaError("unreachable_server", str(error)) from error

    def _read_bounded(self, response: Any) -> bytes:
        raw_length = response.headers.get("Content-Length")
        if raw_length is not None:
            try:
                length = int(raw_length)
            except ValueError:
                length = None
            if length is not None and length > self.max_response_bytes:
                raise LucidaError(
                    "resource_limit",
                    f"HTTP response exceeds {self.max_response_bytes} bytes",
                )
        body = response.read(self.max_response_bytes + 1)
        if len(body) > self.max_response_bytes:
            raise LucidaError(
                "resource_limit",
                f"HTTP response exceeds {self.max_response_bytes} bytes",
            )
        return body


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
        payload = (json.dumps(config, indent=2, sort_keys=True) + "\n").encode("utf-8")
        temp_path = self.path.with_name(
            f".{self.path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        descriptor: int | None = None
        try:
            descriptor = os.open(
                temp_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                stat.S_IRUSR | stat.S_IWUSR,
            )
            with os.fdopen(descriptor, "wb") as file:
                descriptor = None
                file.write(payload)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, self.path)
            _sync_directory(self.path.parent)
        except OSError as error:
            raise LucidaError(
                "config",
                f"failed to atomically write private config {self.path}: {error}",
            ) from error
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def _sync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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


def token_transport_is_allowed(server_url: str) -> bool:
    parsed = urlparse(server_url)
    if parsed.scheme == "https":
        return True
    if parsed.scheme != "http" or parsed.hostname is None:
        return False
    if parsed.hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


def allow_insecure_token_transport() -> bool:
    return os.environ.get("LUCIDA_ALLOW_INSECURE_TOKEN", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


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
    reader = _native_read_keychain_token
    if reader is None:
        return None
    try:
        token = reader(server_url)
    except Exception:
        # Keychain denial/lock and native loading failures preserve the same
        # env > keychain > config precedence by falling through to config.
        return None
    if not isinstance(token, str):
        return None
    token = token.strip()
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
        max_ws_message_bytes: int = MAX_WEBSOCKET_MESSAGE_BYTES,
    ):
        self.config_store = ConfigStore(config_path)
        self.config = self.config_store.load()
        self.server = resolve_server(server, config=self.config)
        self.effective_token = (
            EffectiveToken(token, "argument")
            if token is not None
            else resolve_token(self.server.url, config=self.config)
        )
        if (
            self.effective_token is not None
            and not token_transport_is_allowed(self.server.url)
            and not allow_insecure_token_transport()
        ):
            raise LucidaError(
                "insecure_transport",
                "refusing to send a bearer token over non-loopback HTTP; use HTTPS or "
                "set LUCIDA_ALLOW_INSECURE_TOKEN=1 for an explicitly trusted test network",
            )
        self.transport = transport or UrllibTransport()
        self.ws_connect = ws_connect
        if max_ws_message_bytes <= 0:
            raise ValueError("max_ws_message_bytes must be positive")
        self.max_ws_message_bytes = max_ws_message_bytes
        self.timeout = timeout
        self.auth = AuthResource(self)
        self.workspaces = WorkspacesResource(self)
        self.server_api = ServerResource(self)

    @property
    def token(self) -> str | None:
        return self.effective_token.token if self.effective_token else None

    def status(self) -> dict[str, Any]:
        return self.server_api.status()

    async def async_status(self) -> dict[str, Any]:
        return await self.server_api.async_status()

    def whoami(self) -> dict[str, Any]:
        return self.auth.whoami()

    async def async_whoami(self) -> dict[str, Any]:
        return await self.auth.async_whoami()

    def workspace(self, selector: str | None = None) -> "WorkspaceResource":
        return self.workspaces.resolve(selector)

    async def async_workspace(self, selector: str | None = None) -> "WorkspaceResource":
        return await self.workspaces.async_resolve(selector)

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
            try:
                payload = json.dumps(body, allow_nan=False).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise LucidaError(
                    "config",
                    f"request body is not valid finite JSON: {error}",
                ) from error
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

    async def async_status(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.status)

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

    async def async_whoami(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.whoami)


class WorkspacesResource:
    def __init__(self, client: LucidaClient):
        self._client = client

    def list(self, *, archived: bool = False) -> list[dict[str, Any]]:
        segments = ["api", "workspaces", "archived"] if archived else ["api", "workspaces"]
        return self._client._request_json("GET", segments)

    async def async_list(self, *, archived: bool = False) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.list, archived=archived)

    def create(self, name: str | None = None) -> "WorkspaceResource":
        record = self._client._request_json("POST", ["api", "workspaces"], body={"name": name})
        return WorkspaceResource(self._client, record)

    async def async_create(self, name: str | None = None) -> "WorkspaceResource":
        return await asyncio.to_thread(self.create, name)

    def get(self, workspace_id: str) -> "WorkspaceResource":
        record = self._client._request_json("GET", ["api", "workspaces", workspace_id])
        return WorkspaceResource(self._client, record)

    async def async_get(self, workspace_id: str) -> "WorkspaceResource":
        return await asyncio.to_thread(self.get, workspace_id)

    def open(self, workspace_id: str) -> "WorkspaceResource":
        record = self._client._request_json("POST", ["api", "workspaces", workspace_id])
        return WorkspaceResource(self._client, record)

    async def async_open(self, workspace_id: str) -> "WorkspaceResource":
        return await asyncio.to_thread(self.open, workspace_id)

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

    async def async_resolve(
        self,
        selector: str | None = None,
        *,
        include_archived: bool = False,
    ) -> "WorkspaceResource":
        return await asyncio.to_thread(
            self.resolve,
            selector,
            include_archived=include_archived,
        )

    def use(self, selector: str) -> "WorkspaceResource":
        workspace = self.resolve(selector)
        entry = server_config_mut(self._client.config, self._client.server.url)
        entry["workspace"] = workspace.id
        self._client.config_store.save(self._client.config)
        return workspace

    async def async_use(self, selector: str) -> "WorkspaceResource":
        return await asyncio.to_thread(self.use, selector)


class WorkspaceResource:
    def __init__(self, client: LucidaClient, record: dict[str, Any]):
        self._client = client
        self.record = record
        self.datasets = DatasetsResource(self)
        self.view = ViewResource(self)
        self.layer = LayerResource(self)
        self.channel = ChannelResource(self)
        self.saved_views = SavedViewsResource(self)
        self.viewer_profiles = ViewerProfilesResource(self)
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
        base = urlunparse((scheme, parsed.netloc, parsed.path, "", "", ""))
        return build_url(base, ["ws", "workspaces", self.id])

    def refresh(self) -> "WorkspaceResource":
        self.record = self._client._request_json("GET", ["api", "workspaces", self.id])
        return self

    async def async_refresh(self) -> "WorkspaceResource":
        return await asyncio.to_thread(self.refresh)

    def open(self) -> "WorkspaceResource":
        self.record = self._client._request_json("POST", ["api", "workspaces", self.id])
        return self

    async def async_open(self) -> "WorkspaceResource":
        return await asyncio.to_thread(self.open)

    def snapshot(self, *, timeout: float = 30.0) -> dict[str, Any]:
        return run_sync(self.async_snapshot(timeout=timeout))

    async def async_snapshot(self, *, timeout: float = 30.0) -> dict[str, Any]:
        deadline = Deadline(timeout, operation="workspace snapshot")
        async with self._connect_ws(deadline.remaining()) as ws:
            return await recv_snapshot(ws, deadline)

    def _connect_ws(self, open_timeout: float | None = None) -> Any:
        headers = {}
        if self._client.token:
            headers["Authorization"] = f"Bearer {self._client.token}"
        if self._client.ws_connect is not None:
            return self._client.ws_connect(self.ws_url, headers)
        return default_ws_connect(
            self.ws_url,
            headers,
            open_timeout=open_timeout,
            max_size=self._client.max_ws_message_bytes,
        )


class SyncDeadline:
    def __init__(self, timeout: float, *, operation: str):
        if timeout <= 0:
            raise LucidaError("config", "timeout must be positive")
        self.timeout = timeout
        self.operation = operation
        self.expires_at = time.monotonic() + timeout

    def remaining(self) -> float:
        remaining = self.expires_at - time.monotonic()
        if remaining <= 0:
            raise LucidaError(
                "deadline_exceeded",
                f"{self.operation} exceeded its {self.timeout:g}s deadline",
            )
        return remaining


class ViewerProfilesResource:
    """Durable private viewer state with revision-based compare-and-swap."""

    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def _segments(self, profile: str) -> list[str]:
        return [
            "api",
            "workspaces",
            self._workspace.id,
            "viewer-profiles",
            profile,
        ]

    def get(
        self,
        profile: str = "default",
        *,
        timeout: float | None = None,
    ) -> dict[str, Any] | None:
        return self._workspace._client._request_json(
            "GET",
            self._segments(profile),
            timeout=timeout,
        )

    async def async_get(
        self,
        profile: str = "default",
        *,
        timeout: float | None = None,
    ) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.get, profile, timeout=timeout)

    def put(
        self,
        view: dict[str, Any],
        *,
        expected_revision: int | None,
        profile: str = "default",
        seed_source: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        return self._workspace._client._request_json(
            "PUT",
            self._segments(profile),
            body={
                "view": view,
                "expected_revision": expected_revision,
                "seed_source": seed_source,
            },
            timeout=timeout,
        )

    async def async_put(
        self,
        view: dict[str, Any],
        *,
        expected_revision: int | None,
        profile: str = "default",
        seed_source: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.put,
            view,
            expected_revision=expected_revision,
            profile=profile,
            seed_source=seed_source,
            timeout=timeout,
        )

    def get_or_seed(
        self,
        snapshot: dict[str, Any],
        *,
        profile: str = "default",
        deadline: SyncDeadline,
    ) -> dict[str, Any]:
        record = self.get(profile, timeout=deadline.remaining())
        if record is not None:
            return record
        seed = saved_view_from_snapshot(snapshot)
        try:
            return self.put(
                seed,
                expected_revision=None,
                profile=profile,
                seed_source="workspace_snapshot",
                timeout=deadline.remaining(),
            )
        except LucidaError as error:
            if error.kind != "viewer_profile_conflict":
                raise
            # A concurrent first writer created the row. Adopt its version.
            record = self.get(profile, timeout=deadline.remaining())
            if record is None:
                raise LucidaError(
                    "protocol",
                    "viewer profile create conflicted but no profile exists",
                ) from error
            return record

    def mutate(
        self,
        mutator: Any,
        *,
        profile: str = "default",
        timeout: float = 30.0,
        needs_snapshot: bool = False,
    ) -> dict[str, Any]:
        deadline = SyncDeadline(timeout, operation="viewer profile update")
        snapshot = (
            self._workspace.snapshot(timeout=deadline.remaining())
            if needs_snapshot
            else None
        )
        for attempt in range(3):
            record = self.get(profile, timeout=deadline.remaining())
            if record is None:
                if snapshot is None:
                    snapshot = self._workspace.snapshot(timeout=deadline.remaining())
                view = saved_view_from_snapshot(snapshot)
                expected_revision = None
                seed_source = "workspace_snapshot"
            else:
                view = copy.deepcopy(record["view"])
                expected_revision = int(record["revision"])
                seed_source = None
            mutator(view, snapshot)
            try:
                updated = self.put(
                    view,
                    expected_revision=expected_revision,
                    profile=profile,
                    seed_source=seed_source,
                    timeout=deadline.remaining(),
                )
                return viewer_profile_mutation_result(updated)
            except LucidaError as error:
                if error.kind != "viewer_profile_conflict" or attempt == 2:
                    raise
                # Re-read and reapply the operation to the newest record. This
                # preserves disjoint edits while the server prevents lost writes.
        raise AssertionError("viewer profile retry loop exhausted")

    async def async_mutate(
        self,
        mutator: Any,
        *,
        profile: str = "default",
        timeout: float = 30.0,
        needs_snapshot: bool = False,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.mutate,
            mutator,
            profile=profile,
            timeout=timeout,
            needs_snapshot=needs_snapshot,
        )


class DatasetsResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        snapshot = self._workspace.snapshot(timeout=timeout)
        return dataset_summaries_from_document(snapshot.get("document", {}))

    async def async_list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        snapshot = await self._workspace.async_snapshot(timeout=timeout)
        return dataset_summaries_from_document(snapshot.get("document", {}))

    def info(self, dataset: str, *, timeout: float = 30.0) -> dict[str, Any]:
        snapshot = self._workspace.snapshot(timeout=timeout)
        return dataset_info_from_document(snapshot.get("document", {}), dataset)

    async def async_info(
        self,
        dataset: str,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        snapshot = await self._workspace.async_snapshot(timeout=timeout)
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

        Looks up the dataset's shape via :meth:`info`, then enumerates the
        sensible next moves (Home / rotate / zoom / step Z) as re-openable child
        views, returning a decoded ``ExplorationSidecar`` dict (``v``,
        ``current``, ``cells``).

        Pass ``view`` (a ``SavedView`` dict — e.g. a child cell's ``view`` from a
        previous call) to descend from an explicit view; omit it to start from
        the dataset's Home view (a 3D Arcball for a volume, a 2D Slice for a flat
        image, framed to the full extent). ``depth`` and ``breadcrumb`` are
        stamped on the returned current node so a stateless caller can keep an
        honest trail across calls.

        URLs are deferred: each cell carries a full ``view`` object, which you
        pass back as ``view=`` to descend.
        """
        try:
            from lucida.lucida import explore as _explore  # noqa: PLC0415
        except ImportError as error:
            raise LucidaError(
                "config",
                "the compiled lucida extension is unavailable; build it with "
                "`uv run maturin develop` in lucida-py",
            ) from error

        summary = self.info(dataset, timeout=timeout)
        dims = summary.get("dimensions")
        if not dims or len(dims) != 5:
            raise LucidaError(
                "missing_resource",
                f"dataset {dataset!r} has no 5D [T,C,Z,Y,X] dimensions to explore",
            )
        ds_id = summary["workspace_dataset_id"]
        view_json = json.dumps(view) if view is not None else None
        result = _explore(
            ds_id,
            tuple(dims),
            viewport,
            view_json,
            depth,
            breadcrumb or [],
        )
        return json.loads(result)

    async def async_explore(
        self,
        dataset: str,
        *,
        view: dict[str, Any] | None = None,
        viewport: tuple[int, int] = (960, 720),
        depth: int = 0,
        breadcrumb: list[str] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.explore,
            dataset,
            viewport=viewport,
            view=view,
            depth=depth,
            breadcrumb=breadcrumb,
            timeout=timeout,
        )

    def open(self, source: str, *, timeout: float = 300.0) -> dict[str, Any]:
        return run_sync(self.async_open(source, timeout=timeout))

    async def async_open(self, source: str, *, timeout: float = 300.0) -> dict[str, Any]:
        deadline = Deadline(timeout, operation="dataset open")
        async with self._workspace._connect_ws(deadline.remaining()) as ws:
            snapshot = await recv_snapshot(ws, deadline)
            request_id = f"py-{uuid.uuid4().hex}"
            await send_json(
                ws,
                {
                    "type": "open_remote_dataset",
                    "request_id": request_id,
                    "url": source,
                },
                deadline,
            )
            progress: list[dict[str, Any]] = []
            while True:
                message = await recv_json(ws, deadline)
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
                summary = message.get("summary") or {}
                return dataset_open_summary(
                    summary,
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
        deadline = Deadline(timeout, operation="dataset health")
        async with self._workspace._connect_ws(deadline.remaining()) as ws:
            snapshot = await recv_snapshot(ws, deadline)
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
                deadline,
            )
            while True:
                message = await recv_json(ws, deadline)
                if (
                    message.get("type") == "dataset_health"
                    and message.get("request_id") == request_id
                ):
                    datasets = message.get("datasets")
                    return datasets if isinstance(datasets, list) else []

    def retry(self, dataset: str, *, timeout: float = 300.0) -> dict[str, Any]:
        return run_sync(self.async_retry(dataset, timeout=timeout))

    async def async_retry(self, dataset: str, *, timeout: float = 300.0) -> dict[str, Any]:
        deadline = Deadline(timeout, operation="dataset retry")
        async with self._workspace._connect_ws(deadline.remaining()) as ws:
            snapshot = await recv_snapshot(ws, deadline)
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
                deadline,
            )
            progress: list[dict[str, Any]] = []
            while True:
                message = await recv_json(ws, deadline)
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
                summary = message.get("summary") or {}
                return dataset_open_summary(
                    summary,
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
        require_finite("view.pan dx", dx)
        require_finite("view.pan dy", dy)

        def mutate(presence: dict[str, Any]) -> None:
            camera = ensure_slice_camera(presence["camera"])
            zoom = float(camera.get("zoom") or 1.0)
            camera["center"][0] += dx / zoom
            camera["center"][1] += dy / zoom

        return self._apply(mutate, timeout=timeout)

    def zoom(self, factor: float, *, timeout: float = 30.0) -> dict[str, Any]:
        require_finite("view.zoom factor", factor)
        if factor <= 0:
            raise LucidaError("config", "view.zoom factor must be positive")

        def mutate(presence: dict[str, Any]) -> None:
            camera = ensure_slice_camera(presence["camera"])
            camera["zoom"] = float(camera.get("zoom") or 1.0) * factor

        return self._apply(mutate, timeout=timeout)

    def set_zoom(self, value: float, *, timeout: float = 30.0) -> dict[str, Any]:
        require_finite("view.set_zoom value", value)
        if value <= 0:
            raise LucidaError("config", "view.set_zoom value must be positive")

        def mutate(presence: dict[str, Any]) -> None:
            ensure_slice_camera(presence["camera"])["zoom"] = value

        return self._apply(mutate, timeout=timeout)

    def center(self, x: float, y: float, *, timeout: float = 30.0) -> dict[str, Any]:
        require_finite("view.center x", x)
        require_finite("view.center y", y)

        def mutate(presence: dict[str, Any]) -> None:
            ensure_slice_camera(presence["camera"])["center"] = [x, y]

        return self._apply(mutate, timeout=timeout)

    def slice(self, axis: str, index: int, *, timeout: float = 30.0) -> dict[str, Any]:
        axis = axis.lower()
        if axis not in {"z", "t", "c"}:
            raise LucidaError("config", f"unknown slice axis: {axis}")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise LucidaError("config", "view.slice index must be a non-negative integer")

        def mutate(presence: dict[str, Any]) -> None:
            view = presence["view"]
            if axis == "z":
                set_z_range(view, index, index + 1)
            else:
                view[axis] = index

        return self._apply(mutate, timeout=timeout)

    def z_range(self, start: int, end: int, *, timeout: float = 30.0) -> dict[str, Any]:
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (start, end)):
            raise LucidaError("config", "view.z_range bounds must be integers")
        if start < 0 or end <= start:
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
        def mutate(view: dict[str, Any], _snapshot: dict[str, Any] | None) -> None:
            mutator(saved_view_presence(view))

        return self._workspace.viewer_profiles.mutate(mutate, timeout=timeout)

    async def async_apply(self, mutator: Any, *, timeout: float = 30.0) -> dict[str, Any]:
        return await asyncio.to_thread(self._apply, mutator, timeout=timeout)

    async def async_pan(
        self, dx: float, dy: float, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.pan, dx, dy, timeout=timeout)

    async def async_zoom(self, factor: float, *, timeout: float = 30.0) -> dict[str, Any]:
        return await asyncio.to_thread(self.zoom, factor, timeout=timeout)

    async def async_set_zoom(
        self, value: float, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.set_zoom, value, timeout=timeout)

    async def async_center(
        self, x: float, y: float, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.center, x, y, timeout=timeout)

    async def async_slice(
        self, axis: str, index: int, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.slice, axis, index, timeout=timeout)

    async def async_z_range(
        self, start: int, end: int, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.z_range, start, end, timeout=timeout)

    async def async_viewport_size(
        self, width: int, height: int, *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.viewport_size,
            width,
            height,
            timeout=timeout,
        )


class LayerResource:
    def __init__(self, workspace: WorkspaceResource):
        self._workspace = workspace

    def list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        deadline = SyncDeadline(timeout, operation="layer listing")
        snapshot = self._workspace.snapshot(timeout=deadline.remaining())
        record = self._workspace.viewer_profiles.get_or_seed(
            snapshot,
            deadline=deadline,
        )
        presence = saved_view_presence(record["view"])
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
        require_finite("layer.opacity", opacity)
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
        require_finite("layer.contrast min", min)
        require_finite("layer.contrast max", max)
        if max <= min:
            raise LucidaError("config", "layer.contrast max must be greater than min")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            channel = int(presence.get("view", {}).get("c", 0))
            settings = ensure_channel_settings(snapshot, presence, dataset, channel)
            settings["contrast_min"] = min
            settings["contrast_max"] = max
            dataset_id = resolve_dataset_id_or_name(
                dataset,
                dataset_summaries_from_document(snapshot.get("document", {})),
            )["workspace_dataset_id"]
            presence.setdefault("auto_contrast", {})[dataset_id] = False

        return self._apply(mutate, timeout=timeout)

    def gamma(self, dataset: str, gamma: float, *, timeout: float = 30.0) -> dict[str, Any]:
        require_finite("layer.gamma", gamma)
        if gamma <= 0:
            raise LucidaError("config", "layer.gamma must be positive")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            channel = int(presence.get("view", {}).get("c", 0))
            ensure_channel_settings(snapshot, presence, dataset, channel)["gamma"] = gamma

        return self._apply(mutate, timeout=timeout)

    def _apply(self, mutator: Any, *, timeout: float) -> dict[str, Any]:
        def mutate(
            view: dict[str, Any],
            snapshot: dict[str, Any] | None,
        ) -> None:
            if snapshot is None:
                raise LucidaError("protocol", "dataset mutation requires a snapshot")
            mutator(snapshot, saved_view_presence(view))

        return self._workspace.viewer_profiles.mutate(
            mutate,
            timeout=timeout,
            needs_snapshot=True,
        )

    async def async_apply(self, mutator: Any, *, timeout: float = 30.0) -> dict[str, Any]:
        return await asyncio.to_thread(self._apply, mutator, timeout=timeout)

    async def async_list(self, *, timeout: float = 30.0) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.list, timeout=timeout)

    async def async_order(
        self, datasets: list[str], *, timeout: float = 30.0
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.order, datasets, timeout=timeout)

    async def async_visible(
        self,
        dataset: str,
        visible: bool,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.visible,
            dataset,
            visible,
            timeout=timeout,
        )

    async def async_opacity(
        self,
        dataset: str,
        opacity: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.opacity,
            dataset,
            opacity,
            timeout=timeout,
        )

    async def async_contrast(
        self,
        dataset: str,
        min: float,
        max: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.contrast,
            dataset,
            min,
            max,
            timeout=timeout,
        )

    async def async_gamma(
        self,
        dataset: str,
        gamma: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.gamma,
            dataset,
            gamma,
            timeout=timeout,
        )


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
        colormap = colormap.lower()
        if colormap not in SUPPORTED_COLORMAPS:
            supported = ", ".join(sorted(SUPPORTED_COLORMAPS))
            raise LucidaError(
                "config",
                f"unknown channel colormap {colormap!r}; expected one of: {supported}",
            )

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
        require_finite("channel.contrast min", min)
        require_finite("channel.contrast max", max)
        if max <= min:
            raise LucidaError("config", "channel.contrast max must be greater than min")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            settings = ensure_channel_settings(snapshot, presence, dataset, channel)
            settings["contrast_min"] = min
            settings["contrast_max"] = max
            # Manual contrast and auto-contrast are mutually exclusive. Persist
            # the client-only preference in the same viewer profile so opening
            # the SPA cannot immediately overwrite this durable command with a
            # newly observed intensity range.
            dataset_id = resolve_dataset_id_or_name(
                dataset,
                dataset_summaries_from_document(snapshot.get("document", {})),
            )["workspace_dataset_id"]
            presence.setdefault("auto_contrast", {})[dataset_id] = False

        return self._workspace.layer._apply(mutate, timeout=timeout)

    def gamma(
        self,
        dataset: str,
        channel: int,
        gamma: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        require_finite("channel.gamma", gamma)
        if gamma <= 0:
            raise LucidaError("config", "channel.gamma must be positive")

        def mutate(snapshot: dict[str, Any], presence: dict[str, Any]) -> None:
            ensure_channel_settings(snapshot, presence, dataset, channel)["gamma"] = gamma

        return self._workspace.layer._apply(mutate, timeout=timeout)

    async def async_mode(self, mode: str, *, timeout: float = 30.0) -> dict[str, Any]:
        return await asyncio.to_thread(self.mode, mode, timeout=timeout)

    async def async_visible(
        self,
        dataset: str,
        channel: int,
        visible: bool,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.visible,
            dataset,
            channel,
            visible,
            timeout=timeout,
        )

    async def async_colormap(
        self,
        dataset: str,
        channel: int,
        colormap: str,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.colormap,
            dataset,
            channel,
            colormap,
            timeout=timeout,
        )

    async def async_contrast(
        self,
        dataset: str,
        channel: int,
        min: float,
        max: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.contrast,
            dataset,
            channel,
            min,
            max,
            timeout=timeout,
        )

    async def async_gamma(
        self,
        dataset: str,
        channel: int,
        gamma: float,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.gamma,
            dataset,
            channel,
            gamma,
            timeout=timeout,
        )


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

    async def async_state(self, *, timeout: float = 30.0) -> dict[str, Any]:
        snapshot = await self._workspace.async_snapshot(timeout=timeout)
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

    async def async_list(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.list)

    def get(self, saved_view_id: str) -> dict[str, Any]:
        return self._client._request_json("GET", self._segments(saved_view_id))

    async def async_get(self, saved_view_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self.get, saved_view_id)

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

    async def async_create(
        self,
        name: str,
        view: dict[str, Any],
        visibility: str = "shared",
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self.create, name, view, visibility)

    def set_visibility(self, saved_view_id: str, visibility: str) -> dict[str, Any]:
        return self._client._request_json(
            "PATCH",
            self._segments(saved_view_id, "visibility"),
            body={"visibility": visibility},
        )

    async def async_set_visibility(
        self,
        saved_view_id: str,
        visibility: str,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.set_visibility,
            saved_view_id,
            visibility,
        )

    def approve(self, saved_view_id: str) -> dict[str, Any]:
        return self._client._request_json(
            "POST",
            self._segments(saved_view_id, "approve"),
        )

    async def async_approve(self, saved_view_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self.approve, saved_view_id)

    def reject(self, saved_view_id: str) -> dict[str, Any]:
        return self._client._request_json(
            "POST",
            self._segments(saved_view_id, "reject"),
        )

    async def async_reject(self, saved_view_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self.reject, saved_view_id)


def build_url(
    base_url: str,
    segments: list[str],
    query: dict[str, Any] | None = None,
) -> str:
    parsed = urlparse(base_url)
    prefix = parsed.path.rstrip("/")
    suffix = "/".join(quote(str(segment), safe="") for segment in segments)
    path = f"{prefix}/{suffix}" if suffix else prefix or "/"
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
    body = response.text()
    message = error_detail(body)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        payload = None
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
    if (
        response.status == 409
        and isinstance(payload, dict)
        and payload.get("error") == "viewer_profile_conflict"
    ):
        return LucidaError(
            "viewer_profile_conflict",
            message or "viewer profile changed; read the latest revision and retry",
            status=response.status,
            body=body,
            diagnostic=payload,
        )
    if response.status == 409:
        return LucidaError(
            "rejected_command",
            message or "request conflicted with current server state",
            status=response.status,
            body=body,
        )
    if response.status == 410:
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


def require_finite(name: str, value: float) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise LucidaError("config", f"{name} must be finite")


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
    format_version = manifest.get("format_version")
    if format_version is not None and (
        isinstance(format_version, bool)
        or not isinstance(format_version, int)
        or not 0 <= format_version <= 0xFFFF_FFFF
    ):
        raise LucidaError(
            "protocol",
            "manifest field format_version must be an unsigned 32-bit integer",
            diagnostic={"field": "format_version"},
        )

    inline = image.get("multiscale")
    ref = image.get("multiscale_ref")
    has_inline = inline is not None
    has_ref = ref is not None
    image_id = str(image.get("image_id") or "<unknown>")

    if has_inline == has_ref:
        detail = (
            "both an inline multiscale and a multiscale_ref"
            if has_inline
            else "neither a multiscale nor a multiscale_ref"
        )
        raise LucidaError(
            "protocol",
            f"image {image_id} carries {detail}",
            diagnostic={"field": "images[].multiscale", "image_id": image_id},
        )
    if has_inline:
        if not isinstance(inline, dict):
            raise LucidaError(
                "protocol",
                f"image {image_id} field multiscale must be an object",
                diagnostic={"field": "images[].multiscale", "image_id": image_id},
            )
        return inline

    if isinstance(ref, bool) or not isinstance(ref, int) or ref < 0:
        raise LucidaError(
            "protocol",
            f"image {image_id} field multiscale_ref must be a non-negative integer",
            diagnostic={"field": "images[].multiscale_ref", "image_id": image_id},
        )
    table = manifest.get("multiscales")
    if not isinstance(table, list):
        raise LucidaError(
            "protocol",
            "manifest field multiscales must be an array when multiscale_ref is used",
            diagnostic={"field": "multiscales", "image_id": image_id},
        )
    if ref >= len(table):
        raise LucidaError(
            "protocol",
            f"image {image_id} references shared multiscale {ref}, but the manifest declares "
            f"{len(table)} shared multiscale(s)",
            diagnostic={"field": "images[].multiscale_ref", "image_id": image_id},
        )
    shared = table[ref]
    if not isinstance(shared, dict):
        raise LucidaError(
            "protocol",
            f"manifest multiscales[{ref}] must be an object",
            diagnostic={"field": f"multiscales[{ref}]", "image_id": image_id},
        )
    return shared


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
                "channel_infos": copy.deepcopy(multiscale.get("channel_infos") or []),
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
        "label_count": len(manifest.get("labels") or []),
        "default_layout_id": manifest.get("default_layout_id"),
        "source_layout_count": len(manifest.get("source_layouts") or []),
        "registered_layout_count": len(
            (document.get("registered_layouts") or {}).get(dataset_id) or []
        ),
        "entities": copy.deepcopy(manifest.get("entities") or []),
        "labels": label_summaries(manifest),
        "images": images,
    }


def label_summaries(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for index, label in enumerate(manifest.get("labels") or []):
        if not isinstance(label, dict):
            raise LucidaError(
                "protocol",
                f"manifest labels[{index}] must be an object",
                diagnostic={"field": f"labels[{index}]"},
            )
        image = label.get("image")
        if not isinstance(image, dict):
            raise LucidaError(
                "protocol",
                f"manifest labels[{index}].image must be an object",
                diagnostic={"field": f"labels[{index}].image"},
            )
        multiscale = image.get("multiscale")
        if not isinstance(multiscale, dict):
            raise LucidaError(
                "protocol",
                f"manifest labels[{index}].image.multiscale must be an object",
                diagnostic={"field": f"labels[{index}].image.multiscale"},
            )
        axes = multiscale.get("axes") or []
        axis_names = [
            str(axis.get("name") or "") if isinstance(axis, dict) else str(axis)
            for axis in axes
        ]
        levels = multiscale.get("levels") or []
        level0 = levels[0] if levels and isinstance(levels[0], dict) else {}
        scale = level0.get("scale")
        level0_scale = list(scale) if isinstance(scale, list) and len(scale) == 5 else [1.0] * 5
        summaries.append(
            {
                "name": label.get("name"),
                "source_image_id": label.get("source_image_id"),
                "source_entity_id": image.get("owner"),
                "label_image_id": image.get("image_id"),
                "data_type": multiscale.get("data_type"),
                "axis_names": axis_names,
                "level0_scale": level0_scale,
                "colors": copy.deepcopy(label.get("colors") or []),
                "source_declared": bool(label.get("source_declared", False)),
            }
        )
    return summaries


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
    summary: dict[str, Any],
    *,
    source: str,
    seq: int,
    workspace_id: str,
    diagnostic: Any = None,
    progress: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    result = {
        "workspace_id": workspace_id,
        "workspace_dataset_id": summary.get("workspace_dataset_id"),
        "name": summary.get("name"),
        "image_count": int(summary.get("image_count") or 0),
        "entity_count": int(summary.get("entity_count") or 0),
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
    code = diagnostic.get("code", diagnostic.get("kind"))
    return DATASET_OPEN_CODE_TO_ERROR_KIND.get(code, "dataset_open_failure")


def own_presence(snapshot: dict[str, Any]) -> dict[str, Any]:
    own_id = snapshot.get("your_id")
    for peer in snapshot.get("peers") or []:
        if peer.get("client_id") == own_id:
            return peer
    raise LucidaError("protocol", "workspace snapshot did not include this client presence")


def saved_view_from_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    presence = own_presence(snapshot)
    document = snapshot.get("document") or {}
    active_layouts: dict[str, str] = {}
    for manifest in (document.get("manifests") or {}).values():
        dataset_id = manifest.get("dataset_id")
        layout_id = active_layout_id(document, manifest)
        if dataset_id and layout_id:
            active_layouts[str(dataset_id)] = str(layout_id)
    return {
        "v": 1,
        "datasets": [],
        "active_layouts": active_layouts,
        "camera": copy.deepcopy(presence["camera"]),
        "view": copy.deepcopy(presence["view"]),
        "display": copy.deepcopy(presence["display"]),
        "dataset_order": copy.deepcopy(presence.get("dataset_order") or []),
        "dataset_settings": copy.deepcopy(presence.get("dataset_settings") or {}),
        "auto_contrast": {},
    }


def saved_view_presence(view: dict[str, Any]) -> dict[str, Any]:
    """Return a presence-shaped facade backed by a saved-view dictionary."""

    view.setdefault("dataset_order", [])
    view.setdefault("dataset_settings", {})
    view.setdefault("auto_contrast", {})
    return {
        "camera": view["camera"],
        "view": view["view"],
        "display": view["display"],
        "following": None,
        "dataset_order": view["dataset_order"],
        "dataset_settings": view["dataset_settings"],
        "auto_contrast": view["auto_contrast"],
    }


def viewer_profile_mutation_result(record: dict[str, Any]) -> dict[str, Any]:
    view = record["view"]
    return {
        "durable": True,
        "profile": record.get("profile"),
        "revision": record.get("revision"),
        "updated_at": record.get("updated_at"),
        "camera": view["camera"],
        "view": view["view"],
        "display": view["display"],
        "dataset_order": view.get("dataset_order") or [],
        "dataset_settings": view.get("dataset_settings") or {},
        "auto_contrast": view.get("auto_contrast") or {},
    }


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


class Deadline:
    """A single monotonic budget shared by every phase of one operation."""

    def __init__(self, timeout: float, *, operation: str):
        if timeout <= 0:
            raise LucidaError("config", "timeout must be positive")
        self.timeout = timeout
        self.operation = operation
        self.expires_at = asyncio.get_running_loop().time() + timeout

    def remaining(self) -> float:
        remaining = self.expires_at - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise LucidaError(
                "deadline_exceeded",
                f"{self.operation} exceeded its {self.timeout:g}s deadline",
            )
        return remaining


async def recv_snapshot(ws: Any, deadline: Deadline) -> dict[str, Any]:
    while True:
        message = await recv_json(ws, deadline)
        message_type = message.get("type")
        if message_type == "snapshot":
            return message
        if message_type == "workspace_archived":
            raise LucidaError("archived_workspace", "workspace is archived")


async def recv_json(ws: Any, deadline: Deadline) -> dict[str, Any]:
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=deadline.remaining())
    except asyncio.TimeoutError as error:
        raise LucidaError(
            "deadline_exceeded",
            f"{deadline.operation} exceeded its {deadline.timeout:g}s deadline",
        ) from error
    if isinstance(raw, bytes):
        raise LucidaError("protocol", "unexpected binary WebSocket message")
    try:
        message = json.loads(raw)
    except json.JSONDecodeError as error:
        raise LucidaError("protocol", f"invalid workspace server message: {error}") from error
    if not isinstance(message, dict):
        raise LucidaError("protocol", "workspace server message must be a JSON object")
    message_type = message.get("type")
    if not isinstance(message_type, str) or not message_type:
        raise LucidaError(
            "protocol",
            "workspace server message requires a non-empty string field 'type'",
        )
    if message_type == "workspace_archived":
        raise LucidaError("archived_workspace", "workspace is archived")
    return message


async def send_json(
    ws: Any,
    message: dict[str, Any],
    deadline: Deadline | None = None,
) -> None:
    payload = json.dumps(message, separators=(",", ":"))
    if deadline is None:
        await ws.send(payload)
        return
    try:
        await asyncio.wait_for(ws.send(payload), timeout=deadline.remaining())
    except asyncio.TimeoutError as error:
        raise LucidaError(
            "deadline_exceeded",
            f"{deadline.operation} exceeded its {deadline.timeout:g}s deadline",
        ) from error


def default_ws_connect(
    url: str,
    headers: dict[str, str],
    *,
    open_timeout: float | None = 30.0,
    max_size: int = MAX_WEBSOCKET_MESSAGE_BYTES,
) -> Any:
    try:
        import websockets
    except ImportError as error:
        raise LucidaError(
            "config",
            "websockets is required for workspace session operations; in a source checkout run from lucida-py with `uv run python ...` or install dependencies with `uv sync`",
        ) from error

    if max_size <= 0:
        raise ValueError("max_size must be positive")
    kwargs: dict[str, Any] = {
        "max_size": max_size,
        "open_timeout": open_timeout,
    }
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
    "ViewerProfilesResource",
    "WorkspaceResource",
    "WorkspacesResource",
    "normalize_server_base_url",
    "resolve_token",
]
