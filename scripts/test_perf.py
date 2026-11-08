#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["pytest>=8", "pyyaml>=6"]
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
import yaml

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


def test_the_gate_suite_opens_each_shape_cold_at_ratios_1_and_2() -> None:
    cases, _ = plan(suite="gate")
    assert [case.id for case in cases] == [
        f"{run}.dpr{ratio}"
        for run in (
            "image.cold-open",
            "volume.cold-open",
            "volume.volume-open-small",
            "collection.cold-open",
            "single-level.cold-open",
        )
        for ratio in (1, 2)
    ]
    for case in cases:
        assert not case.scenario.steps, case.id
    cold, small = SCENARIOS["cold-open"], SCENARIOS["volume-open-small"]
    assert (cold.camera, cold.width, cold.height) == ("slice", None, None)
    assert (small.camera, small.width, small.height) == ("arcball", 480, 300)


def test_the_trace_gate_workflow_runs_every_gate_dataset_once() -> None:
    workflow = yaml.safe_load((perf.REPO / ".github" / "workflows" / "trace-gate.yml").read_text(encoding="utf-8"))
    legs = workflow["jobs"]["gate"]["strategy"]["matrix"]["include"]
    named = [name for leg in legs for name in leg["datasets"].split()]
    assert sorted(named) == sorted(SUITES["gate"].datasets)


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


# -- building and reporting --------------------------------------------------


def test_a_given_cli_and_server_leave_nothing_to_build(tmp_path: Path, monkeypatch) -> None:
    def refuse(*args, **kwargs):
        raise AssertionError("built something")

    monkeypatch.setattr(perf, "_run_build", refuse)
    monkeypatch.setattr(perf, "_tool", refuse)
    built = perf.build(tmp_path / "lucida", server=False)
    assert built == perf.Build(tmp_path / "lucida")


def test_failed_runs_are_named_and_annotated_in_github_actions(tmp_path: Path, capsys) -> None:
    ok = perf.Row(
        perf.Case(CATALOG["image"], SCENARIOS["cold-open"], 1.0, 1), tmp_path / "a.json", tmp_path / "a.txt", 0
    )
    failed = perf.Row(
        perf.Case(CATALOG["volume"], SCENARIOS["volume-open-small"], 2.0, 1), tmp_path / "b.json", tmp_path / "b.txt", 1
    )
    failed.error = "the view never settled with 40% of its wanted set resident"

    perf.report_failures([ok, failed], github=False)
    assert capsys.readouterr().out.splitlines() == [
        "1 of 2 runs failed:",
        f"  volume.volume-open-small.dpr2: {failed.error}",
    ]

    perf.report_failures([ok, failed], github=True)
    assert capsys.readouterr().out.splitlines()[-1] == (
        "::error title=volume.volume-open-small.dpr2::the view never settled with 40%25 of its wanted set resident"
    )

    perf.report_failures([ok], github=True)
    assert capsys.readouterr().out == ""


# -- reading runs and the table ----------------------------------------------


def run_file(tmp_path: Path, diagnostic, script=None, throttle=None) -> Path:
    header = {"settled": True}
    if script is not None:
        header["script"] = {"steps": script}
    if throttle is not None:
        header["sourceThrottle"] = throttle
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
    cells = dict(zip(perf.COLUMNS, perf.table_cells(perf.group_cells([row])[0], tmp_path)))
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
    assert not any(line.startswith("throttle:") for line in lines)


REMOTE = {
    "settings": {"profile": "remote", "latency_ms": 180, "jitter_ms": 100, "bytes_per_sec": 18874368},
    "summary": "source reads throttled on the server: remote: 180-280 ms per request, 18 MiB/s across all reads",
}


