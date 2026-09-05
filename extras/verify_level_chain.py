#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10"]
# ///
"""Prove the level chain end to end, at device pixel ratio 2.

The check writes a level-index pyramid with the generator beside this
script and opens it four times through ``lucida trace``: zoomed in and
zoomed out, in slice mode and in volume mode. Each run names the level it
means to reach, and the check derives the camera for it: a zoom squarely
inside the band of zooms that level owns, in device pixels per level-0
sample, which is the one measure the target level is chosen from. Then it
reads what came back and requires four independent answers to name the
same level:

1. **The rule.** This script applies ADR 0061's rule to the level shapes
   on disk and the zoom it asked for: the coarsest level whose samples
   are still no more than one device pixel apart. It never reads the
   core's answer to get it.
2. **The core.** ``lucida trace`` records the target level lucida-core
   computes for the camera it composed, in the run header.
3. **The trace.** The run's last per-tick aggregate carries the target
   level the browser planned at, the level it displayed, and how many
   detail chunks each planning pass requested.
4. **The screenshot.** Every sample at level L holds the value L, so the
   frame the run leaves is a flat gray that names the level it was drawn
   from. The runs pin a gray colormap and a contrast window of −1 to the
   coarsest level, so level L reads as ``(L + 1) / levels`` of white:
   evenly spaced, never black, and never the background.

Each run must also reach quiescence, and the detail chunks it requested
per planning pass must fit the bound ADR 0061 states: the entity's
on-screen area over the footprint of one target-level chunk, plus a chunk
of border per axis, and in volume mode the depth of the frustum's cut in
chunks again. The zoomed-in slice run places the image well past the
viewport's edges, so its wanted set is bounded by the screen and not by
the level; the other three runs fit on screen, where the bound is the
level's own chunk grid plus the border.

The volume runs stay off level 0. In a level-index pyramid every sample
at level 0 is 0, and the volume ray march skips a zero sample as empty
space, so an all-zero level draws as nothing at all whatever the level
rule chose. That is the march's own rule and the generator's documented
property, not a level-selection fault, and the slice runs cover level 0
where a zero sample draws normally.

The displayed level is read when the trace carries one and reported when
it does not. A local open this small reaches quiescence inside a single
planning pass, and the render worker's word on which level is on screen
necessarily arrives after it, so a run that never re-plans has no tick to
carry it. The frame is the witness of what was displayed in that case.

Prerequisites: a running lucida server that serves the web bundle, the
``lucida`` CLI on ``PATH`` or named with ``--lucida``, and Chrome. The
server must be able to read the output directory, so run the check on the
machine the server runs on. ``scripts/dev.sh`` is not enough on its own:
the trace driver loads the page from the server, so build the bundle
first (``pnpm run build`` in ``lucida-web``) or point ``LUCIDA_WEB_DIST``
at one.

    uv run extras/verify_level_chain.py [--server URL] [--out DIR] [--keep]

Options:

    --server URL         The lucida server. Default http://127.0.0.1:9876.
    --lucida CMD         The CLI to run, as one shell string. Default
                         ``lucida``, or ``cargo run -q -p lucida-cli --``
                         when that is not on PATH.
    --out DIR            Where the dataset, frames, and run files land.
                         Default a fresh temporary directory.
    --keep               Keep the output directory on success. It is
                         always kept on failure, and its path is printed.
    --timeout-seconds N  How long each run may take to reach quiescence.
                         Default 180.
    --size Z,Y,X         Level 0 size of the pyramid. Default 64,512,512.
    --levels N           Levels in the pyramid. Default 4.
    --chunk S            Chunk edge. Default 32.
    --slice-levels A,B   The levels the two slice runs must reach, zoomed
                         in first. Default 0,2.
    --volume-levels A,B  The same for the two volume runs. Default 1,2.
    --dataset PATH       Use this dataset instead of generating one. Its
                         samples must be the level index.

The exit status is 0 when every check passed and 1 otherwise. The report
on stdout says which check failed and where the evidence is.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic_ome_zarr as gen  # noqa: E402

DEFAULT_SERVER = "http://127.0.0.1:9876"
DEFAULT_TIMEOUT_SECONDS = 180

# The driver's own defaults, named here so a change to a default cannot
# quietly move the bound or weaken the ratio.
DEVICE_PIXEL_RATIO = 2
VIEWPORT_CSS = (1440, 900)

# Indices into a (z, y, x) spatial shape.
IN_PLANE_AXES = (1, 2)
VOLUME_AXES = (0, 1, 2)

# The colormap ramp is sampled with linear filtering, so a count or two of
# drift between channels is the texture, not the data.
GRAY_TOLERANCE = 6
# Side in device pixels of the center square the level is read from: large
# enough to outvote a stray pixel, small enough to stay inside the data at
# the zoomed-out framings.
CENTER_PATCH = 21


# ---------------------------------------------------------------------------
# The rule, applied to what is on disk
# ---------------------------------------------------------------------------


def _level_arrays(dataset: Path) -> tuple[list[int], list[dict]]:
    """The spatial axis indices and each level's array metadata, in multiscale order."""
    meta = json.loads((dataset / "zarr.json").read_text())
    multiscale = meta["attributes"]["ome"]["multiscales"][0]
    axes = [axis["name"].lower() for axis in multiscale["axes"]]
    spatial = [index for index, name in enumerate(axes) if name in ("z", "y", "x")]
    levels = [json.loads((dataset / entry["path"] / "zarr.json").read_text()) for entry in multiscale["datasets"]]
    return spatial, levels


