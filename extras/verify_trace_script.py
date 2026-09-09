#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10"]
# ///
"""Prove the trace driver's scripted steps end to end, at device pixel ratio 2.

The check uses the generator beside this script to write a synthetic
dataset with a depth axis and four timepoints, then opens it once through
``lucida trace`` in volume mode with a script file of five steps:

1. **wait** for quiescence, which the driver has already reached, so the
   step opens no run and returns at once.
2. **orbit** by two angles, as a pointer drag over the DevTools protocol.
3. **scrub** the time selector by one, through the handler the control calls.
4. **select** channel 0, which is already shown: the input lands, so a run
   opens under ``select``, and the view does not change.
5. **scrub** the Z selector, which the page disables in volume mode, so the
   page refuses the step and no run opens.

Then it reads the run file and the bundle back and requires:

* one interaction run per gesture, each under the cause that names its
  input: ``orbit`` on the ``view`` epoch, ``scrub`` and ``select`` on the
  ``selection`` epoch, each a distinct run that closed by settling;
* the view recorded before and after every step, with the orbit turning
  the camera, the scrub moving the time index by one, and the select and
  the refused scrub leaving the view as it was and saying so;
* the refused step carrying the page's reason and no run;
* the run the file is about being the last run a step opened, and the
  bundle carrying the same steps with the same runs;
* the frame at device pixel ratio 2.

Prerequisites: a running lucida server that serves the web bundle, the
``lucida`` CLI on ``PATH`` or named with ``--lucida``, and Chrome. The
server must be able to read the output directory, so run the check on the
machine the server runs on. Build the bundle first (``pnpm run build`` in
``lucida-web``) or point ``LUCIDA_WEB_DIST`` at one.

    uv run extras/verify_trace_script.py [--server URL] [--out DIR] [--keep]

Options:

    --server URL         The lucida server. Default http://127.0.0.1:9876.
    --lucida CMD         The CLI to run, as one shell string. Default
                         ``lucida``, or ``cargo run -q -p lucida-cli --``
                         when that is not on PATH.
    --out DIR            Where the dataset, the script, the frame, the run
                         file, and the bundle land. Default a fresh
                         temporary directory.
    --keep               Keep the output directory on success. It is
                         always kept on failure, and its path is printed.
    --timeout-seconds N  How long the open and each step may take to
                         settle. Default 180.
    --size Z,Y,X         Level 0 size of the dataset. Default 32,128,128.
    --timepoints N       Timepoints, so the scrub has somewhere to go.
                         Default 4.
    --dataset PATH       Use this dataset instead of generating one. It
                         needs a depth axis and at least two timepoints.

The exit status is 0 when every check passed and 1 otherwise. The report
on stdout says which check failed and where the evidence is.
"""

from __future__ import annotations

import argparse
import json
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_level_chain import (  # noqa: E402
    DEVICE_PIXEL_RATIO,
    VIEWPORT_CSS,
    Lucida,
    Report,
    default_lucida_command,
    frame_size,
    generate,
)

DEFAULT_SERVER = "http://127.0.0.1:9876"
DEFAULT_TIMEOUT_SECONDS = 180

# The script the check drives, as the driver's script file spells it. The
# same steps are the flags ``--wait --orbit 30,15 --scrub t:1 --select
# channel:0 --scrub z:1``.
SCRIPT = {
    "steps": [
        {"kind": "wait"},
        {"kind": "orbit", "theta": 30, "phi": 15},
        {"kind": "scrub", "axis": "t", "count": 1},
        {"kind": "select", "channel": 0},
        {"kind": "scrub", "axis": "z", "count": 1},
    ]
}

# Per step, in script order: its kind, the cause and epoch its run opens
# under (None when it opens none), and whether the view changes.
EXPECTED = [
    ("wait", None, None, False),
    ("orbit", "orbit", "view", True),
    ("scrub", "scrub", "selection", True),
    ("select", "select", "selection", False),
    ("scrub", None, None, False),
]


# ---------------------------------------------------------------------------
# Reading the artifacts
# ---------------------------------------------------------------------------


def run_by_id(doc: dict, run_id: str | None) -> dict | None:
    """The run named in a run file's or a bundle's trace document, or None."""
    if run_id is None:
        return None
    for run in doc.get("trace", {}).get("runs", []):
        if run["header"].get("runId") == run_id:
            return run
    return None


