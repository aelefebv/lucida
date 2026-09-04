#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["zarr>=3.1,<4", "numpy>=2", "pillow>=10"]
# ///
"""Prove the sharded store end to end, at device pixel ratio 2.

The check writes two twin pairs with the generator beside this script, opens
each dataset through ``lucida trace`` in its own workspace, and then reads
what came back:

1. Every run settled: the page published quiescent and closed its own run.
2. Each pair's two frames are not blank and match to within one level of
   an 8-bit channel, so the layout of the store never changes what the
   viewer shows. Two runs of one dataset differ by that much: the renderer
   is not bit-reproducible across page loads, and a wrong or missing inner
   chunk moves pixels by far more than one level.
3. In the sharded runs, every backend read the trace recorded moved exactly
   one inner chunk, one shard index, or the two together. Nothing read a
   shard whole. The expected sizes come from the shard indexes on disk, so
   the comparison is exact rather than a threshold.
4. In the unsharded runs, every backend read moved exactly one chunk object.
5. The second pair has one source level too large to serve as the coarse
   tier, so the server generates a coarse level over it. Both runs request
   and receive that generated level, and the pair still matches.

The second pair is one image whose source grid holds fewer than the 32
chunks the server generates on its own after an open, because a generated
level has one chunk per source chunk and a static view does not ask for
the rest (see issue #1034). The check opens each of the pair's datasets
first and waits for that fill to finish, so the run measures a complete
tier and not the fill.

The trace carries the byte count of each backend read because the server's
timing rows do (``backend_bytes``). A read the trace attributes to a
follower or a cache hit carries none, and is counted rather than judged.

Prerequisites: a running lucida server that serves the web bundle, the
``lucida`` CLI on ``PATH`` or named with ``--lucida``, and Chrome. The server
must be able to read the output directory, so run the check on the machine
the server runs on. ``scripts/dev.sh`` is not enough on its own: the trace
driver loads the page from the server, so build the bundle first
(``pnpm run build`` in ``lucida-web``) or point ``LUCIDA_WEB_DIST`` at one.

    uv run extras/verify_sharded_twins.py [--server URL] [--out DIR] [--keep]

Options:

    --server URL         The lucida server. Default http://127.0.0.1:9876.
    --lucida CMD         The CLI to run, as one shell string. Default
                         ``lucida``, or ``cargo run -q -p lucida-cli --``
                         when that is not on PATH.
    --out DIR            Where the datasets, frames, and run files land.
                         Default a fresh temporary directory.
    --keep               Keep the output directory on success. It is always
                         kept on failure, and its path is printed.
    --timeout-seconds N  How long each run may take to settle. Default 180.
    --tiles N            Tiles in the pyramid pair's collection. Default 4.
    --size Y,X           Level 0 size of each pyramid tile. Default 1024,1024.
    --channels C         Channels in the pyramid pair. Default 2.
    --levels N           Levels in the pyramid pair. Default 4.
    --chunk S            Inner chunk edge of the pyramid pair. Default 64.
    --shard S            Shard edge, both pairs. Default 512.
    --coarse-size Y,X    Size of the generated-coarse pair's one level.
                         Default 768,2304. Keep the long axis above 2048 or
                         the server serves the source level as the coarse
                         tier and generates nothing.
    --coarse-chunk S     Inner chunk edge of the generated-coarse pair.
                         Default 256. Keep the source grid under 32 chunks.

The exit status is 0 when every check passed and 1 otherwise. The report on
stdout says which check failed and where the evidence is.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic_ome_zarr as gen  # noqa: E402

# A chunk key is `level/t/c/z/y/x`; this is the order of the five axes after the level.
CANONICAL_AXES = ("t", "c", "z", "y", "x")

# One shard index entry is a little-endian (offset, nbytes) pair of u64.
INDEX_ENTRY_BYTES = 16
CHECKSUM_BYTES = 4
ABSENT_ENTRY = (2**64 - 1, 2**64 - 1)

DEFAULT_SERVER = "http://127.0.0.1:9876"
DEFAULT_TIMEOUT_SECONDS = 180
# Every frame is taken at this ratio. It is the driver's default too, but
# the check names it so a change to the default cannot quietly weaken it.
DEVICE_PIXEL_RATIO = 2

# The largest long axis the server serves from the source as the coarse
# tier (`SourceCoarseConfig::default().max_long_axis` in lucida-store). A
# single level above it is what makes the server generate coarse levels.
SOURCE_COARSE_MAX_LONG_AXIS = 2048
# How many generated chunks the server fills on its own after an open
# (`GeneratedCoarseConfig::default().background_chunk_limit` in
# lucida-server). The generated-coarse pair keeps its source grid under it.
GENERATED_BACKGROUND_CHUNK_LIMIT = 32
# The largest per-channel difference two frames may show and still match:
# one level of an 8-bit channel, which is what two page loads of one
# dataset differ by.
FRAME_TOLERANCE = 1
# How long to wait for the server's own generated fill after an open.
GENERATED_FILL_TIMEOUT_SECONDS = 60


# ---------------------------------------------------------------------------
# What the store holds on disk
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ArrayLayout:
    """One level array's chunking, as its ``zarr.json`` declares it."""

    axes: tuple[str, ...]
    inner_chunk_shape: tuple[int, ...]
    shard_shape: tuple[int, ...] | None
    index_location: str
    index_checksum: bool

    @property
    def sharded(self) -> bool:
        return self.shard_shape is not None

    @property
    def chunks_per_shard(self) -> tuple[int, ...]:
        assert self.shard_shape is not None
        return tuple(s // c for s, c in zip(self.shard_shape, self.inner_chunk_shape))

    @property
    def index_bytes(self) -> int:
        entries = 1
        for n in self.chunks_per_shard:
            entries *= n
        return entries * INDEX_ENTRY_BYTES + (CHECKSUM_BYTES if self.index_checksum else 0)

    @staticmethod
    def read(level_dir: Path) -> ArrayLayout:
        meta = json.loads((level_dir / "zarr.json").read_text())
        axes = tuple(meta["dimension_names"])
        grid_shape = tuple(meta["chunk_grid"]["configuration"]["chunk_shape"])
        codecs = meta["codecs"]
        if codecs and codecs[0]["name"] == "sharding_indexed":
            config = codecs[0]["configuration"]
            index_codecs = config.get("index_codecs", [])
            return ArrayLayout(
                axes=axes,
                inner_chunk_shape=tuple(config["chunk_shape"]),
                shard_shape=grid_shape,
                index_location=config.get("index_location", "end"),
                index_checksum=any(c["name"] == "crc32c" for c in index_codecs),
            )
        return ArrayLayout(
            axes=axes,
            inner_chunk_shape=grid_shape,
            shard_shape=None,
            index_location="end",
            index_checksum=False,
        )


def image_prefix(image_id: str) -> str:
    """The store prefix of an image, from the id the trace rows carry.

    A collection tile's image id is ``<dataset>:image:<prefix>``; a single
    image's id is the dataset id and its arrays sit at the root.
    """
    marker = ":image:"
    if marker in image_id:
        return image_id.split(marker, 1)[1]
    return ""


def grid_coords(chunk_key: str, layout: ArrayLayout) -> tuple[str, tuple[int, ...]]:
    """Split a chunk key into its level and one inner-grid coordinate per on-disk axis.

    An axis the array does not declare is left out; a wire ``t`` or ``c``
    bundled several to a chunk is divided by that chunk size, as the store
    does.
    """
    parts = chunk_key.split("/")
    if len(parts) != 6:
        raise ValueError(f"chunk key {chunk_key!r} does not have six parts")
    level = parts[0]
    coords = []
    for axis_index, name in enumerate(layout.axes):
        canonical = CANONICAL_AXES.index(name.lower()) if name.lower() in CANONICAL_AXES else None
        if canonical is None:
            coords.append(0)
            continue
        value = int(parts[canonical + 1])
        chunk = layout.inner_chunk_shape[axis_index]
        if canonical in (0, 1) and chunk > 1:
            value //= chunk
        coords.append(value)
    return level, tuple(coords)


def read_shard_index(shard_path: Path, layout: ArrayLayout) -> list[tuple[int, int]]:
    """The (offset, nbytes) entries of one shard, in C order over its inner grid."""
    data = shard_path.read_bytes()
    n = layout.index_bytes
    raw = data[-n:] if layout.index_location == "end" else data[:n]
    if layout.index_checksum:
        raw = raw[:-CHECKSUM_BYTES]
    count = len(raw) // INDEX_ENTRY_BYTES
    values = struct.unpack("<" + "QQ" * count, raw)
    return [(values[2 * i], values[2 * i + 1]) for i in range(count)]


@dataclass(frozen=True)
class ReadShape:
    """What one chunk key costs to read from this store, in bytes.

    ``object_bytes`` is the whole chunk object of an unsharded level.
    ``inner_bytes`` is the inner chunk's range inside its shard and
    ``index_bytes`` the shard's index; a row that read both in one request
    reports their sum. ``written`` is false for an inner chunk the index
    marks absent, which costs an index read and nothing more.
    """

    path: Path
    object_bytes: int | None = None
    inner_bytes: int | None = None
    index_bytes: int | None = None
    written: bool = True

    @property
    def sharded(self) -> bool:
        return self.index_bytes is not None

    @property
    def allowed(self) -> dict[int, str]:
        """Each byte count a row may report for this key, and what it means."""
        if not self.sharded:
            assert self.object_bytes is not None
            return {self.object_bytes: "object"}
        assert self.index_bytes is not None
        allowed = {self.index_bytes: "index"}
        if self.written and self.inner_bytes is not None:
            allowed[self.inner_bytes] = "inner-chunk"
            allowed[self.inner_bytes + self.index_bytes] = "index+inner-chunk"
        return allowed


def read_shape(root: Path, image_id: str, chunk_key: str) -> ReadShape | None:
    """The bytes a read of ``chunk_key`` should move, or None for a level the store does not hold.

    A level with no array on disk is a generated level: the server derives
    it and a request for it never reads the source on the request's path.
    """
    level = chunk_key.split("/", 1)[0]
    level_dir = root / image_prefix(image_id) / level
    if not (level_dir / "zarr.json").is_file():
        return None
    layout = ArrayLayout.read(level_dir)
    _, coords = grid_coords(chunk_key, layout)
    if not layout.sharded:
        path = level_dir.joinpath("c", *map(str, coords))
        return ReadShape(path=path, object_bytes=path.stat().st_size if path.is_file() else 0)
    shard_coords = []
    position = 0
    for coord, per_shard in zip(coords, layout.chunks_per_shard):
        shard_coords.append(coord // per_shard)
        position = position * per_shard + coord % per_shard
    shard_path = level_dir.joinpath("c", *map(str, shard_coords))
    if not shard_path.is_file():
        return ReadShape(path=shard_path, index_bytes=layout.index_bytes, written=False)
    entry = read_shard_index(shard_path, layout)[position]
    if entry == ABSENT_ENTRY:
        return ReadShape(path=shard_path, index_bytes=layout.index_bytes, written=False)
    return ReadShape(path=shard_path, inner_bytes=entry[1], index_bytes=layout.index_bytes)


# ---------------------------------------------------------------------------
# Reading a run
# ---------------------------------------------------------------------------


@dataclass
class ReadAudit:
    """Every chunk row of one run, sorted by what its backend read moved."""

    dataset: Path
    by_kind: dict[str, int] = field(default_factory=dict)
    no_read: int = 0
    generated: int = 0
    unlabelled: int = 0
    violations: list[str] = field(default_factory=list)
    largest_read: int = 0
    smallest_shard: int | None = None

    @property
    def range_reads(self) -> int:
        return sum(count for kind, count in self.by_kind.items() if "inner-chunk" in kind)

    @property
    def ok(self) -> bool:
        return not self.violations

    def count(self, kind: str) -> None:
        self.by_kind[kind] = self.by_kind.get(kind, 0) + 1


def audit_reads(root: Path, run: dict) -> ReadAudit:
    """Compare every chunk row's backend bytes with what its key costs on disk.

    A server row joins its browser row on the correlation label, which is
    what names the chunk key. Coalesced browser rows share one label and one
    key, so a label with several keys is read against each and accepted if
    any explains the bytes.
    """
    audit = ReadAudit(dataset=root)
    keys_by_label: dict[tuple[int, int], set[tuple[str, str]]] = {}
    for row in run.get("rows", []):
        if row.get("connectionGeneration", 0) == 0:
            continue
        label = (row["connectionGeneration"], row["rid"])
        keys_by_label.setdefault(label, set()).add((row["imageId"], row["chunkKey"]))

    for row in run.get("serverRows", []):
        if row.get("family") != "chunk":
            continue
        bytes_moved = row.get("backendBytes")
        label = (row.get("connectionGeneration", 0), row.get("rid", 0))
        keys = keys_by_label.get(label)
        if not keys:
            audit.unlabelled += 1
            continue
        shapes = {key: read_shape(root, *key) for key in keys}
        if all(shape is None for shape in shapes.values()):
            audit.generated += 1
            if bytes_moved is not None:
                audit.violations.append(
                    f"label {label}: a generated level's request read {bytes_moved} bytes from the source"
                )
            continue
        if bytes_moved is None:
            audit.no_read += 1
            continue
        audit.largest_read = max(audit.largest_read, bytes_moved)
        matched = None
        for (image_id, chunk_key), shape in shapes.items():
            if shape is None:
                continue
            if shape.sharded:
                shard_bytes = shape.path.stat().st_size if shape.path.is_file() else None
                if shard_bytes is not None:
                    audit.smallest_shard = (
                        shard_bytes if audit.smallest_shard is None else min(audit.smallest_shard, shard_bytes)
                    )
            kind = shape.allowed.get(bytes_moved)
            if kind is not None:
                matched = kind
                break
        if matched is None:
            expected = "; ".join(
                f"{image_id} {chunk_key}: {sorted(shape.allowed.items())}"
                for (image_id, chunk_key), shape in shapes.items()
                if shape is not None
            )
            audit.violations.append(f"label {label}: read {bytes_moved} bytes, expected one of {expected}")
            continue
        audit.count(matched)
    return audit


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


def levels_requested(run: dict) -> set[int]:
    return {int(row["level"]) for row in run.get("rows", [])}


# ---------------------------------------------------------------------------
# Comparing frames
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FrameComparison:
    width: int
    height: int
    colors: tuple[int, int]
    differing_fraction: float
    # The largest difference in any channel of any pixel; 255 for frames of
    # different size.
    max_delta: int

    @property
    def blank(self) -> bool:
        return min(self.colors) < 2

    @property
    def matches(self) -> bool:
        return self.max_delta <= FRAME_TOLERANCE


def load_frame(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGBA"))


def distinct_colors(frame: np.ndarray) -> int:
    flat = frame.reshape(-1, frame.shape[-1])
    return int(np.unique(flat, axis=0).shape[0])


def compare_frames(first: Path, second: Path, diff_out: Path | None = None) -> FrameComparison:
    """Compare two frames pixel for pixel. Frames of different size never match.

    ``diff_out`` gets a picture of the pixels that differ by more than the
    tolerance, and nothing when there are none.
    """
    a = load_frame(first)
    b = load_frame(second)
    colors = (distinct_colors(a), distinct_colors(b))
    if a.shape != b.shape:
        return FrameComparison(a.shape[1], a.shape[0], colors, 1.0, 255)
    delta = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=-1)
    fraction = float((delta > 0).mean())
    beyond = delta > FRAME_TOLERANCE
    if beyond.any() and diff_out is not None:
        highlight = np.zeros_like(a)
        highlight[..., 3] = 255
        highlight[beyond] = (255, 0, 255, 255)
        Image.fromarray(highlight).save(diff_out)
    return FrameComparison(a.shape[1], a.shape[0], colors, fraction, int(delta.max()))


# ---------------------------------------------------------------------------
# Driving the stack
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TwinPair:
    """One generator recipe written twice: once per chunk, once in shards."""

    name: str
    generator_args: tuple[str, ...]
    shard: int
    # The levels the generator writes; anything the viewer requests above
    # this is a generated level.
    source_levels: int
    # Whether the server generates the coarse tier over this pair, in which
    # case the check waits for that fill before it opens the view.
    generated_coarse: bool = False

    def unsharded_args(self, out: Path) -> list[str]:
        return [str(out / f"{self.name}-unsharded.ome.zarr"), *self.generator_args, "--overwrite"]

    def sharded_args(self, out: Path) -> list[str]:
        return [
            str(out / f"{self.name}-sharded.ome.zarr"),
            *self.generator_args,
            "--shard",
            str(self.shard),
            "--overwrite",
        ]


@dataclass
class DrivenRun:
    """What one ``lucida trace`` left behind."""

    dataset: Path
    workspace_id: str
    run_file: Path
    screenshot: Path
    settled: bool
    end_reason: str | None
    verdict: str | None

    @property
    def run(self) -> dict:
        return run_in_document(self.run_file)


class Lucida:
    """The CLI, bound to one server and a private config file."""

    def __init__(self, command: Sequence[str], server: str, config_path: Path):
        self.command = list(command)
        self.server = server
        self.env = dict(os.environ, LUCIDA_CONFIG_PATH=str(config_path))

    def json(self, *args: str, timeout: float) -> dict:
        argv = [*self.command, "--server", self.server, "--json", *args]
        print("$", shlex.join(argv), flush=True)
        completed = subprocess.run(argv, env=self.env, capture_output=True, text=True, timeout=timeout)
        if completed.returncode != 0:
            raise RuntimeError(
                f"{shlex.join(argv)} exited {completed.returncode}\n{completed.stdout}\n{completed.stderr}"
            )
        # The CLI may print progress lines before the payload; the payload
        # is the last JSON object on stdout.
        text = completed.stdout.strip()
        start = text.rfind("\n{")
        return json.loads(text if start < 0 else text[start + 1 :])

    def create_workspace(self, name: str, timeout: float = 60.0) -> str:
        return self.json("workspace", "create", name, timeout=timeout)["workspace"]["id"]

    def open_dataset(self, dataset: Path, workspace_id: str, timeout: float = 300.0) -> None:
        self.json("--workspace", workspace_id, "dataset", "open", str(dataset), timeout=timeout)

    def generated_ready_chunks(self, workspace_id: str, timeout: float = 60.0) -> int:
        return ready_generated_chunks(self.json("--workspace", workspace_id, "dataset", "health", timeout=timeout))

    def trace(self, dataset: Path, workspace_id: str, out: Path, stem: str, timeout_seconds: int) -> DrivenRun:
        run_file = out / f"{stem}.run.json"
        screenshot = out / f"{stem}.png"
        payload = self.json(
            "--workspace",
            workspace_id,
            "trace",
            str(dataset),
            "--output",
            str(run_file),
            "--screenshot",
            str(screenshot),
            "--device-pixel-ratio",
            str(DEVICE_PIXEL_RATIO),
            "--timeout-seconds",
            str(timeout_seconds),
            timeout=timeout_seconds + 120,
        )
        header = payload["header"]
        verdict = payload.get("verdict") or {}
        return DrivenRun(
            dataset=dataset,
            workspace_id=workspace_id,
            run_file=run_file,
            screenshot=screenshot,
            settled=bool(header.get("settled")),
            end_reason=header.get("endReason"),
            verdict=verdict.get("kind"),
        )


def ready_generated_chunks(health: dict) -> int:
    """The generated chunks ``lucida dataset health`` reports ready, summed over the workspace's datasets."""
    return sum(int(dataset["generated_coarse"]["ready_chunks"]) for dataset in health.get("datasets", []))


def wait_for_generated_fill(lucida: Lucida, workspace_id: str, timeout_seconds: float) -> int:
    """Wait until the server's own generated fill has stopped growing, and return its size.

    The server fills a bounded number of generated chunks after an open and
    then stops, so the fill is done when two readings a second apart agree
    and at least one chunk is ready. A fill that has not started by the
    deadline is reported as what it is: zero.
    """
    deadline = time.monotonic() + timeout_seconds
    previous = -1
    while True:
        ready = lucida.generated_ready_chunks(workspace_id)
        if ready > 0 and ready == previous:
            return ready
        if time.monotonic() >= deadline:
            return ready
        previous = ready
        time.sleep(1.0)


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
    lines: list[str] = field(default_factory=list)

    def say(self, line: str) -> None:
        self.lines.append(line)
        print(line, flush=True)

    def check(self, ok: bool, what: str) -> None:
        self.say(f"{'ok  ' if ok else 'FAIL'} {what}")
        if not ok:
            self.failures.append(what)


def check_pair(pair: TwinPair, unsharded: DrivenRun, sharded: DrivenRun, out: Path, report: Report) -> None:
    for run in (unsharded, sharded):
        report.check(
            run.settled,
            f"{pair.name}: {run.dataset.name} settled (end reason {run.end_reason}, verdict {run.verdict})",
        )

    diff = out / f"{pair.name}-diff.png"
    frames = compare_frames(unsharded.screenshot, sharded.screenshot, diff)
    report.check(
        not frames.blank,
        f"{pair.name}: both frames are not blank ({frames.width}x{frames.height}, "
        f"{frames.colors[0]} and {frames.colors[1]} distinct colors)",
    )
    report.check(
        frames.matches,
        f"{pair.name}: frames match within {FRAME_TOLERANCE} level per channel "
        f"(largest difference {frames.max_delta}, {frames.differing_fraction:.2%} of pixels differ at all)"
        + ("" if frames.matches else f"; see {diff}"),
    )

    for run in (unsharded, sharded):
        audit = audit_reads(run.dataset, run.run)
        kinds = ", ".join(f"{count} {kind}" for kind, count in sorted(audit.by_kind.items())) or "none"
        report.say(
            f"     {run.dataset.name}: backend reads {kinds}; {audit.no_read} rows read nothing "
            f"(followers and cache hits), {audit.generated} generated-level rows, {audit.unlabelled} unlabelled"
        )
        if audit.smallest_shard is not None:
            report.say(
                f"     largest read {audit.largest_read} bytes; smallest shard object {audit.smallest_shard} bytes"
            )
        for violation in audit.violations[:10]:
            report.say(f"       {violation}")
        report.check(audit.ok, f"{pair.name}: every backend read in {run.dataset.name} is sized to its key")


def check_pyramid(pair: TwinPair, sharded: DrivenRun, report: Report) -> None:
    """A read check that met no reads proves nothing, so the pyramid pair must have some."""
    audit = audit_reads(sharded.dataset, sharded.run)
    report.check(
        audit.range_reads > 0,
        f"{pair.name}: the sharded run read at least one inner chunk by range ({audit.range_reads} reads)",
    )


def check_generated_coarse(pair: TwinPair, unsharded: DrivenRun, sharded: DrivenRun, report: Report) -> None:
    for run in (unsharded, sharded):
        generated = sorted(level for level in levels_requested(run.run) if level >= pair.source_levels)
        report.check(
            bool(generated),
            f"{pair.name}: {run.dataset.name} requested the generated coarse level {generated}",
        )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="verify_sharded_twins.py",
        description="Generate sharded and unsharded twins, open both at DPR 2, and compare. See the module docstring.",
    )
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--lucida", default=None, metavar="CMD", help="the CLI to run, as one shell string")
    parser.add_argument("--out", type=Path, default=None, metavar="DIR")
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS, metavar="N")
    parser.add_argument("--tiles", type=int, default=4, metavar="N")
    parser.add_argument("--size", default="1024,1024", metavar="Y,X")
    parser.add_argument("--channels", type=int, default=2, metavar="C")
    parser.add_argument("--levels", type=int, default=4, metavar="N")
    parser.add_argument("--chunk", type=int, default=64, metavar="S")
    parser.add_argument("--shard", type=int, default=512, metavar="S")
    parser.add_argument("--coarse-size", default="768,2304", metavar="Y,X")
    parser.add_argument("--coarse-chunk", type=int, default=256, metavar="S")
    return parser.parse_args(argv)


