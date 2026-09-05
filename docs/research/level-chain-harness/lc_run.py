#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10"]
# ///
"""Measure a collection's wanted set and fill time with and without the level rule.

The measurement section of ADR 0061 compares the level-0 default the ADR
replaced with the screen-chosen target level, on a wide collection zoomed
out to show every tile. This harness takes that measurement at device
pixel ratio 2, one server process per run so every run reads a cold source
cache, and one browser per run, which is what ``lucida trace`` gives.

Each round drives two runs of the same dataset, in alternating order so
that a link that changes speed between rounds cannot favour one side:

``pinned``
    ``lucida trace --level-pin 0``. The target is held at level 0, which is
    the behaviour before ADR 0061.
``screen``
    ``lucida trace`` with the target following the screen.

Both runs frame the whole dataset with the slice camera (``--camera
slice``), so a collection is seen zoomed out with every tile in view. From
each run file the harness reads:

* whether the page reached quiescence, and after how long;
* the target level the browser planned at, and whether it was pinned;
* the most chunks any one planning pass planned at that level, which is
  the visible detail wanted set per rebuild;
* the backend reads the server's timing rows record, their byte total, and
  the read rate over the span they cover, which is the link on the day;
* the wall time of the dataset open, taken before the run.

Prerequisites: a built ``lucida-server`` and ``lucida`` CLI, a built web
bundle, Chrome, and read access to the dataset. A ``gs://`` dataset needs
valid application default credentials for the server (``gcloud auth
application-default login``); the harness drops any service-account
variables so those credentials win.

    uv run docs/research/level-chain-harness/lc_run.py OUT_DIR DATASET [options]

Options:

    --rounds N           Rounds of the two runs. Default 2.
    --timeout-seconds N  How long each run may take to settle. A run that
                         has not settled by then is reported as such, with
                         what it had planned and read. Default 300.
    --server-bin PATH    The server binary. Default target/release/lucida-server.
    --web-dist DIR       The web bundle. Default lucida-web/dist.
    --lucida CMD         The CLI, as one shell string. Default
                         target/release/lucida, then ``lucida`` on PATH.
    --width W --height H The viewport in CSS pixels. Default 1440x900, which
                         is 2880x1800 device pixels at ratio 2.
    --modes A,B          Which runs to take. Default pinned,screen.

The report on stdout is a Markdown table, and ``summary.json`` in OUT_DIR
holds the same numbers with the paths of every run file and frame.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "extras"))
sys.path.insert(0, str(REPO / "extras" / "tryout"))

from tryout.server import ServerProcess  # noqa: E402
from verify_level_chain import DEVICE_PIXEL_RATIO, read_levels, run_in_document  # noqa: E402

MODES = {"pinned": ["--level-pin", "0"], "screen": []}


@dataclass
class RunSummary:
    round: int
    mode: str
    run_file: str
    screenshot: str
    open_seconds: float
    settled: bool
    end_reason: str | None
    duration_seconds: float
    target_level: str
    level_pinned: bool | None
    planned_at_target: int
    # The most requests any one planning pass emitted on the detail lane and
    # on the coarse lane: the wanted set per rebuild, split by tier.
    detail_per_rebuild: int
    coarse_per_rebuild: int
    ticks: int
    detail_rows_at_target: int
    # When every detail-lane row at the target level completed, the moment
    # the last of them was presented: the time to a fully resident detail
    # tier, whether or not the run went on to settle.
    detail_filled_seconds: float | None
    rows_truncated: bool
    backend_reads: int
    backend_bytes: int
    read_span_seconds: float
    reads_per_second: float
    megabytes_per_second: float
    desired_detail_at_end: int | None
    resident_detail_at_end: int | None
    desired_coarse_at_end: int | None
    resident_coarse_at_end: int | None
    error: str | None = None


class Lucida:
    """The CLI, bound to one server and a private config file."""

    def __init__(self, command: Sequence[str], server: str, config_path: Path):
        self.command = list(command)
        self.server = server
        self.env = dict(os.environ, LUCIDA_CONFIG_PATH=str(config_path))

    def call(self, *args: str, timeout: float) -> dict:
        argv = [*self.command, "--server", self.server, "--json", *args]
        print("$", shlex.join(argv), flush=True)
        completed = subprocess.run(argv, env=self.env, capture_output=True, text=True, timeout=timeout)
        if completed.returncode != 0:
            raise RuntimeError(
                f"{shlex.join(argv)} exited {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
            )
        text = completed.stdout.strip()
        start = text.rfind("\n{")
        return json.loads(text if start < 0 else text[start + 1 :])


def default_lucida_command() -> list[str]:
    built = REPO / "target" / "release" / "lucida"
    if built.is_file():
        return [str(built)]
    if shutil.which("lucida"):
        return ["lucida"]
    return ["cargo", "run", "-q", "--release", "-p", "lucida-cli", "--"]


def fmt_range(value: tuple[int, int] | None) -> str:
    if value is None:
        return "none"
    return str(value[0]) if value[0] == value[1] else f"{value[0]}..{value[1]}"


def summarise(run_file: Path, screenshot: Path, round_index: int, mode: str, open_seconds: float) -> RunSummary:
    doc = json.loads(run_file.read_text())
    run = run_in_document(run_file)
    reading = read_levels(run)
    header = run["header"]

    target = reading.target
    detail_per_rebuild = 0
    coarse_per_rebuild = 0
    for tick in run.get("ticks", []):
        counters = tick.get("counters", {})
        detail_per_rebuild = max(detail_per_rebuild, int(counters.get("laneDetail", 0)))
        coarse_per_rebuild = max(coarse_per_rebuild, int(counters.get("laneCoarse", 0)))
    detail_rows = 0
    detail_incomplete = 0
    last_presented_us = 0
    for row in run.get("rows", []):
        if row.get("lane") != "detail" or target is None or int(row.get("level", -1)) != target[0]:
            continue
        detail_rows += 1
        presented = (row.get("phases") or {}).get("present")
        if row.get("outcome") == "complete" and presented and presented.get("endUs") is not None:
            last_presented_us = max(last_presented_us, int(presented["endUs"]))
        else:
            detail_incomplete += 1
    detail_filled = None
    if detail_rows and not detail_incomplete:
        detail_filled = round(last_presented_us / 1e6, 2)

    reads = 0
    total_bytes = 0
    first_us: int | None = None
    last_us: int | None = None
    for row in run.get("serverRows", []):
        moved = row.get("backendBytes")
        if moved is None:
            continue
        reads += 1
        total_bytes += int(moved)
        placement = row.get("placement") or {}
        start = placement.get("startUs")
        end = placement.get("endUs")
        if start is not None:
            first_us = start if first_us is None else min(first_us, start)
        if end is not None:
            last_us = end if last_us is None else max(last_us, end)
    span = 0.0 if first_us is None or last_us is None else max(last_us - first_us, 0) / 1e6

    outstanding = header.get("outstandingAtSettle") or {}
    pinned = None
    if run.get("ticks"):
        pinned = bool(run["ticks"][-1].get("levelPinned"))

    return RunSummary(
        round=round_index,
        mode=mode,
        run_file=str(run_file),
        screenshot=str(screenshot),
        open_seconds=round(open_seconds, 2),
        settled=bool(doc["header"].get("settled")),
        end_reason=header.get("endReason"),
        duration_seconds=round(header.get("durationUs", 0) / 1e6, 2),
        target_level=fmt_range(target),
        level_pinned=pinned,
        planned_at_target=reading.wanted_at_target,
        detail_per_rebuild=detail_per_rebuild,
        coarse_per_rebuild=coarse_per_rebuild,
        ticks=reading.ticks,
        detail_rows_at_target=detail_rows,
        detail_filled_seconds=detail_filled,
        rows_truncated=bool(header.get("truncation")) or bool(run.get("rowsDropped")),
        backend_reads=reads,
        backend_bytes=total_bytes,
        read_span_seconds=round(span, 2),
        reads_per_second=round(reads / span, 1) if span > 0 else 0.0,
        megabytes_per_second=round(total_bytes / span / 1e6, 2) if span > 0 else 0.0,
        desired_detail_at_end=outstanding.get("desiredDetailChunks"),
        resident_detail_at_end=outstanding.get("residentDetailChunks"),
        desired_coarse_at_end=outstanding.get("desiredCoarseChunks"),
        resident_coarse_at_end=outstanding.get("residentCoarseChunks"),
    )


def drive(
    out: Path,
    dataset: str,
    round_index: int,
    mode: str,
    command: list[str],
    server_bin: Path,
    web_dist: Path,
    width: int,
    height: int,
    timeout_seconds: int,
) -> RunSummary:
    run_dir = out / f"round-{round_index}-{mode}"
    run_dir.mkdir(parents=True, exist_ok=True)
    run_file = run_dir / "run.json"
    screenshot = run_dir / "frame.png"

    with ServerProcess(out_dir=run_dir, binary=server_bin, web_dist=web_dist, health_timeout_s=180.0) as server:
        handle = server.start()
        lucida = Lucida(command, handle.base_url, run_dir / "cli-config.json")
        workspace = lucida.call("workspace", "create", f"level-chain {round_index} {mode}", timeout=60.0)
        workspace_id = workspace["workspace"]["id"]

        started = time.monotonic()
        lucida.call("--workspace", workspace_id, "dataset", "open", dataset, timeout=1800.0)
        open_seconds = time.monotonic() - started

        lucida.call(
            "--workspace",
            workspace_id,
            "trace",
            dataset,
            "--camera",
            "slice",
            *MODES[mode],
            "--width",
            str(width),
            "--height",
            str(height),
            "--device-pixel-ratio",
            str(DEVICE_PIXEL_RATIO),
            "--output",
            str(run_file),
            "--screenshot",
            str(screenshot),
            "--timeout-seconds",
            str(timeout_seconds),
            timeout=timeout_seconds + 600,
        )
    return summarise(run_file, screenshot, round_index, mode, open_seconds)


def table(runs: Sequence[RunSummary]) -> str:
    head = (
        "| round | mode | open s | settled | run s | target | detail per rebuild | coarse per rebuild | "
        "detail filled s | detail resident at end | coarse resident at end | backend reads | MB read | "
        "reads/s | MB/s |\n"
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    )
    lines = [head]
    for run in runs:
        if run.error:
            lines.append(f"| {run.round} | {run.mode} | failed: {run.error} |")
            continue
        settled = "yes" if run.settled else f"no ({run.end_reason})"
        target = run.target_level + (" (pin)" if run.level_pinned else "")
        filled = "not all" if run.detail_filled_seconds is None else str(run.detail_filled_seconds)
        if run.rows_truncated:
            filled += " (rows truncated)"
        detail_resident = f"{run.resident_detail_at_end} of {run.desired_detail_at_end}"
        coarse_resident = f"{run.resident_coarse_at_end} of {run.desired_coarse_at_end}"
        lines.append(
            f"| {run.round} | {run.mode} | {run.open_seconds} | {settled} | {run.duration_seconds} | {target} | "
            f"{run.detail_per_rebuild} | {run.coarse_per_rebuild} | {filled} | {detail_resident} | "
            f"{coarse_resident} | {run.backend_reads} | {run.backend_bytes / 1e6:.1f} | "
            f"{run.reads_per_second} | {run.megabytes_per_second} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out", type=Path)
    parser.add_argument("dataset")
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--server-bin", type=Path, default=REPO / "target" / "release" / "lucida-server")
    parser.add_argument("--web-dist", type=Path, default=REPO / "lucida-web" / "dist")
    parser.add_argument("--lucida", default=None)
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--modes", default="pinned,screen")
    opts = parser.parse_args(argv)

    for key in (
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_SERVICE_ACCOUNT",
        "GOOGLE_SERVICE_ACCOUNT_PATH",
        "GOOGLE_SERVICE_ACCOUNT_KEY",
    ):
        os.environ.pop(key, None)

    for path in (opts.server_bin, opts.web_dist):
        if not path.exists():
            print(f"missing: {path}", file=sys.stderr)
            return 2
    command = shlex.split(opts.lucida) if opts.lucida else default_lucida_command()
    modes = [mode.strip() for mode in opts.modes.split(",") if mode.strip()]
    unknown = [mode for mode in modes if mode not in MODES]
    if unknown:
        print(f"unknown mode(s) {unknown}; choose from {sorted(MODES)}", file=sys.stderr)
        return 2

    opts.out.mkdir(parents=True, exist_ok=True)
    conditions = {
        "dataset": opts.dataset,
        "started": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "machine": f"{platform.machine()} {platform.system()} {platform.release()}",
        "viewport_css": [opts.width, opts.height],
        "device_pixel_ratio": DEVICE_PIXEL_RATIO,
        "timeout_seconds": opts.timeout_seconds,
        "server_bin": str(opts.server_bin),
    }
    print(json.dumps(conditions, indent=2), flush=True)

    runs: list[RunSummary] = []
    for round_index in range(1, opts.rounds + 1):
        # Alternate the order each round, so neither side always runs first.
        order = modes if round_index % 2 == 1 else list(reversed(modes))
        for mode in order:
            try:
                run = drive(
                    opts.out,
                    opts.dataset,
                    round_index,
                    mode,
                    command,
                    opts.server_bin,
                    opts.web_dist,
                    opts.width,
                    opts.height,
                    opts.timeout_seconds,
                )
            except Exception as error:  # noqa: BLE001 - one failed run must not end the round
                run = RunSummary(
                    round=round_index,
                    mode=mode,
                    run_file="",
                    screenshot="",
                    open_seconds=0.0,
                    settled=False,
                    end_reason=None,
                    duration_seconds=0.0,
                    target_level="none",
                    level_pinned=None,
                    planned_at_target=0,
                    detail_per_rebuild=0,
                    coarse_per_rebuild=0,
                    ticks=0,
                    detail_rows_at_target=0,
                    detail_filled_seconds=None,
                    rows_truncated=False,
                    backend_reads=0,
                    backend_bytes=0,
                    read_span_seconds=0.0,
                    reads_per_second=0.0,
                    megabytes_per_second=0.0,
                    desired_detail_at_end=None,
                    resident_detail_at_end=None,
                    desired_coarse_at_end=None,
                    resident_coarse_at_end=None,
                    error=str(error).splitlines()[0] if str(error) else type(error).__name__,
                )
            runs.append(run)
            print(table([run]).splitlines()[-1], flush=True)
            (opts.out / "summary.json").write_text(
                json.dumps({"conditions": conditions, "runs": [asdict(r) for r in runs]}, indent=2)
            )

    print()
    print(table(runs), flush=True)
    print(f"\nsummary in {opts.out / 'summary.json'}", flush=True)
    return 0 if all(run.error is None for run in runs) else 1


if __name__ == "__main__":
    sys.exit(main())
