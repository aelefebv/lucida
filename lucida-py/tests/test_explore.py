from __future__ import annotations

import json

import pytest

# The pyo3 `explore` lives in the compiled extension; build it with
# `uv run maturin develop`. Skip cleanly if it isn't present.
lucida = pytest.importorskip("lucida.lucida")


def test_explore_default_view_volume_sidecar_shape():
    # A 3D volume started from its Home view (view_json omitted).
    raw = lucida.explore("wds-x", (1, 1, 340, 512, 512), (800, 600))
    sidecar = json.loads(raw)

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


def test_explore_flat_dataset_has_no_azimuth_or_stepz():
    # A flat 2D image: a Slice Home, so no azimuth and no Z-step cells.
    raw = lucida.explore("wds-flat", (1, 3, 1, 1024, 1024), (800, 600))
    sidecar = json.loads(raw)
    transforms = [cell["transform"] for cell in sidecar["cells"]]
    assert not any(t.startswith("azimuth:") for t in transforms)
    assert not any(t.startswith("stepz:") for t in transforms)


def test_explore_sidecar_carries_extent_and_cell_ztc():
    # Parity with the CLI: the core sidecar now carries the dataset `extent` and
    # each cell's destination `z`/`t`/`c`, so the Python surface gets the same
    # orientation without re-deriving it from each cell's `view`.
    raw = lucida.explore("wds-x", (5, 3, 40, 80, 100), (800, 600))
    sidecar = json.loads(raw)

    # Top-level extent: the [T, C, Z, Y, X] dims mapped to bounds + counts.
    extent = sidecar["extent"]
    assert extent["z_count"] == 40
    assert extent["t_count"] == 5
    assert extent["c_count"] == 3
    assert extent["max"] == [100.0, 80.0, 40.0]
    assert extent["min"] == [0.0, 0.0, 0.0]

    # Each cell carries z/t/c matching its own child view's destination indices.
    for cell in sidecar["cells"]:
        assert cell["z"] == cell["view"]["view"]["z_range"]["start"]
        assert cell["t"] == cell["view"]["view"]["t"]
        assert cell["c"] == cell["view"]["view"]["c"]


def test_explore_descend_from_supplied_view_carries_breadcrumb():
    # Descend: feed a child's `view` back in, with an explicit depth/breadcrumb.
    root = json.loads(lucida.explore("wds-x", (1, 1, 40, 128, 128), (800, 600)))
    child_view = root["cells"][0]["view"]
    next_raw = lucida.explore(
        "wds-x",
        (1, 1, 40, 128, 128),
        (800, 600),
        json.dumps(child_view),
        1,
        ["Home (fit dataset)"],
    )
    nxt = json.loads(next_raw)
    assert nxt["current"]["depth"] == 1
    assert nxt["current"]["breadcrumb"] == ["Home (fit dataset)"]


def test_explore_rejects_malformed_view_json():
    with pytest.raises(ValueError):
        lucida.explore("wds-x", (1, 1, 40, 128, 128), (800, 600), "{not json")