def test_a_throttled_server_says_so_in_the_table_and_the_summary(tmp_path: Path) -> None:
    path = run_file(tmp_path, DIAGNOSTIC, throttle=REMOTE)
    row = perf.Row(perf.Case(CATALOG["image"], SCENARIOS["cold-open"], 1.0, 1), path, tmp_path / "a.txt", 0)
    row.fields = perf.read_run(path)
    assert perf.render_markdown([row], tmp_path).splitlines()[1] == f"throttle: {REMOTE['summary']}"
    assert perf.summary_json([row], tmp_path, {})["sourceThrottle"] == REMOTE

    unthrottled = run_file(tmp_path, DIAGNOSTIC, throttle={"summary": "source reads unthrottled"})
    row.fields = perf.read_run(unthrottled)
    assert perf.summary_json([row], tmp_path, {})["sourceThrottle"] == {"summary": "source reads unthrottled"}
    assert not perf.render_markdown([row], tmp_path).splitlines()[1].startswith("throttle:")


def test_the_server_keeps_the_callers_source_throttle(monkeypatch) -> None:
    monkeypatch.setenv("LUCIDA_SOURCE_THROTTLE", "remote")
    monkeypatch.setenv("LUCIDA_DB_URL", "sqlite://elsewhere.db")
    env = perf._scrubbed_env()
    assert env["LUCIDA_SOURCE_THROTTLE"] == "remote"
    assert "LUCIDA_DB_URL" not in env


# -- repeats, baselines and comparison ---------------------------------------

ADAPTER = "nvidia ampere (hardware adapter)"
ADAPTER_DIR = "nvidia-ampere-hardware-adapter"


def measured(tmp_path: Path, name: str, ratio: float = 1.0, repeat: int = 1, error=None, **fields) -> perf.Row:
    """A run of `name` ("dataset.scenario") whose diagnostic read as `fields`
    over a settled default."""
    dataset, scenario = name.split(".")
    case = perf.Case(CATALOG[dataset], SCENARIOS[scenario], ratio, repeat)
    row = perf.Row(case, tmp_path / f"{case.id}.json", tmp_path / f"{case.id}.txt", 0 if error is None else 1, error)
    if error is None:
        row.fields = {
            "adapter": "nvidia ampere",
            "adapterKind": "hardware adapter",
            "verdict": "clear",
            "firstFrameMs": 200.0,
            "settleMs": 1000.0,
            "bytesFetched": 5_000_000,
            "chunksFetched": 80,
            "chunksEvicted": 0,
            **fields,
        }
    return row


def saved(tmp_path: Path, rows: list[perf.Row], commit: str = "abc1234", knobs=()) -> Path:
    root = tmp_path / "baselines"
    perf.save_baseline(perf.group_cells(rows), root, {"commit": commit, "startedAt": "2026-11-08T10:00:00"}, knobs)
    return root


def compared(rows: list[perf.Row], root: Path, knobs=()) -> tuple[list[perf.Cell], perf.Comparison]:
    cells = perf.group_cells(rows)
    return cells, perf.compare(cells, root, knobs)


def test_repeats_make_one_row_of_medians_with_their_spread(tmp_path: Path) -> None:
    rows = [measured(tmp_path, "image.cold-open", repeat=n, settleMs=s) for n, s in enumerate([1000, 1400, 1100], 1)]
    [cell] = perf.group_cells(rows)
    assert cell.stats("settleMs") == perf.Stats(3, 1100, 1000, 1400)
    # An even count's median is a mean, and still prints as a whole count.
    [pair] = perf.group_cells([measured(tmp_path, "image.cold-open", repeat=n, bytesFetched=0) for n in (1, 2)])
    assert perf.table_cells(pair, tmp_path)[perf.COLUMNS.index("fetched")] == "0 B"
    cells = dict(zip(perf.COLUMNS, perf.table_cells(cell, tmp_path)))
    assert cells["scenario"] == "cold-open ×3"
    assert cells["settle"] == "1,100 ms ±200 ms"
    assert cells["chunks"] == "80"
    assert cells["evicted"] == "0"
    assert cells["verdict"] == "clear"
    assert cells["run"] == "image.cold-open.dpr1.txt +2"


