from __future__ import annotations

import json
from pathlib import Path

import pytest

# The pyo3 `explore` lives in the compiled extension; build it with
# `uv run maturin develop`. Skip cleanly if it isn't present.
lucida = pytest.importorskip("lucida.lucida")

# The datasets the core's view property suite runs over, one `DatasetOpened`
# per entry, so these tests explore the same data as every other client's.
FIXTURES = {
    entry["name"]: entry["opened"]["manifest"]
    for entry in json.loads(
        (
            Path(__file__).resolve().parents[2] / "fixtures" / "view-properties" / "datasets.json"
        ).read_text()
    )
}


def document(*names: str) -> str:
    """A workspace document holding the named fixtures."""
    return json.dumps(
        {"manifests": {FIXTURES[name]["dataset_id"]: FIXTURES[name] for name in names}}
    )


def explore(name: str, *args):
    return json.loads(lucida.explore(document(name), FIXTURES[name]["dataset_id"], *args))


def test_explore_default_view_volume_sidecar_shape():
    # A 3D volume started from its Home view (view_json omitted).
    sidecar = explore("volume", (800, 600))

    # Version + current node.
    assert sidecar["v"] == 1
    current = sidecar["current"]
    assert current["handle"].startswith("vh-")
    assert "view" in current

    # Cells: at least one, each fully formed.
    cells = sidecar["cells"]
    assert len(cells) >= 1
    for cell in cells:
        assert cell["transform"]
        assert cell["label"]
        assert cell["handle"].startswith("vh-")
        assert "view" in cell

    # A 3D volume's Home is an Arcball, so some rotate (azimuth) cell appears.
    transforms = [cell["transform"] for cell in cells]
    assert any(t.startswith("azimuth:") for t in transforms)


def test_explore_home_frames_the_volume_in_world_space():
    # A volume camera works in normalized world space, so Home looks at the
    # middle of the world box, not at the voxel box's middle.
    camera = explore("volume", (800, 600))["current"]["view"]["camera"]
    assert camera["mode"] == "arcball"
    assert all(abs(c) < 2.0 for c in camera["target"]), camera["target"]


def test_explore_flat_dataset_has_no_azimuth_or_stepz():
    # A flat 2D image: a Slice Home, so no azimuth and no Z-step cells.
    sidecar = explore("image", (800, 600))
    transforms = [cell["transform"] for cell in sidecar["cells"]]
    assert not any(t.startswith("azimuth:") for t in transforms)
    assert not any(t.startswith("stepz:") for t in transforms)


def test_explore_home_of_a_collection_frames_every_tile():
    # Home fits the whole collection, not its first tile.
    camera = explore("collection", (800, 600))["current"]["view"]["camera"]
    assert camera["mode"] == "slice"
    # Four tiles across at a 288-sample pitch, three down: the middle of the grid.
    assert camera["center"] == [(3 * 288 + 256) / 2, (2 * 288 + 256) / 2]


def test_explore_sidecar_carries_extent_and_cell_ztc():
    # Parity with the CLI: the core sidecar carries the dataset `extent` and
    # each cell's destination `z`/`t`/`c`, so the Python surface gets the same
    # orientation without re-deriving it from each cell's `view`.
    sidecar = explore("volume", (800, 600))

    # Top-level extent: the voxel box and the axis counts.
    extent = sidecar["extent"]
    assert extent["z_count"] == 128
    assert extent["t_count"] == 2
    assert extent["c_count"] == 3
    assert extent["max"] == [512.0, 512.0, 128.0]
    assert extent["min"] == [0.0, 0.0, 0.0]

    # Each cell carries z/t matching its own child view's destination indices,
    # and `c` only when the child solos a channel.
    for cell in sidecar["cells"]:
        assert cell["z"] == cell["view"]["view"]["z_range"]["start"]
        assert cell["t"] == cell["view"]["view"]["t"]
        solos = [s.get("solo") for s in cell["view"]["dataset_settings"].values()]
        solo = next((s for s in solos if s is not None), None)
        assert cell.get("c") == solo
    # From the composite, the next channel step solos the first channel.
    stepc = next(cell for cell in sidecar["cells"] if cell["transform"] == "stepc:+1")
    assert stepc["c"] == 0


def test_explore_descend_from_supplied_view_carries_breadcrumb():
    # Descend: feed a child's `view` back in, with an explicit depth/breadcrumb.
    root = explore("volume", (800, 600))
    child_view = root["cells"][0]["view"]
    nxt = explore(
        "volume",
        (800, 600),
        json.dumps(child_view),
        1,
        ["Home (fit dataset)"],
    )
    assert nxt["current"]["depth"] == 1
    assert nxt["current"]["breadcrumb"] == ["Home (fit dataset)"]


def test_explore_rejects_malformed_view_json():
    with pytest.raises(ValueError):
        explore("volume", (800, 600), "{not json")


def test_explore_rejects_a_dataset_the_document_lacks():
    with pytest.raises(ValueError):
        lucida.explore(document("volume"), "ghost", (800, 600))
