from __future__ import annotations

import asyncio
import inspect
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from lucida.client import (  # noqa: E402
    AuthResource,
    ChannelResource,
    DatasetsResource,
    DebugResource,
    HttpResponse,
    LayerResource,
    LucidaClient,
    SavedViewsResource,
    ServerResource,
    ViewResource,
    ViewerProfilesResource,
    WorkspaceResource,
    WorkspacesResource,
)

try:
    from lucida.lucida import read_keychain_token as native_keychain_reader  # noqa: E402
except ModuleNotFoundError:
    native_keychain_reader = None


PUBLIC_SYNC_ASYNC_SURFACE = {
    LucidaClient: ["status", "whoami", "workspace"],
    ServerResource: ["status"],
    AuthResource: ["whoami"],
    WorkspacesResource: ["list", "create", "get", "open", "resolve", "use"],
    WorkspaceResource: ["refresh", "open", "snapshot"],
    ViewerProfilesResource: ["get", "put", "mutate"],
    DatasetsResource: ["list", "info", "explore", "open", "health", "retry"],
    ViewResource: ["pan", "zoom", "set_zoom", "center", "slice", "z_range", "viewport_size"],
    LayerResource: ["list", "order", "visible", "opacity", "contrast", "gamma"],
    ChannelResource: ["mode", "visible", "colormap", "contrast", "gamma"],
    DebugResource: ["state"],
    SavedViewsResource: ["list", "get", "create", "set_visibility", "approve", "reject"],
}


@pytest.mark.skipif(native_keychain_reader is None, reason="native extension not installed")
def test_native_extension_exports_non_subprocess_keychain_reader():
    assert callable(native_keychain_reader)


def test_every_supported_sync_operation_has_a_named_async_peer():
    for resource, method_names in PUBLIC_SYNC_ASYNC_SURFACE.items():
        for method_name in method_names:
            sync_method = getattr(resource, method_name)
            async_method = getattr(resource, f"async_{method_name}")
            assert not inspect.iscoroutinefunction(sync_method)
            assert inspect.iscoroutinefunction(async_method)
            assert list(inspect.signature(sync_method).parameters) == list(
                inspect.signature(async_method).parameters
            )


def test_named_http_async_method_runs_without_blocking_an_active_event_loop(tmp_path):
    class Transport:
        def request(self, *_args, **_kwargs):
            return HttpResponse(
                status=200,
                body=json.dumps({"email": "dev@example.test", "is_admin": False}).encode(),
                headers={"content-type": "application/json"},
            )

    client = LucidaClient(
        "http://127.0.0.1:9876",
        token="test-token",
        config_path=tmp_path / "config.json",
        transport=Transport(),
    )

    async def exercise():
        loop_progressed = asyncio.Event()

        async def tick():
            await asyncio.sleep(0)
            loop_progressed.set()

        tick_task = asyncio.create_task(tick())
        principal = await client.auth.async_whoami()
        await tick_task
        assert loop_progressed.is_set()
        assert principal["email"] == "dev@example.test"

    asyncio.run(exercise())
