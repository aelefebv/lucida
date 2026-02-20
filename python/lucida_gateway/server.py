"""aiohttp-based Step 11 gateway service."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
from typing import Any

from aiohttp import WSMsgType, WSCloseCode, web

from lucida_core.engine import MUTATING_METHODS
from lucida_core.errors import LucidaError, internal, invalid_params
from lucida_daemon import LucidaDaemon
from lucida_sdk.ids import make_idempotency_key, uuid7_str
from lucida_sdk.registry import get_local_daemon, launch_or_get_local_daemon

from .auth import is_authorized, unauthorized_response
from .bridge import AttachmentState, GatewayBridge
from .config import GatewayConfig
from .render import FrameRenderer2D, RemoteRenderState


@dataclass
class _WsClientState:
    ws: web.WebSocketResponse
    connection_id: str
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    attached: AttachmentState | None = None
    render_state: RemoteRenderState | None = None
    render_queue: asyncio.Queue[tuple[int, list[Any]]] | None = None
    dropped_frames: int = 0
    overflow_streak: int = 0
    lossless: bool = False
    tasks: list[asyncio.Task[None]] = field(default_factory=list)


class WebGatewayServer:
    """Remote WS gateway that relays RPC/events and streams rendered tiles."""

    def __init__(
        self,
        *,
        config: GatewayConfig,
        daemon: LucidaDaemon | None = None,
    ) -> None:
        config.validate()
        self._config = config
        self._daemon = daemon or self._resolve_daemon()
        self._daemon.start()
        self._bridge = GatewayBridge(daemon=self._daemon)
        self._renderer = FrameRenderer2D(
            daemon=self._daemon,
            tile_size_px=config.tile_size_px,
            jpeg_quality=config.jpeg_quality,
        )
        self._clients: list[_WsClientState] = []

        app = web.Application()
        app.add_routes(
            [
                web.get("/healthz", self.healthz),
                web.get("/v1/ws", self.websocket),
            ]
        )
        app.on_shutdown.append(self._on_shutdown)
        self._app = app

    @property
    def app(self) -> web.Application:
        return self._app

    async def healthz(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                "status": "ok",
                "step": "step-11",
                "host": self._config.host,
                "port": self._config.port,
            }
        )

    async def websocket(self, request: web.Request) -> web.StreamResponse:
        if not is_authorized(
            auth_header=request.headers.get("Authorization"),
            query_token=request.query.get("token"),
            expected_token=self._config.token,
        ):
            return unauthorized_response()

        ws = web.WebSocketResponse(autoping=True, heartbeat=30.0)
        await ws.prepare(request)

        connection_id = self._bridge.connect()
        client = _WsClientState(ws=ws, connection_id=connection_id)
        self._clients.append(client)

        try:
            async for message in ws:
                if message.type == WSMsgType.TEXT:
                    await self._handle_incoming(client, message.data)
                    continue
                if message.type in {WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED}:
                    break
                if message.type == WSMsgType.ERROR:
                    break
        finally:
            await self._teardown_client(client)

        return ws

    def _resolve_daemon(self) -> LucidaDaemon:
        if self._config.auto_launch_daemon:
            daemon, _created = launch_or_get_local_daemon(local_ipc_uri=self._config.local_ipc_uri)
            return daemon
        return get_local_daemon(local_ipc_uri=self._config.local_ipc_uri)

    async def _handle_incoming(self, client: _WsClientState, raw_payload: str) -> None:
        try:
            payload = json.loads(raw_payload)
        except json.JSONDecodeError:
            await self._send_error(client, request_id=None, error=invalid_params("WS payload must be valid JSON", {}))
            return

        if not isinstance(payload, dict):
            await self._send_error(client, request_id=None, error=invalid_params("WS payload must be an object", {}))
            return

        frame_type = payload.get("type")
        if frame_type == "attach":
            await self._handle_attach(client, payload)
            return
        if frame_type == "rpc.request":
            await self._handle_rpc(client, payload)
            return

        await self._send_error(
            client,
            request_id=payload.get("id") if isinstance(payload.get("id"), str) else None,
            error=invalid_params(
                "Unknown WS frame type",
                {"type": frame_type},
            ),
        )

    async def _handle_attach(self, client: _WsClientState, payload: dict[str, Any]) -> None:
        if client.attached is not None:
            await self._send_error(
                client,
                request_id=None,
                error=invalid_params(
                    "Connection is already attached",
                    {
                        "session_id": client.attached.session_id,
                        "view_id": client.attached.view_id,
                    },
                ),
            )
            return

        session_id = payload.get("session_id")
        view_id = payload.get("view_id")
        client_name = payload.get("client_name")
        client_version = payload.get("client_version")

        if not isinstance(session_id, str) or not session_id:
            await self._send_error(client, request_id=None, error=invalid_params("attach.session_id is required", {}))
            return
        if not isinstance(view_id, str) or not view_id:
            await self._send_error(client, request_id=None, error=invalid_params("attach.view_id is required", {}))
            return
        if not isinstance(client_name, str) or not client_name:
            await self._send_error(client, request_id=None, error=invalid_params("attach.client_name is required", {}))
            return
        if not isinstance(client_version, str) or not client_version:
            await self._send_error(client, request_id=None, error=invalid_params("attach.client_version is required", {}))
            return

        try:
            attached = self._bridge.attach(
                connection_id=client.connection_id,
                session_id=session_id,
                view_id=view_id,
                client_name=client_name,
                client_version=client_version,
            )
        except LucidaError as exc:
            await self._send_error(client, request_id=None, error=exc)
            return

        client.attached = attached
        client.render_state = RemoteRenderState()
        client.render_queue = asyncio.Queue(maxsize=self._config.render_queue_capacity)
        client.lossless = bool(payload.get("lossless", False))
        client.tasks.append(asyncio.create_task(self._poll_events(client), name=f"gateway-events-{client.connection_id}"))
        client.tasks.append(asyncio.create_task(self._render_producer(client), name=f"gateway-render-producer-{client.connection_id}"))
        client.tasks.append(asyncio.create_task(self._render_consumer(client), name=f"gateway-render-consumer-{client.connection_id}"))

        await self._send_json(
            client,
            {
                "type": "attach.ok",
                "session_id": attached.session_id,
                "view_id": attached.view_id,
                "subscription_id": attached.subscription_id,
            },
        )

    async def _handle_rpc(self, client: _WsClientState, payload: dict[str, Any]) -> None:
        request_id = payload.get("id")
        if not isinstance(request_id, str) or not request_id:
            await self._send_error(client, request_id=None, error=invalid_params("rpc.request.id must be a string", {}))
            return

        if client.attached is None:
            await self._send_error(client, request_id=request_id, error=invalid_params("attach must be completed first", {}))
            return

        method = payload.get("method")
        params = payload.get("params", {})
        if not isinstance(method, str) or not method:
            await self._send_error(client, request_id=request_id, error=invalid_params("rpc.request.method must be a string", {}))
            return
        if not isinstance(params, dict):
            await self._send_error(client, request_id=request_id, error=invalid_params("rpc.request.params must be an object", {}))
            return

        rpc_params = dict(params)
        rpc_params.setdefault("protocol_version", "1.0.0")
        rpc_params.setdefault("request_id", uuid7_str())
        if method in MUTATING_METHODS and "idempotency_key" not in rpc_params:
            rpc_params["idempotency_key"] = make_idempotency_key(prefix="idem-gateway")

        try:
            result = self._bridge.dispatch_rpc(
                connection_id=client.connection_id,
                method=method,
                params=rpc_params,
            )
        except LucidaError as exc:
            await self._send_error(client, request_id=request_id, error=exc)
            return
        except Exception as exc:  # pragma: no cover - defensive fallback
            await self._send_error(
                client,
                request_id=request_id,
                error=internal("Gateway RPC dispatch failed", {"method": method, "error": str(exc)}),
            )
            return

        await self._send_json(
            client,
            {
                "type": "rpc.response",
                "id": request_id,
                "result": result,
            },
        )

    async def _poll_events(self, client: _WsClientState) -> None:
        while not client.ws.closed and client.attached is not None:
            try:
                events = self._bridge.poll_events(
                    connection_id=client.connection_id,
                    limit=256,
                )
                for event in events:
                    await self._send_json(client, {"type": "event", "event": event})
            except asyncio.CancelledError:  # pragma: no cover - task lifecycle
                return
            except LucidaError as exc:
                await self._send_error(client, request_id=None, error=exc)
                if exc.code == "LUCIDA_BUSY":
                    await client.ws.close(code=WSCloseCode.TRY_AGAIN_LATER, message=b"event_backpressure")
                return
            except Exception as exc:  # pragma: no cover - defensive fallback
                await self._send_error(
                    client,
                    request_id=None,
                    error=internal("Gateway event polling failed", {"error": str(exc)}),
                )
                await client.ws.close(code=WSCloseCode.INTERNAL_ERROR, message=b"event_poll_failed")
                return

            await asyncio.sleep(self._config.event_poll_interval_s)

    async def _render_producer(self, client: _WsClientState) -> None:
        interval_s = 1.0 / float(self._config.frame_rate_hz)
        while not client.ws.closed and client.attached is not None:
            try:
                await asyncio.sleep(interval_s)
                if client.render_state is None or client.render_queue is None:
                    continue

                plan_seq, tiles = self._renderer.render_tiles(
                    session_id=client.attached.session_id,
                    view_id=client.attached.view_id,
                    state=client.render_state,
                    lossless=client.lossless,
                )
                if not tiles:
                    continue

                payload = (plan_seq, tiles)
                try:
                    client.render_queue.put_nowait(payload)
                    client.overflow_streak = 0
                except asyncio.QueueFull:
                    client.dropped_frames += 1
                    client.overflow_streak += 1
                    try:
                        _ = client.render_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    try:
                        client.render_queue.put_nowait(payload)
                    except asyncio.QueueFull:
                        pass

                    if client.overflow_streak >= self._config.overflow_close_threshold:
                        await client.ws.close(
                            code=WSCloseCode.TRY_AGAIN_LATER,
                            message=b"render_queue_overflow",
                        )
                        return
            except asyncio.CancelledError:  # pragma: no cover - task lifecycle
                return
            except LucidaError as exc:
                await self._send_error(client, request_id=None, error=exc)
                await client.ws.close(code=WSCloseCode.INTERNAL_ERROR, message=b"render_failed")
                return
            except Exception as exc:  # pragma: no cover - defensive fallback
                await self._send_error(
                    client,
                    request_id=None,
                    error=internal("Gateway render producer failed", {"error": str(exc)}),
                )
                await client.ws.close(code=WSCloseCode.INTERNAL_ERROR, message=b"render_failed")
                return

    async def _render_consumer(self, client: _WsClientState) -> None:
        while not client.ws.closed and client.attached is not None:
            try:
                if client.render_queue is None:
                    await asyncio.sleep(0.05)
                    continue

                plan_seq, tiles = await client.render_queue.get()
                if client.dropped_frames > 0:
                    await self._send_json(
                        client,
                        {
                            "type": "render.status",
                            "state": "dropped",
                            "dropped_frames": client.dropped_frames,
                        },
                    )
                    client.dropped_frames = 0

                frame_id = uuid7_str()
                tile_total = len(tiles)
                for tile_index, tile in enumerate(tiles):
                    await self._send_json(
                        client,
                        {
                            "type": "render.tile",
                            "frame_id": frame_id,
                            "view_id": client.attached.view_id,
                            "tile_index": tile_index,
                            "tile_total": tile_total,
                            "x": tile.x,
                            "y": tile.y,
                            "width": tile.width,
                            "height": tile.height,
                            "format": tile.format,
                            "quality": tile.quality,
                            "plan_seq": plan_seq,
                            "payload_b64": tile.payload_b64,
                        },
                    )
            except asyncio.CancelledError:  # pragma: no cover - task lifecycle
                return
            except Exception as exc:  # pragma: no cover - defensive fallback
                await self._send_error(
                    client,
                    request_id=None,
                    error=internal("Gateway render consumer failed", {"error": str(exc)}),
                )
                await client.ws.close(code=WSCloseCode.INTERNAL_ERROR, message=b"render_send_failed")
                return

    async def _send_error(self, client: _WsClientState, *, request_id: str | None, error: LucidaError) -> None:
        await self._send_json(
            client,
            {
                "type": "rpc.error",
                "id": request_id,
                "error": error.envelope(),
            },
        )

    async def _send_json(self, client: _WsClientState, payload: dict[str, Any]) -> None:
        if client.ws.closed:
            return
        encoded = json.dumps(payload, separators=(",", ":"))
        async with client.send_lock:
            if client.ws.closed:
                return
            await client.ws.send_str(encoded)

    async def _teardown_client(self, client: _WsClientState) -> None:
        for task in client.tasks:
            task.cancel()
        for task in client.tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        client.tasks.clear()

        self._bridge.disconnect(client.connection_id)
        if not client.ws.closed:
            await client.ws.close()
        if client in self._clients:
            self._clients.remove(client)

    async def _on_shutdown(self, _app: web.Application) -> None:
        await asyncio.gather(*(self._teardown_client(client) for client in list(self._clients)), return_exceptions=True)


__all__ = ["WebGatewayServer"]