def level_shapes(dataset: Path) -> list[tuple[int, ...]]:
    """Each level's spatial shape, in the order the multiscale metadata lists them."""
    spatial, levels = _level_arrays(dataset)
    return [tuple(level["shape"][index] for index in spatial) for level in levels]


def chunk_shapes(dataset: Path) -> list[tuple[int, ...]]:
    """Each level's inner chunk shape along the spatial axes."""
    spatial, levels = _level_arrays(dataset)
    shapes = []
    for level in levels:
        grid = tuple(level["chunk_grid"]["configuration"]["chunk_shape"])
        codecs = level["codecs"]
        if codecs and codecs[0]["name"] == "sharding_indexed":
            grid = tuple(codecs[0]["configuration"]["chunk_shape"])
        shapes.append(tuple(grid[index] for index in spatial))
    return shapes


def level_ratios(shapes: Sequence[tuple[int, ...]], axes: Sequence[int]) -> list[float]:
    """How many times coarser each level is than level 0, along ``axes``.

    Each level's ratio is the largest ratio across the resolved axes: the
    most-downsampled axis is the first to spread its samples more than a
    pixel apart. A level no coarser than the one before it along any
    resolved axis offers the view nothing and can never be the target, so
    it gets an infinite ratio. In a slice view that is a level that only
    downsamples the third axis.
    """
    resolved = [tuple(shape[axis] for axis in axes) for shape in shapes]
    ratios = []
    for index, level in enumerate(resolved):
        coarser = index == 0 or any(here < finer for here, finer in zip(level, resolved[index - 1]))
        if not coarser:
            ratios.append(math.inf)
            continue
        ratios.append(max(full / max(here, 1) for here, full in zip(level, resolved[0])))
    return ratios


def expected_target(zoom: float, ratios: Sequence[float]) -> int:
    """ADR 0061's rule: the largest level L with zoom × ratio[L] at most 1, else 0."""
    qualifying = [level for level, ratio in enumerate(ratios) if zoom * ratio <= 1.0]
    return qualifying[-1] if qualifying else 0


def zoom_for_level(level: int, ratios: Sequence[float]) -> float:
    """A zoom squarely inside the band of zooms that ``level`` owns.

    Level L is the target while the measure sits above ``1 / ratio`` of
    the next finer level and at or below ``1 / ratio[L]``. The middle of
    that band on a log scale is the geometric mean of its ends, which is
    the furthest a camera can be from both boundaries: hysteresis holds the
    target across a boundary, so a camera placed on one would make the
    level depend on where the view came from. Level 0 owns everything
    above its lower end, and the coarsest level everything below its upper
    end; the missing end stands in at two octaves from the one there is.
    """
    if not ratios:
        raise ValueError("a pyramid with no levels has no zoom for a level")
    if not 0 <= level < len(ratios) or math.isinf(ratios[level]):
        raise ValueError(f"level {level} is not a level this pyramid can target")
    finer = [ratio for ratio in ratios[level + 1 :] if not math.isinf(ratio)]
    if level == 0:
        low = 1.0 / finer[0] if finer else 1.0
        high = low * 4.0
    else:
        high = 1.0 / ratios[level]
        low = 1.0 / finer[0] if finer else high / 4.0
    return math.sqrt(low * high)