def camera_angles(view: dict | None) -> tuple[float, float] | None:
    camera = (view or {}).get("camera") or {}
    if camera.get("mode") != "arcball":
        return None
    return (float(camera["theta"]), float(camera["phi"]))


def time_index(view: dict | None) -> int | None:
    selectors = (view or {}).get("view") or {}
    return None if "t" not in selectors else int(selectors["t"])


def check_steps(report: Report, doc: dict, what: str) -> list[dict]:
    """The checks over a run file's steps, or a bundle's. Returns the steps."""
    script = (doc.get("header") or {}).get("script") if what == "run file" else doc.get("script")
    steps = (script or {}).get("steps") or []
    kinds = [step.get("kind") for step in steps]
    if not report.check(
        kinds == [kind for kind, *_ in EXPECTED],
        f"{what}: expected the steps {[kind for kind, *_ in EXPECTED]}, found {kinds}",
    ):
        return steps

    run_ids: list[str] = []
    for index, (step, (kind, cause, epoch, changed)) in enumerate(zip(steps, EXPECTED), start=1):
        label = f"{what} step {index} ({kind})"
        run_id = step.get("runId")
        if cause is None:
            report.check(run_id is None, f"{label}: opened run {run_id}, and should have opened none")
        else:
            report.check(run_id is not None, f"{label}: opened no run")
            if run_id is not None:
                report.check(run_id not in run_ids, f"{label}: shares run {run_id} with an earlier step; one gesture is one run")
                run_ids.append(run_id)
                got = step.get("cause") or {}
                report.check(
                    got.get("source") == cause and got.get("epoch") == epoch,
                    f"{label}: run {run_id} opened under {got}, not {cause} on the {epoch} epoch",
                )
                report.check(
                    step.get("endReason") == "quiescent",
                    f"{label}: run {run_id} ended {step.get('endReason')}, not quiescent",
                )
                run = run_by_id(doc, run_id)
                report.check(run is not None, f"{label}: run {run_id} is not in the trace document")
                if run is not None:
                    report.check(
                        (run["header"].get("cause") or {}).get("source") == cause,
                        f"{label}: the document's run {run_id} has cause {run['header'].get('cause')}",
                    )
        report.check(not step.get("timedOut"), f"{label}: the driver's deadline passed")
        report.check(
            bool(step.get("viewChanged")) == changed,
            f"{label}: viewChanged is {step.get('viewChanged')}, and the view should{'' if changed else ' not'} have changed",
        )
        report.check(step.get("viewBefore") is not None, f"{label}: no view was recorded before the step")
        report.check(step.get("viewAfter") is not None, f"{label}: no view was recorded after the step")

    orbit = steps[1]
    before, after = camera_angles(orbit.get("viewBefore")), camera_angles(orbit.get("viewAfter"))
    report.check(
        before is not None and after is not None and before != after,
        f"{what} step 2 (orbit): the arcball camera did not turn: {before} -> {after}",
    )
    scrub = steps[2]
    t_before, t_after = time_index(scrub.get("viewBefore")), time_index(scrub.get("viewAfter"))
    report.check(
        t_before is not None and t_after == t_before + 1,
        f"{what} step 3 (scrub): the time index went {t_before} -> {t_after}, not one step on",
    )
    refused = steps[4]
    sent = refused.get("input") or {}
    report.check(
        sent.get("sent") == "control" and sent.get("applied") is False and "volume mode" in (sent.get("reason") or ""),
        f"{what} step 5 (scrub z): expected the page to refuse the Z selector in volume mode, got {sent}",
    )
    return steps


def check_run_file(report: Report, run_file: Path) -> list[dict]:
    doc = json.loads(run_file.read_text())
    steps = check_steps(report, doc, "run file")
    last = next((step.get("runId") for step in reversed(steps) if step.get("runId")), None)
    report.check(
        last is not None and doc["header"].get("runId") == last,
        f"run file: the file is about run {doc['header'].get('runId')}, not the last step's run {last}",
    )
    report.check(
        doc["header"].get("endReason") == "quiescent",
        f"run file: the file's run ended {doc['header'].get('endReason')}, not quiescent",
    )
    return steps


def check_bundle(report: Report, bundle_file: Path, run_steps: list[dict]) -> None:
    doc = json.loads(bundle_file.read_text())
    steps = check_steps(report, doc, "bundle")
    report.check(
        [(step.get("kind"), step.get("runId")) for step in steps]
        == [(step.get("kind"), step.get("runId")) for step in run_steps],
        "bundle: the bundle's steps and runs differ from the run file's",
    )


