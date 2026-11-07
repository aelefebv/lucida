#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10", "pytest>=8"]
# ///
"""Tests for the parts of the scripted run check that need no server.

Run with ``uv run extras/test_verify_trace_script.py``. The checks are read
against a run file and a bundle built here from what the driver writes, so
a check that would pass a wrong run fails here first. Nothing launches a
browser or opens a socket.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_trace_script as check  # noqa: E402
from verify_level_chain import Report  # noqa: E402


def view(theta: float = 0.4, t: int = 0) -> dict:
    return {
        "v": 1,
        "camera": {"mode": "arcball", "theta": theta, "phi": 0.2, "distance": 500.0, "viewport": [1440, 900]},
        "view": {"z_range": {"start": 0, "end": 32}, "t": t, "c": 0},
        "dataset_settings": {"ds-1": {"visible": True, "channel_settings": [{"visible": True}]}},
    }


def step(kind: str, run_id: str | None, cause: str | None, epoch: str | None, before: dict, after: dict, **extra) -> dict:
    record = {
        "kind": kind,
        "startedAtMs": 1000.0,
        "endedAtMs": 2000.0,
        "runId": run_id,
        "cause": None if cause is None else {"epoch": epoch, "dirtyKind": "interactive", "source": cause},
        "endReason": None if run_id is None else "quiescent",
        "durationUs": None if run_id is None else 900_000.0,
        "verdict": None if run_id is None else {"kind": "clear", "text": "fine"},
        "timedOut": False,
        "viewBefore": before,
        "viewAfter": after,
        "viewChanged": before != after,
    }
    record.update(extra)
    return record


def steps() -> list[dict]:
    return [
        step("wait", None, None, None, view(), view()),
        step("orbit", "run-2", "orbit", "view", view(0.4), view(0.9), theta=30, phi=15,
             input={"sent": "drag", "from": [668, 424], "to": [772, 476], "moves": 15}),
        step("scrub", "run-3", "scrub", "selection", view(0.9, 0), view(0.9, 1), axis="t", count=1,
             input={"sent": "control", "applied": True}),
        step("select", "run-4", "select", "selection", view(0.9, 1), view(0.9, 1), channel=0, visible=True,
             input={"sent": "control", "applied": True}),
        step("scrub", None, None, None, view(0.9, 1), view(0.9, 1), axis="z", count=1,
             input={"sent": "control", "applied": False, "reason": "the Z selector is disabled in volume mode"}),
    ]


def run_in_document(run_id: str, cause: str, epoch: str) -> dict:
    return {"header": {"runId": run_id, "cause": {"epoch": epoch, "dirtyKind": "interactive", "source": cause}, "endReason": "quiescent"}}


def documents() -> tuple[dict, dict]:
    runs = [
        {"header": {"runId": "run-1", "cause": {"epoch": "content", "dirtyKind": "interactive", "source": "dataset_open_request"}, "endReason": "quiescent"}},
        run_in_document("run-2", "orbit", "view"),
        run_in_document("run-3", "scrub", "selection"),
        run_in_document("run-4", "select", "selection"),
    ]
    run_file = {
        "fileVersion": 1,
        "header": {"runId": "run-4", "endReason": "quiescent", "settled": True, "script": {"steps": steps()}},
        "trace": {"runs": runs},
    }
    bundle = {
        "format": "lucida-trace-bundle",
        "header": {"runId": "run-4"},
        "trace": {"runs": runs},
        "script": {"steps": steps()},
    }
    return run_file, bundle


def written(tmp_path: Path, run_file: dict, bundle: dict) -> tuple[Path, Path]:
    run_path = tmp_path / "scripted.run.json"
    bundle_path = tmp_path / "scripted.bundle.json"
    run_path.write_text(json.dumps(run_file))
    bundle_path.write_text(json.dumps(bundle))
    return run_path, bundle_path


def failures(run_file: dict, bundle: dict, tmp_path: Path) -> list[str]:
    report = Report()
    run_path, bundle_path = written(tmp_path, run_file, bundle)
    run_steps = check.check_run_file(report, run_path)
    check.check_bundle(report, bundle_path, run_steps)
    return report.failures


def test_a_run_that_did_what_the_script_says_passes(tmp_path: Path) -> None:
    run_file, bundle = documents()
    assert failures(run_file, bundle, tmp_path) == []


def test_the_script_the_check_drives_matches_what_it_expects() -> None:
    assert [step["kind"] for step in check.SCRIPT["steps"]] == [kind for kind, *_ in check.EXPECTED]


def test_a_gesture_under_the_wrong_cause_fails(tmp_path: Path) -> None:
    run_file, bundle = documents()
    # A drag in slice mode pans; the orbit step would then open a pan run.
    run_file["header"]["script"]["steps"][1]["cause"]["source"] = "pan"
    found = failures(run_file, bundle, tmp_path)
    assert any("step 2 (orbit)" in failure and "not orbit on the view epoch" in failure for failure in found), found


def test_two_gestures_in_one_run_fail(tmp_path: Path) -> None:
    run_file, bundle = documents()
    # The scrub landed while the orbit's run was open, so it extended that run.
    run_file["header"]["script"]["steps"][2]["runId"] = "run-2"
    found = failures(run_file, bundle, tmp_path)
    assert any("step 3 (scrub)" in failure and "one gesture is one run" in failure for failure in found), found


def test_a_step_that_changed_nothing_must_say_so(tmp_path: Path) -> None:
    run_file, bundle = documents()
    run_file["header"]["script"]["steps"][3]["viewChanged"] = True
    found = failures(run_file, bundle, tmp_path)
    assert any("step 4 (select)" in failure and "should not have changed" in failure for failure in found), found


def test_a_refused_step_opens_no_run_and_carries_the_reason(tmp_path: Path) -> None:
    run_file, bundle = documents()
    refused = run_file["header"]["script"]["steps"][4]
    refused["input"]["applied"] = True
    del refused["input"]["reason"]
    found = failures(run_file, bundle, tmp_path)
    assert any("step 5 (scrub z)" in failure and "refuse the Z selector" in failure for failure in found), found

    run_file, bundle = documents()
    run_file["header"]["script"]["steps"][4]["runId"] = "run-9"
    found = failures(run_file, bundle, tmp_path)
    assert any("step 5 (scrub)" in failure and "should have opened none" in failure for failure in found), found


def test_the_file_is_about_the_last_run_a_step_opened(tmp_path: Path) -> None:
    run_file, bundle = documents()
    run_file["header"]["runId"] = "run-1"
    found = failures(run_file, bundle, tmp_path)
    assert any("not the last step's run run-4" in failure for failure in found), found


def test_the_orbit_must_turn_the_camera_and_the_scrub_must_move_time(tmp_path: Path) -> None:
    run_file, bundle = documents()
    orbit = run_file["header"]["script"]["steps"][1]
    orbit["viewAfter"] = copy.deepcopy(orbit["viewBefore"])
    orbit["viewAfter"]["dataset_settings"]["ds-1"]["visible"] = False  # changed, but not the camera
    found = failures(run_file, bundle, tmp_path)
    assert any("the arcball camera did not turn" in failure for failure in found), found

    run_file, bundle = documents()
    scrub = run_file["header"]["script"]["steps"][2]
    scrub["viewAfter"]["view"]["t"] = 3
    found = failures(run_file, bundle, tmp_path)
    assert any("not one step on" in failure for failure in found), found


def test_a_bundle_whose_steps_differ_from_the_run_files_fails(tmp_path: Path) -> None:
    run_file, bundle = documents()
    bundle["script"]["steps"][1]["runId"] = "run-7"
    bundle["trace"]["runs"].append(run_in_document("run-7", "orbit", "view"))
    found = failures(run_file, bundle, tmp_path)
    assert any("bundle's steps and runs differ" in failure for failure in found), found


def test_a_run_with_no_script_fails_and_names_the_steps_it_wanted(tmp_path: Path) -> None:
    run_file, bundle = documents()
    del run_file["header"]["script"]
    found = failures(run_file, bundle, tmp_path)
    assert found[0].startswith("run file: expected the steps ['wait', 'orbit', 'scrub', 'select', 'scrub'], found []")


def test_the_table_names_each_steps_run_and_refusal() -> None:
    table = check.steps_table(steps())
    assert "| 2 orbit | run-2 | orbit | quiescent | yes | - |" in table
    assert "| 4 select | run-4 | select | quiescent | no | - |" in table
    assert "| 5 scrub | - | - | - | no | the Z selector is disabled in volume mode |" in table


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