def overflow_zoom(image_samples: tuple[int, int], viewport: tuple[int, int]) -> float:
    """The zoom that places the image one octave past the viewport on both axes.

    Below it the whole image fits on screen and the wanted set is the
    level's own chunk grid; above it the set is cut by the screen, which is
    the regime ADR 0061's bound is about.
    """
    return 2.0 * max(extent / samples for samples, extent in zip(image_samples, viewport))


def wanted_set_bound(
    viewport: tuple[int, int],
    image_samples: tuple[int, int],
    zoom: float,
    ratio: float,
    chunk: int,
    depth_chunks: int,
) -> int:
    """The visible detail wanted set ADR 0061 bounds one entity to.

    The entity covers ``image_samples × zoom`` device pixels, or the
    viewport where that is smaller, and one target-level chunk covers
    ``chunk × ratio × zoom`` of them per axis. The extra chunk per axis is
    the partly covered border, and in volume mode the whole is multiplied
    again by the depth of the view's cut in chunks.
    """
    chunk_px = chunk * ratio * zoom
    per_axis = 1
    for extent, viewport_extent in zip(image_samples, viewport):
        visible = min(extent * zoom, viewport_extent)
        per_axis *= math.ceil(visible / chunk_px) + 1
    return per_axis * depth_chunks


# ---------------------------------------------------------------------------
# What the frame says
# ---------------------------------------------------------------------------