def test_a_failed_repeat_shows_in_the_verdict_and_not_in_the_numbers(tmp_path: Path) -> None:
    rows = [measured(tmp_path, "image.cold-open"), measured(tmp_path, "image.cold-open", repeat=2, error="timed out")]
    cells = dict(zip(perf.COLUMNS, perf.table_cells(perf.group_cells(rows)[0], tmp_path)))
    assert cells["settle"] == "1,000 ms"
    assert cells["verdict"] == "clear ×1, error: timed out ×1"


def test_a_run_within_noise_of_its_baseline_flags_nothing(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "volume.orbit")])
    allowed = {m.field: m.allowance(base) * 0.9 for m, base in zip(perf.METRICS, (200, 1000, 5e6, 80, 0))}
    later = measured(
        tmp_path,
        "volume.orbit",
        firstFrameMs=200 + allowed["firstFrameMs"],
        settleMs=1000 - allowed["settleMs"],
        chunksFetched=80 + round(allowed["chunksFetched"] - 0.5),
    )
    [cell], comparison = compared([later], root)
    assert comparison.found(cell) == []
    assert comparison.describe(cell) == "within noise"
    assert not comparison.regressed(cell)


def test_a_slowdown_beyond_noise_is_flagged_and_listed_first(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "volume.cold-open"), measured(tmp_path, "volume.orbit")])
    later = [measured(tmp_path, "volume.cold-open"), measured(tmp_path, "volume.orbit", settleMs=3000.0)]
    later.append(measured(tmp_path, "volume.cold-open", 2.0))
    cells, comparison = compared(later, root)
    assert comparison.regressed(cells[1]) and not comparison.regressed(cells[0])
    assert comparison.describe(cells[1]) == "worse: settle 1,000 ms -> 3,000 ms (+200%)"
    assert comparison.describe(cells[2]) == "no baseline"
    table = [line for line in perf.render_markdown(later, tmp_path, comparison).splitlines() if line.startswith("|")]
    assert table[0].endswith(f"| {perf.BASELINE_COLUMN} |")
    assert table[2].startswith("| volume | orbit |")
    assert table[2].endswith("| worse: settle 1,000 ms -> 3,000 ms (+200%) |")
    assert table[3].endswith("| within noise |")
    summary = perf.summary_json(later, tmp_path, {}, comparison)
    assert summary["cells"][1]["vsBaseline"][0]["worse"] is True


def test_a_measure_that_drops_is_named_but_not_called_better(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "volume.cold-open")])
    later = measured(tmp_path, "volume.cold-open", chunksEvicted=64, chunksFetched=30, bytesFetched=2_000_000)
    [cell], comparison = compared([later], root)
    assert comparison.regressed(cell)
    assert comparison.describe(cell) == (
        "worse: evicted 0 -> 64; changed: fetched 5.0 MB -> 2.0 MB (-60%), chunks 80 -> 30 (-62%)"
    )


def test_a_view_that_stops_settling_is_flagged(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "image.cold-open"), measured(tmp_path, "image.pan-sweep")])
    later = [measured(tmp_path, "image.cold-open", verdict="unsettled"), measured(tmp_path, "image.pan-sweep")]
    later.append(measured(tmp_path, "image.pan-sweep", repeat=2, error="timed out"))
    cells, comparison = compared(later, root)
    assert comparison.describe(cells[0]) == "worse: verdict clear -> unsettled"
    assert comparison.describe(cells[1]) == "worse: verdict clear -> clear ×1, error ×1"
    # A stall comes and goes on an unchanged build, so it is no regression.
    clear, stall = (perf.group_cells([measured(tmp_path, "image.cold-open", verdict=v)])[0] for v in ("clear", "stall"))
    assert perf.compare_records(clear.record(), stall.record()) == []