def check_frame(report: Report, screenshot: Path) -> None:
    expected = (VIEWPORT_CSS[0] * DEVICE_PIXEL_RATIO, VIEWPORT_CSS[1] * DEVICE_PIXEL_RATIO)
    size = frame_size(screenshot)
    report.check(size == expected, f"frame: {screenshot} is {size}, not {expected} at device pixel ratio 2")


def steps_table(steps: list[dict]) -> str:
    lines = ["| step | run | cause | ended | view changed | refused |", "| --- | --- | --- | --- | --- | --- |"]
    for index, step in enumerate(steps, start=1):
        sent = step.get("input") or {}
        refused = ""
        if sent.get("sent") == "control" and not sent.get("applied"):
            refused = sent.get("reason") or ""
        elif sent.get("sent") == "withheld":
            refused = f"driver: {sent.get('reason') or ''}"
        lines.append(
            f"| {index} {step.get('kind')} | {step.get('runId') or '-'} | "
            f"{(step.get('cause') or {}).get('source') or '-'} | {step.get('endReason') or '-'} | "
            f"{'yes' if step.get('viewChanged') else 'no'} | {refused or '-'} |"
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Driving the run
# ---------------------------------------------------------------------------


def drive(lucida: Lucida, dataset: Path, workspace_id: str, out: Path, timeout_seconds: int) -> tuple[Path, Path, Path]:
    script_file = out / "script.json"
    script_file.write_text(json.dumps(SCRIPT, indent=2) + "\n")
    run_file = out / "scripted.run.json"
    screenshot = out / "scripted.png"
    bundle_file = out / "scripted.bundle.json"
    lucida.call(
        "--workspace",
        workspace_id,
        "trace",
        str(dataset),
        "--camera",
        "arcball",
        "--script",
        str(script_file),
        "--width",
        str(VIEWPORT_CSS[0]),
        "--height",
        str(VIEWPORT_CSS[1]),
        "--device-pixel-ratio",
        str(DEVICE_PIXEL_RATIO),
        "--output",
        str(run_file),
        "--screenshot",
        str(screenshot),
        "--bundle",
        str(bundle_file),
        "--timeout-seconds",
        str(timeout_seconds),
        # The open and five steps each get the deadline.
        timeout=timeout_seconds * 6 + 120,
    )
    return run_file, screenshot, bundle_file


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--lucida", default=None)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--size", default="32,128,128")
    parser.add_argument("--timepoints", type=int, default=4)
    parser.add_argument("--dataset", type=Path, default=None)
    opts = parser.parse_args(argv)

    out = opts.out or Path(tempfile.mkdtemp(prefix="lucida-trace-script-"))
    out.mkdir(parents=True, exist_ok=True)
    command = shlex.split(opts.lucida) if opts.lucida else default_lucida_command()
    lucida = Lucida(command, opts.server, out / "cli-config.json")
    report = Report()

    dataset = opts.dataset
    if dataset is None:
        dataset = generate(
            [
                str(out / "volume.ome.zarr"),
                "--size",
                opts.size,
                "--timepoints",
                str(opts.timepoints),
                "--levels",
                "2",
                "--chunk",
                "32",
                "--overwrite",
            ]
        )
    report.say(f"dataset  {dataset}")
    report.say(f"script   {' · '.join(step['kind'] for step in SCRIPT['steps'])}")

    stamp = time.strftime("%H%M%S")
    workspace_id = lucida.create_workspace(f"trace script {stamp}")
    lucida.open_dataset(dataset, workspace_id)

    try:
        run_file, screenshot, bundle_file = drive(lucida, dataset, workspace_id, out, opts.timeout_seconds)
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        report.check(False, f"the run did not complete: {error}")
    else:
        steps = check_run_file(report, run_file)
        report.say(steps_table(steps))
        check_bundle(report, bundle_file, steps)
        check_frame(report, screenshot)

    if report.failures:
        print(f"\nFAILED ({len(report.failures)})", flush=True)
        for failure in report.failures:
            print(f"  - {failure}", flush=True)
        print(f"\nevidence kept in {out}", flush=True)
        return 1

    print(
        "\nPASSED: each gesture opened one run under its own cause, every step recorded its view, "
        "and the steps that changed nothing say so.",
        flush=True,
    )
    if opts.keep or opts.out is not None:
        print(f"evidence in {out}", flush=True)
    else:
        shutil.rmtree(out, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