def twin_pairs(args: argparse.Namespace) -> list[TwinPair]:
    pyramid = TwinPair(
        name="pyramid",
        generator_args=(
            "--tiles", str(args.tiles),
            "--size", args.size,
            "--channels", str(args.channels),
            "--levels", str(args.levels),
            "--chunk", str(args.chunk),
            "--seed", "1",
        ),
        shard=args.shard,
        source_levels=args.levels,
    )
    coarse_size = [int(v) for v in args.coarse_size.split(",")]
    if max(coarse_size) <= SOURCE_COARSE_MAX_LONG_AXIS:
        raise SystemExit(
            f"--coarse-size long axis {max(coarse_size)} must exceed {SOURCE_COARSE_MAX_LONG_AXIS}, "
            "or the server serves the source level as the coarse tier and generates nothing"
        )
    source_chunks = 1
    for extent in coarse_size:
        source_chunks *= -(-extent // args.coarse_chunk)
    if source_chunks >= GENERATED_BACKGROUND_CHUNK_LIMIT:
        raise SystemExit(
            f"--coarse-size {args.coarse_size} in {args.coarse_chunk}-sample chunks is {source_chunks} chunks; "
            f"keep it under {GENERATED_BACKGROUND_CHUNK_LIMIT}, or the server's own fill stops short of the "
            "generated level and a static view never asks for the rest (issue #1034)"
        )
    coarse = TwinPair(
        name="coarse",
        generator_args=(
            "--size", args.coarse_size,
            "--levels", "1",
            "--chunk", str(args.coarse_chunk),
            "--seed", "2",
        ),
        shard=args.shard,
        source_levels=1,
        generated_coarse=True,
    )
    return [pyramid, coarse]


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    out = args.out or Path(tempfile.mkdtemp(prefix="lucida-sharded-twins-"))
    out.mkdir(parents=True, exist_ok=True)
    out = out.resolve()
    command = shlex.split(args.lucida) if args.lucida else default_lucida_command()
    lucida = Lucida(command, args.server, out / "config.json")
    report = Report()
    report.say(f"output {out}")

    pairs = twin_pairs(args)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    runs: dict[tuple[str, str], DrivenRun] = {}
    for pair in pairs:
        for layout, generator_args in (("unsharded", pair.unsharded_args(out)), ("sharded", pair.sharded_args(out))):
            dataset = generate(generator_args)
            workspace_id = lucida.create_workspace(f"sharded-twins {stamp} {pair.name} {layout}")
            if pair.generated_coarse:
                lucida.open_dataset(dataset, workspace_id)
                ready = wait_for_generated_fill(lucida, workspace_id, GENERATED_FILL_TIMEOUT_SECONDS)
                report.say(f"generated fill for {dataset.name}: {ready} chunks ready")
            runs[(pair.name, layout)] = lucida.trace(
                dataset, workspace_id, out, f"{pair.name}-{layout}", args.timeout_seconds
            )

    for pair in pairs:
        unsharded = runs[(pair.name, "unsharded")]
        sharded = runs[(pair.name, "sharded")]
        check_pair(pair, unsharded, sharded, out, report)
        if pair.source_levels > 1:
            check_pyramid(pair, sharded, report)
        else:
            check_generated_coarse(pair, unsharded, sharded, report)

    if report.failures:
        report.say(f"\n{len(report.failures)} check(s) failed; evidence kept in {out}")
        return 1
    report.say("\nevery check passed")
    if not args.keep:
        shutil.rmtree(out, ignore_errors=True)
    else:
        report.say(f"kept {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