def test_a_baseline_is_kept_per_adapter_and_ratio_outside_target(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "image.cold-open"), measured(tmp_path, "image.cold-open", 2.0)])
    assert sorted(p.relative_to(root).as_posix() for p in root.rglob("*.json")) == [
        f"{ADAPTER_DIR}/dpr1.json",
        f"{ADAPTER_DIR}/dpr2.json",
    ]
    baseline = json.loads((root / ADAPTER_DIR / "dpr2.json").read_text(encoding="utf-8"))
    assert baseline["adapter"] == ADAPTER
    assert baseline["ratio"] == 2.0
    assert perf.REPO / "target" not in perf.default_baseline_dir().parents


def test_saving_replaces_the_cells_it_measured_and_keeps_the_rest(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "image.cold-open"), measured(tmp_path, "volume.orbit")])
    later = [measured(tmp_path, "volume.orbit", settleMs=2000.0), measured(tmp_path, "image.pan-sweep", error="x")]
    notes = perf.save_baseline(perf.group_cells(later), root, {"commit": "def5678"}, ("max-fetches=1",))
    assert notes[-1] == "not saved, because a run failed: image.pan-sweep dpr 1"
    cells = json.loads((root / ADAPTER_DIR / "dpr1.json").read_text(encoding="utf-8"))["cells"]
    assert sorted(cells) == ["image.cold-open", "volume.orbit"]
    assert cells["image.cold-open"]["commit"] == "abc1234"
    assert cells["volume.orbit"]["commit"] == "def5678"
    assert cells["volume.orbit"]["metrics"]["settleMs"] == {"n": 1, "median": 2000.0, "low": 2000.0, "high": 2000.0}
    assert cells["volume.orbit"]["knobs"] == ["max-fetches=1"]


def test_a_baseline_recorded_on_another_adapter_is_refused(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "image.cold-open")])
    path = root / ADAPTER_DIR / "dpr1.json"
    write(path, {**json.loads(path.read_text(encoding="utf-8")), "adapter": "apple m2 (hardware adapter)"})
    later = [measured(tmp_path, "image.cold-open", settleMs=9000.0)]
    [cell], comparison = compared(later, root)
    assert comparison.refused and not comparison.compared
    assert comparison.found(cell) is None
    assert comparison.notes == [
        f"dpr 1: not compared: {path} was recorded on apple m2 (hardware adapter), these runs on {ADAPTER}"
    ]
    assert perf.BASELINE_COLUMN not in perf.render_markdown(later, tmp_path, comparison)


def test_no_baseline_ever_saved_adds_nothing_to_the_table(tmp_path: Path) -> None:
    rows = [measured(tmp_path, "image.cold-open"), measured(tmp_path, "image.cold-open", 2.0)]
    cells, comparison = compared(rows, tmp_path / "absent")
    assert comparison.notes == [] and not comparison.compared and not comparison.refused
    assert not any(comparison.regressed(cell) for cell in cells)
    assert perf.render_markdown(rows, tmp_path, comparison) == perf.render_markdown(rows, tmp_path)


def test_an_adapter_without_a_baseline_hears_which_adapters_have_one(tmp_path: Path) -> None:
    root = saved(tmp_path, [measured(tmp_path, "image.cold-open")])
    _, comparison = compared([measured(tmp_path, "image.cold-open", adapter="intel xe")], root)
    assert not comparison.compared and not comparison.refused
    assert comparison.notes == [f"dpr 1: no baseline for this adapter; {root} has one for {ADAPTER_DIR}"]


def test_knobs_reach_the_trace_and_a_baseline_under_other_knobs_says_so(tmp_path: Path) -> None:
    assert perf.knob_args(("max-fetches=1", "main-budget-mb=64")) == ["--max-fetches", "1", "--main-budget-mb", "64"]
    for text in ("--max-fetches 1", "max-fetches", "max-fetches=1=2"):
        with pytest.raises(perf.PerfError, match="a knob is NAME=VALUE"):
            perf.parse_knob(text)
    root = saved(tmp_path, [measured(tmp_path, "image.cold-open")])
    _, comparison = compared([measured(tmp_path, "image.cold-open")], root, ("max-fetches=1",))
    assert "dpr 1: knobs differ: these runs --max-fetches 1, the baseline none" in comparison.notes


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", *sys.argv[1:]]))
