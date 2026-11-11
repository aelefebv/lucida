"""Two datasets side by side in linked views, set up through the Python client
against a real server and captured whole and view by view.

Besides a server build, this needs the web bundle (``LUCIDA_WEB_DIST``, else
``lucida-web/dist``), the CLI (``LUCIDA_CLI``, else a cargo build in
``target/``) and Chrome; without the bundle or the CLI it skips.
"""

from __future__ import annotations

import os
import struct
from pathlib import Path

import pytest

from support import ROOT, running_server

pytest.importorskip("lucida.lucida")

from lucida.client import LucidaClient  # noqa: E402

FIXTURES = ROOT.parent / "fixtures" / "ome-zarr"


def web_dist() -> Path | None:
    dist = Path(os.environ.get("LUCIDA_WEB_DIST") or ROOT.parent / "lucida-web" / "dist")
    return dist if (dist / "index.html").exists() else None


def cli_binary() -> str | None:
    if configured := os.environ.get("LUCIDA_CLI"):
        return configured
    name = "lucida.exe" if os.name == "nt" else "lucida"
    for profile in ("release", "debug"):
        candidate = ROOT.parent / "target" / profile / name
        if candidate.exists():
            return str(candidate)
    return None


@pytest.fixture
def capture_server(tmp_path, monkeypatch):
    dist, cli = web_dist(), cli_binary()
    if dist is None or cli is None:
        pytest.skip("captures need the web bundle and the lucida CLI built")
    monkeypatch.setenv("LUCIDA_CLI", cli)
    with running_server(tmp_path, {"LUCIDA_WEB_DIST": str(dist)}) as url:
        yield url


def png_size(path: Path) -> tuple[int, int]:
    return struct.unpack(">II", path.read_bytes()[16:24])


def test_two_datasets_side_by_side_linked_and_captured(capture_server, tmp_path):
    client = LucidaClient(capture_server, token=None, config_path=tmp_path / "config.json")
    workspace = client.workspaces.create("side by side")
    first = workspace.datasets.open(str(FIXTURES / "twin-unsharded.ome.zarr"))
    second = workspace.datasets.open(str(FIXTURES / "twin-sharded.ome.zarr"))
    a, b = first["workspace_dataset_id"], second["workspace_dataset_id"]

    laid_out = workspace.view.layout("columns", [a, b])
    assert [view["datasets"] for view in laid_out["views"]["views"]] == [
        {"only": [a]},
        {"only": [b]},
    ]
    modes = {link["property"]: link["mode"] for link in laid_out["links"]["properties"]}
    assert modes["pan"] == modes["zoom"] == "linked"

    zoomed = workspace.view.zoom(2.0, view=1)
    cameras = [view["camera"] for view in zoomed["views"]["views"]]
    assert cameras[0]["zoom"] == pytest.approx(cameras[1]["zoom"])

    report = workspace.viewer.screenshot(tmp_path / "pair.png", each_view=True)
    captured = {image.get("view"): Path(image["output"]) for image in report["captured"]}
    assert sorted(captured, key=str) == sorted([None, 0, 1], key=str)
    assert png_size(captured[None]) == (1200, 800)
    assert png_size(captured[0]) == png_size(captured[1]) == (600, 800)
