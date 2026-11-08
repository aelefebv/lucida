"""The Python client against a real lucida-server: a view change one client
makes is there for a second client afterwards, and for a page that opens the
same viewer profile.

The server binary comes from ``LUCIDA_SERVER_BIN``, else from a cargo build in
the repository's ``target/``. Without one the tests skip, unless
``LUCIDA_REQUIRE_SERVER_TESTS`` is set, as CI sets it.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import urlopen

import pytest

from support import ROOT

pytest.importorskip("lucida.lucida")

from lucida.client import LucidaClient, LucidaError  # noqa: E402

DATASET = ROOT.parent / "fixtures" / "ome-zarr" / "twin-unsharded.ome.zarr"


def server_binary() -> Path | None:
    configured = os.environ.get("LUCIDA_SERVER_BIN")
    if configured:
        return Path(configured)
    name = "lucida-server.exe" if os.name == "nt" else "lucida-server"
    for profile in ("debug", "release"):
        candidate = ROOT.parent / "target" / profile / name
        if candidate.exists():
            return candidate
    return None


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def server_url(tmp_path):
    binary = server_binary()
    if binary is None:
        message = "no lucida-server build; set LUCIDA_SERVER_BIN or `cargo build -p lucida-server`"
        if os.environ.get("LUCIDA_REQUIRE_SERVER_TESTS"):
            pytest.fail(message)
        pytest.skip(message)

    port = free_port()
    # A loopback bind runs with auth disabled, and the database defaults to a
    # file in the working directory. The caller's own LUCIDA_* settings must
    # not reach this server.
    env = {key: value for key, value in os.environ.items() if not key.startswith("LUCIDA_")}
    env.update(
        {
            "LUCIDA_BIND": f"127.0.0.1:{port}",
            "LUCIDA_GENERATED_COARSE_CACHE_DIR": str(tmp_path / "generated-coarse"),
            "LUCIDA_GENERATED_COARSE_CACHE_DIR": str(tmp_path / "coarse-cache"),
        }
    )
    log_path = tmp_path / "server.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [str(binary)], cwd=tmp_path, env=env, stdout=log, stderr=subprocess.STDOUT
        )
        url = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    pytest.fail(f"lucida-server exited early:\n{log_path.read_text()}")
                try:
                    with urlopen(f"{url}/healthz", timeout=2):
                        break
                except (URLError, ConnectionError):
                    if time.monotonic() > deadline:
                        pytest.fail(f"lucida-server never became healthy:\n{log_path.read_text()}")
                    time.sleep(0.1)
            yield url
        finally:
            process.terminate()
            process.wait(timeout=10)


def client(url: str, tmp_path: Path, name: str) -> LucidaClient:
    return LucidaClient(url, token=None, config_path=tmp_path / f"{name}.json")


def page_view(url: str, workspace_id: str, profile: str) -> dict:
    """What a page opened with ``?viewer_profile=`` reads."""
    path = f"/api/workspaces/{quote(workspace_id)}/viewer-profiles/{quote(profile)}"
    with urlopen(url + path, timeout=10) as response:
        return json.loads(response.read())["view"]


def test_a_python_view_change_persists_for_a_second_client(server_url, tmp_path):
    first = client(server_url, tmp_path, "first").workspaces.create("viewer-profile")
    opened = first.datasets.open(str(DATASET.resolve()))
    dataset_id = opened["workspace_dataset_id"]

    start = first.viewer.state()["camera"]
    first.view.pan(40.0, -20.0)
    first.layer.opacity(dataset_id, 0.5)
    first.channel.colormap(dataset_id, 1, "viridis")
    first.layer.contrast(dataset_id, 5.0, 60.0, channel=0)

    second = client(server_url, tmp_path, "second").workspaces.get(first.id)
    seen = second.viewer.state()

    zoom = start["zoom"]
    assert seen["camera"]["center"] == pytest.approx(
        [start["center"][0] + 40.0 / zoom, start["center"][1] - 20.0 / zoom]
    )
    settings = seen["dataset_settings"][dataset_id]
    assert settings["opacity"] == 0.5
    assert settings["channel_settings"][1]["colormap"] == "viridis"
    assert settings["channel_settings"][0]["contrast_max"] == 60.0

    page = page_view(server_url, first.id, "default")
    assert page["camera"] == seen["camera"]
    assert page["dataset_settings"][dataset_id] == settings
    assert page["auto_contrast"] == {dataset_id: False}
    assert seen["web_url"] == f"{server_url}/w/{first.id}?viewer_profile=default"


def assert_same_camera(a: dict, b: dict) -> None:
    """The same camera, its numbers to the last bit or two: a camera crosses
    the server as JSON, whose float parse need not round the last bit back."""
    assert a.keys() == b.keys()
    for key, value in a.items():
        if isinstance(value, str):
            assert value == b[key], key
        else:
            assert value == pytest.approx(b[key], rel=1e-12, abs=1e-15), key


def test_a_3d_camera_persists_and_rejected_changes_store_nothing(server_url, tmp_path):
    first = client(server_url, tmp_path, "first").workspaces.create("viewer-3d")
    dataset_id = first.datasets.open(str(DATASET.resolve()))["workspace_dataset_id"]

    rotated = first.camera.rotate(0.6, 0.2)
    with pytest.raises(LucidaError) as error:
        first.channel.visible(dataset_id, 7, False)
    assert error.value.kind == "missing_resource"

    seen = client(server_url, tmp_path, "second").workspaces.get(first.id).viewer.state()
    assert seen["camera"]["mode"] == "arcball"
    assert_same_camera(seen["camera"], rotated["camera"])
    assert seen["updated_at"] == rotated["updated_at"]
