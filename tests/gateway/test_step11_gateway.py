from __future__ import annotations

import asyncio
import base64
from pathlib import Path
import sys
import unittest
import uuid

from aiohttp import ClientSession, WSServerHandshakeError, web


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_daemon import default_local_ipc_uri
from lucida_sdk.ids import make_idempotency_key, uuid7_str
from lucida_sdk.registry import clear_local_daemon_registry, launch_or_get_local_daemon

from lucida_gateway import GatewayConfig, WebGatewayServer


class Step11GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        clear_local_daemon_registry()

        app_name = f"lucida-step11-{uuid.uuid4().hex[:8]}"
        self.local_ipc_uri = default_local_ipc_uri(app_name=app_name)
        self.daemon, _created = launch_or_get_local_daemon(local_ipc_uri=self.local_ipc_uri)
        self.session_id, self.view_id = self._seed_image_session()

        self.token = "step11token"
        self.gateway = WebGatewayServer(
            config=GatewayConfig(
                host="127.0.0.1",
                port=8765,
                token=self.token,
                local_ipc_uri=self.local_ipc_uri,
                auto_launch_daemon=False,
            ),
            daemon=self.daemon,
        )

        self.runner = web.AppRunner(self.gateway.app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, host="127.0.0.1", port=0)
        await self.site.start()
        sockets = self.site._server.sockets  # type: ignore[attr-defined]
        assert sockets is not None
        self.port = int(sockets[0].getsockname()[1])
        self.base_http = f"http://127.0.0.1:{self.port}"
        self.base_ws = f"ws://127.0.0.1:{self.port}/v1/ws"

    async def asyncTearDown(self) -> None:
        await self.runner.cleanup()
        clear_local_daemon_registry()

    def _req(self, **kwargs: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "protocol_version": "1.0.0",
            "request_id": uuid7_str(),
        }
        payload.update(kwargs)
        return payload

    def _hello(self, connection_id: str) -> None:
        self.daemon.dispatch(
            connection_id,
            "system.hello",
            self._req(
                client_name="step11-tests",
                client_version="1.0.0",
                supported_versions={"min_version": "1.0.0", "max_version": "1.0.0"},
                transport="ipc",
            ),
        )

    def _seed_image_session(self) -> tuple[str, str]:
        connection_id = self.daemon.connect()
        self._hello(connection_id)

        created = self.daemon.dispatch(
            connection_id,
            "session.create",
            self._req(idempotency_key=make_idempotency_key(prefix="idem-step11-seed-create")),
        )
        session_id = str(created["session_id"])

        self.daemon.dispatch(
            connection_id,
            "dataset.open",
            self._req(
                idempotency_key=make_idempotency_key(prefix="idem-step11-seed-open"),
                session_id=session_id,
                uri="synthetic://image-large",
                read_only=True,
            ),
        )

        snapshot = self.daemon.snapshot()
        session = next(item for item in snapshot["sessions"] if item["session_id"] == session_id)
        view_id = sorted(session["views"])[0]
        dataset_id = sorted(session["datasets"])[0]

        added = self.daemon.dispatch(
            connection_id,
            "layer.add_image",
            self._req(
                idempotency_key=make_idempotency_key(prefix="idem-step11-seed-layer"),
                session_id=session_id,
                dataset_id=dataset_id,
                channel=0,
            ),
        )
        layer_id = str(added["layer_id"])

        self.daemon.dispatch(
            connection_id,
            "view.bind_layer",
            self._req(
                idempotency_key=make_idempotency_key(prefix="idem-step11-seed-bind"),
                session_id=session_id,
                view_id=view_id,
                layer_id=layer_id,
            ),
        )

        self.daemon.disconnect(connection_id)
        return session_id, view_id

    async def _recv_until(self, ws, *, timeout_s: float = 3.0, frame_type: str | None = None):
        deadline = asyncio.get_running_loop().time() + timeout_s
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for frame_type={frame_type!r}")
            msg = await asyncio.wait_for(ws.receive_json(), timeout=remaining)
            if frame_type is None or msg.get("type") == frame_type:
                return msg

    async def test_healthz(self) -> None:
        async with ClientSession() as session:
            async with session.get(f"{self.base_http}/healthz") as response:
                self.assertEqual(response.status, 200)
                payload = await response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["step"], "step-11")

    async def test_ws_requires_token(self) -> None:
        async with ClientSession() as session:
            with self.assertRaises(WSServerHandshakeError) as ctx:
                await session.ws_connect(self.base_ws)
        self.assertEqual(ctx.exception.status, 401)

    async def test_attach_rpc_and_render_tile_stream(self) -> None:
        async with ClientSession() as session:
            ws = await session.ws_connect(f"{self.base_ws}?token={self.token}")
            try:
                await ws.send_json(
                    {
                        "type": "attach",
                        "session_id": self.session_id,
                        "view_id": self.view_id,
                        "client_name": "step11-browser",
                        "client_version": "0.1.0",
                    }
                )
                attached = await self._recv_until(ws, frame_type="attach.ok")
                self.assertEqual(attached["session_id"], self.session_id)

                await ws.send_json(
                    {
                        "type": "rpc.request",
                        "id": "rpc-session-get",
                        "method": "session.get",
                        "params": {"session_id": self.session_id},
                    }
                )
                response = await self._recv_until(ws, frame_type="rpc.response")
                self.assertEqual(response["id"], "rpc-session-get")
                self.assertEqual(response["result"]["session_id"], self.session_id)

                tile = await self._recv_until(ws, frame_type="render.tile", timeout_s=4.0)
                self.assertEqual(tile["view_id"], self.view_id)
                decoded = base64.b64decode(tile["payload_b64"])
                self.assertGreater(len(decoded), 0)
                self.assertIn(tile["format"], {"jpeg", "png"})
            finally:
                await ws.close()

    async def test_single_controller_lock(self) -> None:
        async with ClientSession() as session:
            ws_one = await session.ws_connect(f"{self.base_ws}?token={self.token}")
            ws_two = await session.ws_connect(f"{self.base_ws}?token={self.token}")
            try:
                await ws_one.send_json(
                    {
                        "type": "attach",
                        "session_id": self.session_id,
                        "view_id": self.view_id,
                        "client_name": "controller-a",
                        "client_version": "0.1.0",
                    }
                )
                _ = await self._recv_until(ws_one, frame_type="attach.ok")

                await ws_two.send_json(
                    {
                        "type": "attach",
                        "session_id": self.session_id,
                        "view_id": self.view_id,
                        "client_name": "controller-b",
                        "client_version": "0.1.0",
                    }
                )
                err = await self._recv_until(ws_two, frame_type="rpc.error")
                self.assertEqual(err["error"]["code"], "LUCIDA_CONFLICT")
            finally:
                await ws_one.close()
                await ws_two.close()

    async def test_rpc_rejects_cross_session_dispatch(self) -> None:
        async with ClientSession() as session:
            ws = await session.ws_connect(f"{self.base_ws}?token={self.token}")
            try:
                await ws.send_json(
                    {
                        "type": "attach",
                        "session_id": self.session_id,
                        "view_id": self.view_id,
                        "client_name": "step11-browser",
                        "client_version": "0.1.0",
                    }
                )
                _ = await self._recv_until(ws, frame_type="attach.ok")

                await ws.send_json(
                    {
                        "type": "rpc.request",
                        "id": "rpc-bad-session",
                        "method": "session.get",
                        "params": {"session_id": "0194c8f0-c7fa-7a2d-8abc-000000000000"},
                    }
                )
                err = await self._recv_until(ws, frame_type="rpc.error")
                self.assertEqual(err["id"], "rpc-bad-session")
                self.assertEqual(err["error"]["code"], "LUCIDA_CONFLICT")
            finally:
                await ws.close()


if __name__ == "__main__":
    unittest.main()
