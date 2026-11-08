#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8"]
# ///
"""Tests for the perf runner's catalog, scenarios, suites, matrix and table.

Run with ``uv run scripts/test_perf.py``. Nothing here builds, starts a
server or launches a browser. Whether each scenario's steps are steps the
CLI can run is the CLI's own test, beside its script parser.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import perf  # noqa: E402

CATALOG = perf.load_catalog(perf.PERF_DIR / "datasets.json", None)
SCENARIOS = perf.load_scenarios(perf.PERF_DIR / "scenarios")
SUITES = perf.load_suites(perf.PERF_DIR / "suites.json", CATALOG, SCENARIOS)


def plan(**selection):
    return perf.plan(perf.Selection(**selection), CATALOG, SCENARIOS, SUITES)


def write(path: Path, value) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


# -- the catalog -------------------------------------------------------------


def test_the_catalog_has_every_shape_the_matrix_needs() -> None:
    traits = {name: dataset.traits for name, dataset in CATALOG.items()}
    assert traits["large-image"] == frozenset()
    assert traits["image"] == {"channels"}
    assert traits["large-volume"] == {"volume"}
    assert traits["volume"] == {"volume", "channels"}
    assert traits["timeseries-2d"] == {"time"}
    assert traits["timeseries-3d"] == {"volume", "time", "channels"}
    assert traits["collection"] == {"collection", "channels"}
    for name in ("single-level", "sharded", "float32", "anisotropic", "sparse"):
        assert name in CATALOG


def test_the_gates_datasets_keep_the_gates_generator_options() -> None:
    gate = Path(perf.REPO / "scripts" / "trace_gate.sh").read_text(encoding="utf-8")
    for name in ("image", "volume", "collection", "single-level"):
        assert f'"{name}|{" ".join(CATALOG[name].generate)}"' in gate


def test_a_local_catalog_merges_real_datasets_in(tmp_path: Path) -> None:
    local = write(
        tmp_path / "local.json",
        {"datasets": {"real": {"url": "/data/real.ome.zarr", "traits": ["volume", "time"], "description": "x"}}},
    )
    catalog = perf.load_catalog(perf.PERF_DIR / "datasets.json", local)
    assert catalog["real"].traits == {"volume", "time"}
    assert catalog["real"].url == "/data/real.ome.zarr"
    assert perf.dataset_location(catalog["real"], tmp_path) == "/data/real.ome.zarr"
    assert set(CATALOG) < set(catalog)


def test_a_missing_local_catalog_is_no_error(tmp_path: Path) -> None:
    assert perf.load_catalog(perf.PERF_DIR / "datasets.json", tmp_path / "absent.json") == CATALOG


@pytest.mark.parametrize(
    ("entry", "message"),
    [
        ({"url": "/x", "traits": ["depth"]}, "unknown trait depth"),
        ({"url": "/x"}, "a local dataset has a url, its traits"),
        ({"traits": []}, "a local dataset has a url, its traits"),
        ({"url": "/x", "traits": [], "camera": "slice"}, "a local dataset has a url, its traits"),
    ],
)
def test_a_malformed_local_entry_is_refused(tmp_path: Path, entry, message: str) -> None:
    local = write(tmp_path / "local.json", {"datasets": {"real": entry}})
    with pytest.raises(perf.PerfError, match=message):
        perf.load_catalog(perf.PERF_DIR / "datasets.json", local)


def test_a_local_entry_cannot_shadow_a_generated_one(tmp_path: Path) -> None:
    local = write(tmp_path / "local.json", {"datasets": {"volume": {"url": "/x", "traits": []}}})
    with pytest.raises(perf.PerfError, match="already has a dataset called volume"):
        perf.load_catalog(perf.PERF_DIR / "datasets.json", local)


def test_a_generated_dataset_is_cached_by_its_options(tmp_path: Path) -> None:
    volume = CATALOG["volume"]
    location = perf.dataset_location(volume, tmp_path)
    assert location == perf.dataset_location(volume, tmp_path)
    assert location.startswith((tmp_path / "volume-").as_posix())
    changed = perf.Dataset("volume", "", volume.traits, generate=(*volume.generate, "--seed", "1"))
    assert perf.dataset_location(changed, tmp_path) != location


def test_a_new_copy_prunes_only_its_own_datasets_earlier_copies(tmp_path: Path) -> None:
    names = [
        "volume-0123456789ab.ome.zarr",
        "volume-ba9876543210.ome.zarr.partial",
        "large-volume-0123456789ab.ome.zarr",
        "volume-mono-0123456789ab.ome.zarr",
    ]
    for name in names:
        (tmp_path / name).mkdir()
    perf.prune_earlier("volume", tmp_path)
    assert sorted(p.name for p in tmp_path.iterdir()) == names[2:]


# -- scenarios ---------------------------------------------------------------


def test_scenarios_name_what_they_need() -> None:
    needs = {name: scenario.requires for name, scenario in SCENARIOS.items()}
    assert needs["cold-open"] == frozenset()
    assert needs["pan-sweep"] == frozenset()
    assert needs["zoom-in-out"] == frozenset()
    assert needs["z-scrub"] == {"volume"}
    assert needs["t-scrub"] == {"time"}
    assert needs["orbit"] == {"volume"}
    assert needs["channel-solo"] == {"channels"}
    assert needs["channel-toggle"] == {"channels"}
    assert SCENARIOS["orbit"].camera == "arcball"


@pytest.mark.parametrize(
    ("scenario", "message"),
    [
        ({"steps": [], "camera": "orthographic"}, "camera 'orthographic'"),
        ({"steps": [], "requires": ["depth"]}, "unknown trait depth"),
        ({"steps": [{"dx": 1}]}, "each with a kind"),
        ({"steps": [], "applies": ["volume"]}, "unknown key applies"),
        ({"steps": [], "width": 0}, "width is a positive whole number"),
    ],
)
def test_a_malformed_scenario_is_refused(tmp_path: Path, scenario, message: str) -> None:
    with pytest.raises(perf.PerfError, match=message):
        perf.load_scenario(write(tmp_path / "bad.json", scenario))


# -- the matrix --------------------------------------------------------------


def test_no_scenario_runs_on_a_dataset_it_does_not_apply_to() -> None:
    cases, skipped = plan(suite="full")
    for case in cases:
        assert case.scenario.requires <= case.dataset.traits, case.id
    assert ("large-image", "orbit") in skipped
    assert ("image", "t-scrub") in skipped
    assert ("timeseries-2d", "z-scrub") in skipped
    assert ("large-volume", "channel-solo") in skipped


def test_the_full_suite_runs_every_dataset_at_ratios_1_and_2() -> None:
    cases, _ = plan(suite="full")
    for name in CATALOG:
        assert {case.ratio for case in cases if case.dataset.name == name} == {1.0, 2.0}, name
    for name in SCENARIOS:
        assert any(case.scenario.name == name for case in cases), name


def test_no_selection_is_the_quick_suite() -> None:
    cases, _ = plan()
    assert {case.dataset.name for case in cases} == set(SUITES["quick"].datasets)
    assert {case.id for case in cases} >= {"volume.orbit.dpr1", "volume.orbit.dpr2", "large-image.cold-open.dpr2"}
    assert "large-image.orbit.dpr1" not in {case.id for case in cases}


def test_flags_override_one_dimension_of_a_suite_and_leave_the_rest() -> None:
    cases, _ = plan(suite="quick", ratios=[2.0])
    assert {case.ratio for case in cases} == {2.0}
    assert {case.dataset.name for case in cases} == set(SUITES["quick"].datasets)

    cases, _ = plan(scenarios=["t-scrub"])
    assert {case.dataset.name for case in cases} == {"timeseries-2d", "timeseries-3d"}
    assert {case.ratio for case in cases} == {1.0, 2.0}


def test_repeats_each_get_a_run_of_their_own() -> None:
    cases, _ = plan(datasets=["image"], scenarios=["cold-open"], ratios=[1.0], repeat=3)
    assert [case.id for case in cases] == ["image.cold-open.dpr1", "image.cold-open.dpr1.2", "image.cold-open.dpr1.3"]


@pytest.mark.parametrize(
    ("selection", "message"),
    [
        ({"datasets": ["nope"]}, "no dataset called nope; the datasets are large-image"),
        ({"scenarios": ["spin"]}, "no scenario called spin; the scenarios are"),
        ({"suite": "nightly"}, "no suite called nightly; the suites are quick, full"),
        ({"datasets": ["image"], "scenarios": ["orbit"]}, "orbit needs volume, so it skips image"),
        ({"repeat": 0, "datasets": ["image"]}, "--repeat is at least 1"),
    ],
)
def test_a_selection_that_cannot_run_says_why(selection, message: str) -> None:
    with pytest.raises(perf.PerfError, match=message):
        plan(**selection)


def test_a_suite_naming_an_unknown_dataset_is_refused(tmp_path: Path) -> None:
    suites = write(tmp_path / "suites.json", {"suites": {"s": {"datasets": ["gone"], "scenarios": "all"}}})
    with pytest.raises(perf.PerfError, match="no dataset called gone"):
        perf.load_suites(suites, CATALOG, SCENARIOS)


@pytest.mark.parametrize("text", ["0", "-1", "two"])
def test_a_ratio_is_a_positive_number(text: str) -> None:
    with pytest.raises(perf.PerfError):
        perf.parse_ratio(text)


# -- reading runs and the table ----------------------------------------------


def run_file(tmp_path: Path, diagnostic, script=None) -> Path:
    header = {"settled": True}
    if script is not None:
        header["script"] = {"steps": script}
    return write(tmp_path / "run.json", {"fileVersion": 1, "header": header, "diagnostic": diagnostic, "trace": {}})


DIAGNOSTIC = {
    "runId": "run-3",
    "verdict": {"kind": "clear", "text": "settled"},
    "run": {"gpu": "nvidia ampere", "adapterKind": {"kind": "hardware", "label": "hardware adapter"}},
    "attribution": {"cause": "fetch.wire", "confidence": "attributed"},
    "load": {"firstFrameMs": 212.4, "settleMs": 1840.0, "received": {"bytes": 12_400_000, "requests": 96}},
    "coverage": {"notHealthSignals": [{"metric": "retries", "value": 0}, {"metric": "evictions", "value": 7}]},
}


def test_a_row_is_read_off_the_run_files_diagnostic(tmp_path: Path) -> None:
    script = [{"kind": "orbit", "runId": "run-2", "verdict": {"kind": "clear"}}, {"kind": "wait", "runId": None}]
    fields = perf.read_run(run_file(tmp_path, DIAGNOSTIC, script))
    assert fields["firstFrameMs"] == 212.4
    assert fields["settleMs"] == 1840.0
    assert fields["bytesFetched"] == 12_400_000
    assert fields["chunksFetched"] == 96
    assert fields["chunksEvicted"] == 7
    assert fields["topLimiter"] == "fetch.wire"
    assert fields["verdict"] == "clear"
    assert fields["steps"] == [
        {"kind": "orbit", "runId": "run-2", "verdict": "clear"},
        {"kind": "wait", "runId": None, "verdict": None},
    ]


def test_a_field_the_diagnostic_lacks_is_a_dash_not_a_number(tmp_path: Path) -> None:
    path = run_file(tmp_path, {"verdict": {"kind": "unsettled"}})
    case = perf.Case(CATALOG["image"], SCENARIOS["cold-open"], 2.0, 1)
    row = perf.Row(case, path, tmp_path / "run.txt", exit_code=0, fields=perf.read_run(path))
    cells = dict(zip(perf.COLUMNS, perf.table_cells(row, tmp_path)))
    assert cells["first frame"] == cells["settle"] == cells["fetched"] == cells["top limiter"] == "-"
    assert cells["verdict"] == "unsettled"
    assert cells["run"] == "run.json"


def test_the_markdown_table_names_the_adapter_and_one_row_per_run(tmp_path: Path) -> None:
    path = run_file(tmp_path, DIAGNOSTIC)
    ok = perf.Row(perf.Case(CATALOG["image"], SCENARIOS["cold-open"], 1.0, 1), path, tmp_path / "a.txt", 0)
    ok.fields = perf.read_run(path)
    (tmp_path / "b.txt").write_text("error: the server refused | the open\n", encoding="utf-8")
    failed = perf.Row(
        perf.Case(CATALOG["volume"], SCENARIOS["orbit"], 2.0, 1), tmp_path / "b.json", tmp_path / "b.txt", 1
    )
    failed.error = perf._first_error_line(failed.log)
    markdown = perf.render_markdown([ok, failed], tmp_path)
    lines = markdown.splitlines()
    assert lines[0] == "adapter: nvidia ampere (hardware adapter)"
    assert "| image | cold-open | 1 | 212 ms | 1,840 ms | 12.4 MB | 96 | 7 | fetch.wire (attributed) | clear |" in markdown
    assert "| error: the server refused \\| the open |" in markdown
    # The header, its rule, and one row per run.
    assert len([line for line in lines if line.startswith("|")]) == 4


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", *sys.argv[1:]]))