def frame_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def center_color(path: Path, size: int = CENTER_PATCH) -> tuple[int, int, int]:
    """The median color of a square at the center of the frame.

    A median rather than a mean: one stray pixel from a chunk border or a
    cursor must not shift the reading toward a level that was never drawn.
    """
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        width, height = rgb.size
        half = size // 2
        box = (width // 2 - half, height // 2 - half, width // 2 + half + 1, height // 2 + half + 1)
        pixels = list(rgb.crop(box).getpixel((x, y)) for y in range(size) for x in range(size))
    channels = []
    for index in range(3):
        values = sorted(pixel[index] for pixel in pixels)
        channels.append(values[len(values) // 2])
    return tuple(channels)  # type: ignore[return-value]


def level_from_color(color: tuple[int, int, int], levels: int) -> int | None:
    """Which level a frame's color names, or None when it names none.

    The runs pin a gray colormap and a contrast window of −1 to
    ``levels - 1``, so level L is drawn at ``(L + 1) / levels`` of white.
    A color that is not neutral, or not within tolerance of one of those
    grays, names no level at all.
    """
    if max(color) - min(color) > GRAY_TOLERANCE:
        return None
    value = sum(color) / 3
    for level in range(levels):
        if abs(value - (level + 1) / levels * 255) <= GRAY_TOLERANCE:
            return level
    return None


# ---------------------------------------------------------------------------
# What the trace says
# ---------------------------------------------------------------------------


@dataclass
class TraceLevels:
    """The levels one run's per-tick aggregates report, and its shape."""

    target: tuple[int, int] | None = None
    displayed: tuple[int, int] | None = None
    # The largest detail-lane wanted set any planning pass at the final target
    # emitted. The largest is the honest one: later passes plan only what is
    # still missing.
    detail_per_rebuild: int = 0
    level_changes: list[tuple[tuple[int, int], tuple[int, int]]] = field(default_factory=list)
    duration_seconds: float = 0.0
    ticks: int = 0


def _range(value: dict | None) -> tuple[int, int] | None:
    return None if value is None else (int(value["min"]), int(value["max"]))


def read_levels(run: dict) -> TraceLevels:
    """Read one run's levels off its per-tick aggregates and point events."""
    ticks = run.get("ticks", [])
    seen = TraceLevels(
        duration_seconds=run["header"].get("durationUs", 0) / 1e6,
        ticks=len(ticks),
    )
    seen.level_changes = [
        (_range(event["levelChange"]["from"]), _range(event["levelChange"]["to"]))
        for event in run.get("events", [])
        if event.get("kind") == "level-change" and event.get("levelChange")
    ]
    if not ticks:
        return seen

    seen.target = _range(ticks[-1].get("targetLevel"))
    for tick in reversed(ticks):
        displayed = _range(tick.get("displayedLevel"))
        if displayed is not None:
            seen.displayed = displayed
            break
    for tick in ticks:
        if _range(tick.get("targetLevel")) != seen.target:
            continue
        # ``laneDetail`` rather than the per-level planned counts, which also
        # carry the coarse, prefetch, and minimap lanes the bound is not about.
        seen.detail_per_rebuild = max(seen.detail_per_rebuild, int(tick.get("counters", {}).get("laneDetail", 0)))
    return seen


def run_in_document(run_file: Path) -> dict:
    """The run the driver waited for, out of the run file it wrote."""
    doc = json.loads(run_file.read_text())
    run_id = doc["header"].get("runId")
    runs = doc["trace"].get("runs", [])
    for run in runs:
        if run["header"]["runId"] == run_id:
            return run
    if runs:
        return runs[-1]
    raise ValueError(f"{run_file} holds no run")


# ---------------------------------------------------------------------------
# Driving the runs
# ---------------------------------------------------------------------------


@dataclass
class DrivenRun:
    """What one ``lucida trace`` left behind."""

    name: str
    camera: str  # ``slice`` or ``arcball``
    zoom: float
    run_file: Path
    screenshot: Path
    viewport: tuple[int, int]  # CSS pixels
    # What lucida-core made of the composed camera: the target level it chose
    # and the zoom it measured there, against the ``zoom`` asked for.
    core_target: tuple[int, int]
    core_zoom: float
    quiescent: bool
    end_reason: str | None
    verdict: str | None

    @property
    def volume(self) -> bool:
        return self.camera != "slice"

    @property
    def device_viewport(self) -> tuple[int, int]:
        return (
            self.viewport[0] * DEVICE_PIXEL_RATIO,
            self.viewport[1] * DEVICE_PIXEL_RATIO,
        )


class Lucida:
    """The CLI, bound to one server and a private config file."""

    def __init__(self, command: Sequence[str], server: str, config_path: Path):
        self.command = list(command)
        self.server = server
        self.env = dict(os.environ, LUCIDA_CONFIG_PATH=str(config_path))

    def call(self, *args: str, timeout: float) -> dict:
        """Run one CLI command with ``--json`` and return its payload."""
        argv = [*self.command, "--server", self.server, "--json", *args]
        print("$", shlex.join(argv), flush=True)
        completed = subprocess.run(argv, env=self.env, capture_output=True, text=True, timeout=timeout)
        if completed.returncode != 0:
            raise RuntimeError(
                f"{shlex.join(argv)} exited {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
            )
        # Progress lines may precede the payload, the last JSON object on stdout.
        text = completed.stdout.strip()
        start = text.rfind("\n{")
        return json.loads(text if start < 0 else text[start + 1 :])

    def create_workspace(self, name: str, timeout: float = 60.0) -> str:
        return self.call("workspace", "create", name, timeout=timeout)["workspace"]["id"]

    def open_dataset(self, dataset: Path, workspace_id: str, timeout: float = 300.0) -> None:
        self.call("--workspace", workspace_id, "dataset", "open", str(dataset), timeout=timeout)

    def trace(
        self,
        dataset: Path,
        workspace_id: str,
        out: Path,
        name: str,
        camera: str,
        zoom: float,
        levels: int,
        timeout_seconds: int,
    ) -> DrivenRun:
        run_file = out / f"{name}.run.json"
        screenshot = out / f"{name}.png"
        payload = self.call(
            "--workspace",
            workspace_id,
            "trace",
            str(dataset),
            "--camera",
            camera,
            "--zoom",
            repr(zoom),
            # With a window of -1..levels-1, level L draws at (L + 1) / levels
            # of white: evenly spaced, never black, never the background.
            "--contrast",
            "-1",
            str(levels - 1),
            "--colormap",
            "gray",
            # A ray takes the largest sample it meets, and every sample of
            # the level is the level, so the volume draws its level flat.
            "--render-mode",
            "max-intensity",
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
            "--timeout-seconds",
            str(timeout_seconds),
            timeout=timeout_seconds + 120,
        )
        header = payload["header"]
        composed = header["composedView"]
        framing = composed["camera"]
        verdict = payload.get("verdict") or {}
        return DrivenRun(
            name=name,
            camera=camera,
            zoom=zoom,
            run_file=run_file,
            screenshot=screenshot,
            viewport=(int(composed["width"]), int(composed["height"])),
            core_target=(int(framing["targetLevel"]["min"]), int(framing["targetLevel"]["max"])),
            core_zoom=float(framing["zoom"]),
            quiescent=bool(header.get("settled")),
            end_reason=header.get("endReason"),
            verdict=verdict.get("kind"),
        )


def default_lucida_command() -> list[str]:
    if shutil.which("lucida"):
        return ["lucida"]
    return ["cargo", "run", "-q", "-p", "lucida-cli", "--"]


def generate(argv: list[str]) -> Path:
    opts = gen.parse_args(argv)
    started = time.monotonic()
    gen.generate(opts)
    print(f"wrote {opts.out} in {time.monotonic() - started:.1f} s", flush=True)
    return opts.out


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


@dataclass
class Report:
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)

    def check(self, ok: bool, failure: str) -> bool:
        if not ok:
            self.failures.append(failure)
        return ok

    def note(self, note: str) -> None:
        self.notes.append(note)

    def say(self, line: str) -> None:
        self.lines.append(line)
        print(line, flush=True)


def run_bound(
    run: DrivenRun,
    shapes: Sequence[tuple[int, ...]],
    chunks: Sequence[tuple[int, ...]],
    level: int,
    ratio: float,
) -> int:
    """The wanted-set bound for ``run`` with ``level`` as its target."""
    depth_chunks = math.ceil(shapes[level][0] / chunks[level][0]) if run.volume else 1
    return wanted_set_bound(
        viewport=run.device_viewport,
        image_samples=(shapes[0][2], shapes[0][1]),
        zoom=run.core_zoom,
        ratio=ratio,
        chunk=max(chunks[level][1], chunks[level][2]),
        depth_chunks=depth_chunks,
    )


def check_run(
    report: Report,
    run: DrivenRun,
    shapes: Sequence[tuple[int, ...]],
    chunks: Sequence[tuple[int, ...]],
) -> None:
    """Hold one run's four answers against each other and against the bound."""
    levels = len(shapes)
    ratios = level_ratios(shapes, VOLUME_AXES if run.volume else IN_PLANE_AXES)
    predicted = expected_target(run.core_zoom, ratios)

    seen = read_levels(run_in_document(run.run_file))
    color = center_color(run.screenshot)
    drawn = level_from_color(color, levels)
    width, height = frame_size(run.screenshot)

    report.say(
        f"  {run.name:16s} zoom {run.core_zoom:<8.4g} rule {predicted}  core "
        f"{fmt_range(run.core_target)}  trace {fmt_range(seen.target)}  displayed "
        f"{fmt_range(seen.displayed)}  frame {drawn} {color}  detail per rebuild "
        f"{seen.detail_per_rebuild}  {seen.duration_seconds:.1f} s"
    )

    report.check(
        run.quiescent,
        f"{run.name}: the run ended as {run.end_reason} rather than quiescent; see {run.run_file}",
    )
    report.check(
        (width, height) == run.device_viewport,
        f"{run.name}: the frame is {width}x{height}, not the {run.device_viewport[0]}x"
        f"{run.device_viewport[1]} device pixels a {run.viewport[0]}x{run.viewport[1]} viewport "
        f"has at device pixel ratio {DEVICE_PIXEL_RATIO}",
    )
    report.check(
        run.core_target == (predicted, predicted),
        f"{run.name}: the core targets {fmt_range(run.core_target)} where the rule applied to the "
        f"level shapes on disk gives {predicted} at {run.core_zoom} device pixels per level-0 sample",
    )
    report.check(
        seen.target == (predicted, predicted),
        f"{run.name}: the trace planned at target {fmt_range(seen.target)}, not the predicted "
        f"{predicted}; see {run.run_file}",
    )
    if seen.displayed is None:
        # The displayed level reaches the aggregate only on the planning pass
        # after the worker reports it, and a local open this small reaches
        # quiescence inside the first pass. A note, not a failure: the frame
        # is the stronger witness and is checked below.
        report.note(
            f"{run.name}: the run reached quiescence in {seen.duration_seconds:.1f} s over "
            f"{seen.ticks} planning pass(es), so no tick carried a displayed level"
        )
    else:
        report.check(
            seen.displayed == (predicted, predicted),
            f"{run.name}: the trace displayed {fmt_range(seen.displayed)}, not the predicted "
            f"{predicted}; see {run.run_file}",
        )
    if report.check(
        drawn is not None,
        f"{run.name}: the frame's center is {color}, which names no level; see {run.screenshot}",
    ):
        report.check(
            drawn == predicted,
            f"{run.name}: the frame was drawn from level {drawn}, not the predicted {predicted}; "
            f"see {run.screenshot}",
        )

    bound = run_bound(run, shapes, chunks, predicted, ratios[predicted])
    report.check(
        0 < seen.detail_per_rebuild <= bound,
        f"{run.name}: a planning pass requested {seen.detail_per_rebuild} detail chunks at level "
        f"{predicted}, outside the 1 to {bound} the ADR bounds it to; see {run.run_file}",
    )


def fmt_range(value: tuple[int, int] | None) -> str:
    if value is None:
        return "none"
    return str(value[0]) if value[0] == value[1] else f"{value[0]}..{value[1]}"


def plan_runs(
    shapes: Sequence[tuple[int, ...]],
    slice_levels: Sequence[int],
    volume_levels: Sequence[int],
) -> list[tuple[str, str, float]]:
    """The four runs as (name, camera, zoom), zoomed in first for each camera.

    A zoomed-in slice run that reaches level 0 is placed past the
    viewport's edges, so at least one run holds the bound where the screen
    and not the level is what cuts the wanted set.
    """
    device_viewport = (VIEWPORT_CSS[0] * DEVICE_PIXEL_RATIO, VIEWPORT_CSS[1] * DEVICE_PIXEL_RATIO)
    runs = []
    for prefix, camera, wanted in (("slice", "slice", slice_levels), ("volume", "arcball", volume_levels)):
        ratios = level_ratios(shapes, IN_PLANE_AXES if camera == "slice" else VOLUME_AXES)
        for position, level in enumerate(wanted):
            zoom = zoom_for_level(level, ratios)
            if camera == "slice" and position == 0 and level == 0:
                zoom = max(zoom, overflow_zoom((shapes[0][2], shapes[0][1]), device_viewport))
            runs.append((f"{prefix}-{'in' if position == 0 else 'out'}", camera, zoom))
    return runs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--lucida", default=None)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--size", default="64,512,512")
    parser.add_argument("--levels", type=int, default=4)
    parser.add_argument("--chunk", type=int, default=32)
    parser.add_argument("--slice-levels", default="0,2")
    parser.add_argument("--volume-levels", default="1,2")
    parser.add_argument("--dataset", type=Path, default=None)
    opts = parser.parse_args(argv)

    out = opts.out or Path(tempfile.mkdtemp(prefix="lucida-level-chain-"))
    out.mkdir(parents=True, exist_ok=True)
    command = shlex.split(opts.lucida) if opts.lucida else default_lucida_command()
    lucida = Lucida(command, opts.server, out / "cli-config.json")
    report = Report()

    dataset = opts.dataset
    if dataset is None:
        dataset = generate(
            [
                str(out / "level-index.ome.zarr"),
                "--size",
                opts.size,
                "--levels",
                str(opts.levels),
                "--chunk",
                str(opts.chunk),
                "--level-index",
                "--overwrite",
            ]
        )
    shapes = level_shapes(dataset)
    chunks = chunk_shapes(dataset)
    report.say(f"dataset  {dataset}")
    report.say(f"levels   {' '.join('x'.join(str(n) for n in shape) for shape in shapes)}")

    stamp = time.strftime("%H%M%S")
    workspace_id = lucida.create_workspace(f"level-chain {stamp}")
    lucida.open_dataset(dataset, workspace_id)

    runs = plan_runs(
        shapes,
        [int(value) for value in opts.slice_levels.split(",")],
        [int(value) for value in opts.volume_levels.split(",")],
    )
    report.say("runs")
    for name, camera, zoom in runs:
        try:
            run = lucida.trace(dataset, workspace_id, out, name, camera, zoom, len(shapes), opts.timeout_seconds)
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            report.check(False, f"{name}: the run did not complete: {error}")
            continue
        check_run(report, run, shapes, chunks)

    if report.notes:
        print("\nnotes", flush=True)
        for note in report.notes:
            print(f"  - {note}", flush=True)

    if report.failures:
        print(f"\nFAILED ({len(report.failures)})", flush=True)
        for failure in report.failures:
            print(f"  - {failure}", flush=True)
        print(f"\nevidence kept in {out}", flush=True)
        return 1

    print(
        "\nPASSED: every run reached quiescence, and the rule, the core, the trace, and the frame agree.",
        flush=True,
    )
    if opts.keep or opts.out is not None:
        print(f"evidence in {out}", flush=True)
    else:
        shutil.rmtree(out, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
