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
