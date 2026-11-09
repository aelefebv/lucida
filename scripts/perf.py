#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Run `lucida trace` over a matrix of datasets, scenarios, device pixel
ratios and networks, and print one table of what each run's diagnostic
says.

    uv run scripts/perf.py                          # the quick suite
    uv run scripts/perf.py --suite full
    uv run scripts/perf.py --dataset volume --scenario orbit,z-scrub --ratio 2
    uv run scripts/perf.py --network remote
    uv run scripts/perf.py --list
    uv run scripts/perf.py --repeat 3 --save-baseline
    uv run scripts/perf.py --suite gate --gate --cli <lucida> --server <url>

It builds whatever is stale (server and CLI, wasm, web bundle), generates the
datasets the selection needs, starts its own server, gives every run a
workspace of its own, and stops the server and every browser on the way out,
Ctrl-C included. `--cli` and `--server` hand it a built CLI and a running
server instead. The catalog, scenarios and suites live in `scripts/perf/`;
`docs/perf.md` describes them.

Every number in the table is a field of a run's diagnostic or its step
records. This script selects and formats; it derives nothing beyond the
median and spread across repeats, a count of the page's errors, and the
change against a baseline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
PERF_DIR = REPO / "scripts" / "perf"
LOCAL_CATALOG = PERF_DIR / "datasets.local.json"
GENERATOR = REPO / "extras" / "synthetic_ome_zarr.py"
EXE = ".exe" if os.name == "nt" else ""

# What a scenario can require of a dataset.
TRAITS = ("volume", "time", "channels", "collection", "labels")
CAMERAS = ("slice", "arcball")
SCENARIO_KEYS = {"description", "requires", "camera", "width", "height", "mobile", "fullUi", "steps"}
DEFAULT_SUITE = "quick"
# Each network is the server's source throttle profile, on its reads, and its
# link throttle profile, on the session socket to the page; `local` is neither.
# The numbers behind each profile, and their sources, are in the server's
# `source_throttle.rs` and `link_throttle.rs`.
NETWORKS = {
    "local": ("local", "local"),
    # A server beside its object store, and the page on the same machine.
    "object-store": ("object-store", "local"),
    # A server across a continent from its store, and the page on a typical
    # office or home link to the server.
    "remote": ("remote", "broadband"),
    # A deployed viewer: a server beside its store, and the page on a typical
    # office or home link to the server.
    "deployed": ("object-store", "broadband"),
}
# The settings a network replaces, and the runner otherwise passes through.
THROTTLE_SETTINGS = ("LUCIDA_SOURCE_THROTTLE", "LUCIDA_LINK_THROTTLE")
# How an add or remove step names a catalog dataset, whose location only the
# runner knows.
DATASET_REF = "dataset:"


class PerfError(Exception):
    """A problem the person running the script has to fix: printed, exit 2."""


# ---------------------------------------------------------------------------
# Catalog, scenarios, suites
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Dataset:
    name: str
    description: str
    traits: frozenset[str]
    # Generator options for a generated dataset; None for a local one.
    generate: tuple[str, ...] | None = None
    # Where a local dataset lives: an absolute path or a URL.
    url: str | None = None


@dataclass(frozen=True)
class Scenario:
    name: str
    description: str
    requires: frozenset[str]
    camera: str
    steps: tuple[dict[str, Any], ...]
    path: Path
    width: int | None = None
    height: int | None = None
    # Drive the page as a phone: a mobile layout, touch input, and a mobile
    # user agent, at the scenario's width and height.
    mobile: bool = False
    # Load the full viewer page, chrome and all, so the run reads the layout
    # a person sees; the capture surface otherwise.
    full_ui: bool = False

    @property
    def adds(self) -> tuple[str, ...]:
        """The catalog datasets its add and remove steps name."""
        urls = [step.get("url") for step in self.steps if step.get("kind") in ("add", "remove")]
        names = [url[len(DATASET_REF) :] for url in urls if isinstance(url, str) and url.startswith(DATASET_REF)]
        return tuple(dict.fromkeys(names))

    def why_not(self, dataset: Dataset) -> str | None:
        """Why it does not run on `dataset`, or None when it does."""
        if not self.requires <= dataset.traits:
            return f"needs {', '.join(sorted(self.requires))}"
        if dataset.name in self.adds:
            return "the trace driver refuses a script that adds the dataset the run opens"
        return None

    def applies_to(self, dataset: Dataset) -> bool:
        return self.why_not(dataset) is None


@dataclass(frozen=True)
class Suite:
    name: str
    description: str
    datasets: tuple[str, ...]
    scenarios: tuple[str, ...]
    ratios: tuple[float, ...]
    # Networks; none leaves the server's throttles as the caller's environment sets them.
    networks: tuple[str, ...] = ()


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise PerfError(f"{path} is not JSON: {error}") from error


def traits_from_options(options: tuple[str, ...]) -> frozenset[str]:
    """What a generated dataset has, read off the generator options that make it."""
    traits: set[str] = set()
    for flag, value in zip(options, options[1:]):
        if flag == "--size" and len(value.split(",")) == 3:
            traits.add("volume")
        elif flag == "--channels" and int(value) > 1:
            traits.add("channels")
        elif flag == "--timepoints" and int(value) > 1:
            traits.add("time")
        elif flag == "--tiles":
            traits.add("collection")
    if "--labels" in options:
        traits.add("labels")
    return frozenset(traits)


def _check_traits(where: str, traits: Any) -> frozenset[str]:
    if not isinstance(traits, list) or not all(isinstance(t, str) for t in traits):
        raise PerfError(f"{where}: traits are a list of names")
    unknown = sorted(set(traits) - set(TRAITS))
    if unknown:
        raise PerfError(f"{where}: unknown trait {', '.join(unknown)}; the traits are {', '.join(TRAITS)}")
    return frozenset(traits)


def load_catalog(catalog_path: Path, local_path: Path | None) -> dict[str, Dataset]:
    """The generated datasets, with the local file's real ones merged in."""
    catalog: dict[str, Dataset] = {}
    for name, entry in _read_json(catalog_path).get("datasets", {}).items():
        where = f"{catalog_path.name}: {name}"
        if set(entry) - {"description", "generate"} or "generate" not in entry:
            raise PerfError(f"{where}: a generated dataset has a description and generate options only")
        options = tuple(shlex.split(entry["generate"]))
        catalog[name] = Dataset(name, entry.get("description", ""), traits_from_options(options), generate=options)
    if local_path is None or not local_path.exists():
        return catalog
    for name, entry in _read_json(local_path).get("datasets", {}).items():
        where = f"{local_path.name}: {name}"
        if name in catalog:
            raise PerfError(f"{where}: the catalog already has a dataset called {name}")
        if set(entry) - {"description", "url", "traits"} or "url" not in entry or "traits" not in entry:
            raise PerfError(f"{where}: a local dataset has a url, its traits, and a description")
        catalog[name] = Dataset(
            name, entry.get("description", ""), _check_traits(where, entry["traits"]), url=entry["url"]
        )
    return catalog


def load_scenario(path: Path) -> Scenario:
    where = f"scenario {path.stem}"
    entry = _read_json(path)
    if not isinstance(entry, dict):
        raise PerfError(f"{where}: a scenario is a JSON object")
    unknown = sorted(set(entry) - SCENARIO_KEYS)
    if unknown:
        raise PerfError(f"{where}: unknown key {', '.join(unknown)}; the keys are {', '.join(sorted(SCENARIO_KEYS))}")
    camera = entry.get("camera", "slice")
    if camera not in CAMERAS:
        raise PerfError(f"{where}: camera {camera!r} is not one of {', '.join(CAMERAS)}")
    steps = entry.get("steps", [])
    # Step kinds and their fields are the CLI's to judge; a test runs every
    # scenario through its script parser.
    if not isinstance(steps, list) or not all(isinstance(s, dict) and isinstance(s.get("kind"), str) for s in steps):
        raise PerfError(f"{where}: steps are a list of objects, each with a kind")
    for key in ("width", "height"):
        if key in entry and not (isinstance(entry[key], int) and entry[key] > 0):
            raise PerfError(f"{where}: {key} is a positive whole number of CSS pixels")
    for key in ("mobile", "fullUi"):
        if not isinstance(entry.get(key, False), bool):
            raise PerfError(f"{where}: {key} is true or false")
    return Scenario(
        name=path.stem,
        description=entry.get("description", ""),
        requires=_check_traits(where, entry.get("requires", [])),
        camera=camera,
        steps=tuple(steps),
        path=path,
        width=entry.get("width"),
        height=entry.get("height"),
        mobile=entry.get("mobile", False),
        full_ui=entry.get("fullUi", False),
    )


def load_scenarios(directory: Path) -> dict[str, Scenario]:
    return {path.stem: load_scenario(path) for path in sorted(directory.glob("*.json"))}


def _names(where: str, wanted: Any, known: dict[str, Any], kind: str) -> tuple[str, ...]:
    if wanted == "all":
        return tuple(known)
    if not isinstance(wanted, list):
        raise PerfError(f"{where}: {kind}s are \"all\" or a list of names")
    unknown_names(kind, wanted, known)
    return tuple(wanted)


def unknown_names(kind: str, wanted: list[str], known: dict[str, Any]) -> None:
    missing = [name for name in wanted if name not in known]
    if missing:
        raise PerfError(f"no {kind} called {', '.join(missing)}; the {kind}s are {', '.join(known)}")


def load_suites(path: Path, catalog: dict[str, Dataset], scenarios: dict[str, Scenario]) -> dict[str, Suite]:
    suites = {}
    for name, entry in _read_json(path).get("suites", {}).items():
        where = f"suite {name}"
        suites[name] = Suite(
            name=name,
            description=entry.get("description", ""),
            datasets=_names(where, entry.get("datasets"), catalog, "dataset"),
            scenarios=_names(where, entry.get("scenarios"), scenarios, "scenario"),
            ratios=tuple(parse_ratio(str(r)) for r in entry.get("ratios", [1, 2])),
            networks=tuple(parse_network(str(n)) for n in entry.get("networks", [])),
        )
    return suites


def parse_ratio(text: str) -> float:
    try:
        ratio = float(text)
    except ValueError:
        raise PerfError(f"a device pixel ratio is a number, not {text!r}") from None
    if not ratio > 0:
        raise PerfError(f"a device pixel ratio is positive, not {text}")
    return ratio


def parse_network(text: str) -> str:
    if text not in NETWORKS:
        raise PerfError(f"no network called {text}; the networks are {', '.join(NETWORKS)}")
    return text


# ---------------------------------------------------------------------------
# The matrix
# ---------------------------------------------------------------------------


# What the runner sets on the server it starts itself.
RUNNER_SERVER_ENV = ("LUCIDA_BIND", "LUCIDA_AUTH", "LUCIDA_WEB_DIST", "LUCIDA_GENERATED_COARSE_CACHE_DIR")


def parse_server_env(texts: list[str]) -> tuple[str, ...]:
    """Server settings as KEY=VALUE, sorted by key so the same settings make
    the same baseline key in any order."""
    settings: dict[str, str] = {}
    for text in texts:
        key, equals, value = text.partition("=")
        if not equals or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise PerfError(f"a server setting is KEY=VALUE, such as LUCIDA_SOURCE_READ_CONCURRENCY=64, not {text!r}")
        if key in RUNNER_SERVER_ENV:
            raise PerfError(f"the runner sets {key} on the server it starts")
        if key.startswith(THROTTLE_SETTINGS):
            raise PerfError(f"{key} is a throttle setting; choose a network with --network")
        if key in settings:
            raise PerfError(f"--server-env names {key} twice")
        settings[key] = value
    return tuple(f"{key}={settings[key]}" for key in sorted(settings))


@dataclass(frozen=True)
class Case:
    dataset: Dataset
    scenario: Scenario
    ratio: float
    repeat: int
    # The network the runner starts its server under; None leaves the
    # server as it is.
    network: str | None = None
    # Settings for the server the runner starts, as KEY=VALUE, sorted by key.
    server_env: tuple[str, ...] = ()

    @property
    def id(self) -> str:
        network = f".{self.network}" if self.network else ""
        suffix = f".{self.repeat}" if self.repeat > 1 else ""
        return f"{self.dataset.name}.{self.scenario.name}.dpr{format_ratio(self.ratio)}{network}{suffix}"


@dataclass
class Selection:
    suite: str | None = None
    datasets: list[str] = field(default_factory=list)
    scenarios: list[str] = field(default_factory=list)
    ratios: list[float] = field(default_factory=list)
    networks: list[str] = field(default_factory=list)
    repeat: int = 1
    # False when the runs drive a server the runner did not start, whose
    # throttle it cannot set.
    own_server: bool = True
    server_env: tuple[str, ...] = ()


def chosen_suite(selection: Selection, suites: dict[str, Suite]) -> Suite | None:
    """The suite that fills the dimensions the flags leave open: the named
    one, or the quick suite when no flag chooses what to run. A network is a
    condition to run it under, like a knob, so it alone leaves the quick suite."""
    explicit = selection.datasets or selection.scenarios or selection.ratios
    suite_name = selection.suite or (None if explicit else DEFAULT_SUITE)
    if suite_name is not None and suite_name not in suites:
        raise PerfError(f"no suite called {suite_name}; the suites are {', '.join(suites)}")
    return suites.get(suite_name) if suite_name else None


def plan(
    selection: Selection,
    catalog: dict[str, Dataset],
    scenarios: dict[str, Scenario],
    suites: dict[str, Suite],
) -> tuple[list[Case], list[tuple[str, str]]]:
    """The runs to make, and the dataset and scenario pairs left out because
    the scenario does not apply.

    A suite supplies each dimension the flags leave open. With no suite and no
    flags it is the quick suite; flags alone leave the rest at every scenario,
    ratios 1 and 2, and the server as the caller's environment sets it. The
    network is the outermost dimension, so one server at a time serves its runs.
    """
    suite = chosen_suite(selection, suites)
    unknown_names("dataset", selection.datasets, catalog)
    unknown_names("scenario", selection.scenarios, scenarios)
    if selection.repeat < 1:
        raise PerfError("--repeat is at least 1")

    dataset_names = selection.datasets or (list(suite.datasets) if suite else list(catalog))
    scenario_names = selection.scenarios or (list(suite.scenarios) if suite else list(scenarios))
    ratios = selection.ratios or (list(suite.ratios) if suite else [1.0, 2.0])
    networks: list[str | None] = list(selection.networks or (suite.networks if suite else ()))
    if not selection.own_server or not networks:
        networks = [None]

    cases: list[Case] = []
    skipped: list[tuple[str, str]] = []
    for dataset_name in dict.fromkeys(dataset_names):
        dataset = catalog[dataset_name]
        for scenario_name in dict.fromkeys(scenario_names):
            scenario = scenarios[scenario_name]
            if missing := [name for name in scenario.adds if name not in catalog]:
                raise PerfError(
                    f"scenario {scenario_name} adds {', '.join(missing)}, which the catalog lacks; "
                    f"the datasets are {', '.join(catalog)}"
                )
            if not scenario.applies_to(dataset):
                skipped.append((dataset_name, scenario_name))
                continue
            for ratio in dict.fromkeys(ratios):
                for repeat in range(1, selection.repeat + 1):
                    cases.append(Case(dataset, scenario, ratio, repeat))
    if not cases:
        raise PerfError("the selection holds no run: " + describe_skipped(skipped, scenarios, catalog))
    return [
        replace(case, network=n, server_env=selection.server_env) for n in dict.fromkeys(networks) for case in cases
    ], skipped


def describe_skipped(
    skipped: list[tuple[str, str]], scenarios: dict[str, Scenario], catalog: dict[str, Dataset]
) -> str:
    by_reason: dict[tuple[str, str], list[str]] = {}
    for dataset_name, scenario_name in skipped:
        reason = scenarios[scenario_name].why_not(catalog[dataset_name]) or ""
        by_reason.setdefault((scenario_name, reason), []).append(dataset_name)
    return "; ".join(
        f"{name} {reason}, so it skips {', '.join(datasets)}"
        if reason.startswith("needs ")
        else f"{name} skips {', '.join(datasets)}: {reason}"
        for (name, reason), datasets in by_reason.items()
    )


def format_ratio(ratio: float) -> str:
    return f"{ratio:g}"


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------


def _tool(name: str, why: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise PerfError(f"{name} is not on PATH; it is needed to {why}")
    return path


def _git_files(paths: list[Path]) -> list[Path]:
    """Every file git would see under `paths`: tracked, plus untracked and not ignored."""
    relative = [str(p.relative_to(REPO)) for p in paths]
    try:
        listed = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *relative],
            cwd=REPO,
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise PerfError(f"could not list the checkout's files with git: {error}") from error
    return sorted({REPO / name for name in listed.decode("utf-8").split("\0") if name})


def _hash_files(files: list[Path], root: Path) -> str:
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        # A tracked file deleted from the working tree is part of the state too.
        digest.update(path.read_bytes() if path.is_file() else b"<absent>")
        digest.update(b"\0")
    return digest.hexdigest()


def _hash_tree(root: Path) -> str | None:
    if not root.is_dir():
        return None
    return _hash_files(sorted(p for p in root.rglob("*") if p.is_file()), root)


def _local_crates(root_crate: str) -> list[Path]:
    """The directories of a crate and every workspace crate it reaches by path."""
    try:
        metadata = json.loads(
            subprocess.run(
                ["cargo", "metadata", "--no-deps", "--format-version", "1"],
                cwd=REPO,
                capture_output=True,
                check=True,
            ).stdout
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise PerfError(f"cargo metadata failed: {error}") from error
    packages = {p["name"]: p for p in metadata["packages"]}
    seen: list[str] = []
    pending = [root_crate]
    while pending:
        name = pending.pop()
        if name in seen or name not in packages:
            continue
        seen.append(name)
        pending.extend(d["name"] for d in packages[name]["dependencies"] if d.get("path"))
    return [Path(packages[name]["manifest_path"]).parent for name in seen]


@dataclass(frozen=True)
class Component:
    """A build output that cargo does not track for us, and what it is built from."""

    name: str
    inputs: list[Path]
    output: Path
    # Folded into the input fingerprint: a component built on another's output.
    upstream: str = ""


def _stamp_path(name: str) -> Path:
    return REPO / "target" / "perf" / "stamps" / f"{name}.json"


def component_fingerprint(component: Component) -> str:
    digest = hashlib.sha256(_hash_files(_git_files(component.inputs), REPO).encode())
    digest.update(component.upstream.encode())
    return digest.hexdigest()


def is_fresh(component: Component, fingerprint: str) -> bool:
    """Built by this script from these inputs, and untouched since.

    The output's own hash is part of the stamp, so a bundle rebuilt by hand
    from another checkout reads as stale even when this checkout's inputs
    match the stamp.
    """
    stamp = _stamp_path(component.name)
    if not stamp.exists():
        return False
    recorded = json.loads(stamp.read_text(encoding="utf-8"))
    return recorded.get("inputs") == fingerprint and recorded.get("output") == _hash_tree(component.output)


def _record(component: Component, fingerprint: str) -> None:
    stamp = _stamp_path(component.name)
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps({"inputs": fingerprint, "output": _hash_tree(component.output)}), encoding="utf-8")


def _run_build(argv: list[str], cwd: Path, what: str, env: dict[str, str] | None = None) -> None:
    print(f"  {what}: {' '.join(Path(argv[0]).name if i == 0 else a for i, a in enumerate(argv))}", flush=True)
    completed = subprocess.run(argv, cwd=cwd, env=env)
    if completed.returncode != 0:
        raise PerfError(f"building {what} failed (exit {completed.returncode}); nothing was measured")


@dataclass(frozen=True)
class Build:
    cli: Path
    # None when the runs drive a server this script did not start.
    server: Path | None = None
    web_dist: Path | None = None


def build(cli: Path | None = None, server: bool = True) -> Build:
    """Bring what this script runs up to the checkout: the CLI unless one is
    given, and the server, wasm and web bundle unless the runs drive a server
    that is already running.

    Cargo judges the binaries itself. The wasm package and the web bundle
    are rebuilt when the files git sees under their inputs, or the outputs
    themselves, differ from what this script last built.
    """
    release = REPO / "target" / "release"
    packages = (["lucida-server"] if server else []) + ([] if cli else ["lucida-cli"])
    if not packages:
        assert cli is not None
        return Build(cli)
    print("build", flush=True)
    cargo = _tool("cargo", "build the server and the CLI")
    env = dict(os.environ)
    # aws-lc-sys assembles with NASM on Windows unless it may use the
    # objects it ships; a machine without NASM fails the build otherwise.
    if os.name == "nt" and "AWS_LC_SYS_PREBUILT_NASM" not in env and shutil.which("nasm") is None:
        env["AWS_LC_SYS_PREBUILT_NASM"] = "1"
    _run_build(
        [cargo, "build", "--release", "--locked", *(arg for p in packages for arg in ("-p", p))],
        REPO,
        "server and CLI" if len(packages) == 2 else packages[0],
        env,
    )
    cli = cli or release / f"lucida{EXE}"
    if not server:
        return Build(cli)

    web_dir = REPO / "lucida-web"
    root_files = [REPO / "Cargo.toml", REPO / "Cargo.lock"]
    wasm = Component("wasm", [*_local_crates("lucida-core"), *root_files], REPO / "lucida-core" / "pkg")
    wasm_fingerprint = component_fingerprint(wasm)
    if is_fresh(wasm, wasm_fingerprint):
        print("  wasm: fresh", flush=True)
    else:
        pnpm = _tool("pnpm", "build the wasm package and the web bundle")
        _tool("wasm-pack", "build the wasm package")
        _run_build([pnpm, "run", "build:wasm"], web_dir, "wasm")
        _record(wasm, wasm_fingerprint)

    web = Component("web", [web_dir], web_dir / "dist", upstream=wasm_fingerprint)
    web_fingerprint = component_fingerprint(web)
    if is_fresh(web, web_fingerprint):
        print("  web bundle: fresh", flush=True)
    else:
        pnpm = _tool("pnpm", "build the web bundle")
        # The install links the wasm package, so it comes after build:wasm.
        _run_build([pnpm, "install", "--frozen-lockfile"], web_dir, "web dependencies")
        _run_build([pnpm, "run", "build"], web_dir, "web bundle")
        _record(web, web_fingerprint)

    return Build(cli, release / f"lucida-server{EXE}", web_dir / "dist")


# ---------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------


def dataset_location(dataset: Dataset, data_dir: Path) -> str:
    """The URL a run opens: a local entry's own, or the generated copy's path."""
    if dataset.url is not None:
        return dataset.url
    assert dataset.generate is not None
    # The generator's own bytes are in the key: the same options from a
    # changed generator are a different dataset.
    key = hashlib.sha256(" ".join(dataset.generate).encode() + b"\0" + GENERATOR.read_bytes()).hexdigest()[:12]
    return (data_dir / f"{dataset.name}-{key}.ome.zarr").as_posix()


def prune_earlier(name: str, data_dir: Path) -> None:
    """Remove a dataset's copies under other keys, and any partial one: dead
    weight once a new copy is on its way."""
    earlier = re.compile(re.escape(name) + r"-[0-9a-f]{12}\.ome\.zarr(\.partial)?")
    for path in data_dir.iterdir():
        if earlier.fullmatch(path.name):
            shutil.rmtree(path, ignore_errors=True)


def ensure_datasets(datasets: list[Dataset], data_dir: Path) -> dict[str, str]:
    locations: dict[str, str] = {}
    pending = [d for d in datasets if d.generate is not None and not Path(dataset_location(d, data_dir)).exists()]
    if pending:
        print("datasets", flush=True)
        uv = _tool("uv", "generate the datasets")
    for dataset in datasets:
        location = dataset_location(dataset, data_dir)
        locations[dataset.name] = location
        if dataset not in pending:
            continue
        final = Path(location)
        final.parent.mkdir(parents=True, exist_ok=True)
        prune_earlier(dataset.name, final.parent)
        # Generated aside and moved into place, so an interrupted generation
        # never leaves a half dataset under the name the cache trusts.
        partial = final.with_name(final.name + ".partial")
        print(f"  {dataset.name}: {' '.join(dataset.generate)}", flush=True)
        argv = [uv, "run", "--quiet", str(GENERATOR), str(partial), "--overwrite", *dataset.generate]
        if subprocess.run(argv, cwd=REPO).returncode != 0:
            raise PerfError(f"generating {dataset.name} failed; nothing was measured")
        os.replace(partial, final)
    return locations


# ---------------------------------------------------------------------------
# Processes
# ---------------------------------------------------------------------------


class _WindowsJob:
    """A job object that kills every process in it when it is closed.

    A child joins its parent's job, so the browser a CLI launches is in the
    CLI's job. Closing the handle, which also happens when this process dies
    for any reason, takes the whole tree down.
    """

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in ("Read", "Write", "Other", "ReadBytes", "WriteBytes", "OtherBytes")
            ]

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimits),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
        kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        self._kernel32 = kernel32
        self._ctypes = ctypes

        self.handle = kernel32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObject failed")
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

    def add(self, pid: int) -> None:
        process = self._kernel32.OpenProcess(0x0101, False, pid)  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
        if not process:
            raise OSError(self._ctypes.get_last_error(), "OpenProcess failed")
        try:
            if not self._kernel32.AssignProcessToJobObject(self.handle, process):
                raise OSError(self._ctypes.get_last_error(), "AssignProcessToJobObject failed")
        finally:
            self._kernel32.CloseHandle(process)

    def kill(self) -> None:
        if self.handle:
            self._kernel32.TerminateJobObject(self.handle, 1)
            self._kernel32.CloseHandle(self.handle)
            self.handle = None


LIVE: list[ProcessTree] = []


class ProcessTree:
    """One process this script started and everything it starts in turn.

    The children are kept out of the terminal's Ctrl-C, in a process group
    of their own or a job object, so this script decides when they stop and
    stops the browser with them.
    """

    def __init__(self, argv: list[str], log: Path, cwd: Path, env: dict[str, str]) -> None:
        self.log = log
        self.job: _WindowsJob | None = None
        options: dict[str, Any] = {}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            try:
                self.job = _WindowsJob()
            except OSError as error:
                print(f"warning: no job object ({error}); a browser a run starts may outlive it")
        else:
            options["start_new_session"] = True
        with open(log, "wb") as out:
            self.process = subprocess.Popen(
                argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, **options
            )
        LIVE.append(self)
        if self.job is not None:
            try:
                self.job.add(self.process.pid)
            except OSError as error:
                print(f"warning: {Path(argv[0]).name} is in no job object ({error}); a browser it starts may outlive it")

    def wait(self, timeout: float | None = None) -> int | None:
        """The exit code, or None at the timeout. Polled, because a blocking
        wait on Windows does not let Ctrl-C through."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            code = self.process.poll()
            if code is not None:
                return code
            if deadline is not None and time.monotonic() >= deadline:
                return None
            time.sleep(0.1)

    def stop(self, grace: float = 5.0) -> None:
        """Stop the process and whatever it left running. Safe to repeat."""
        if os.name == "nt":
            if self.process.poll() is None:
                self.process.terminate()
            if self.job is not None:
                self.job.kill()
                self.job = None
        else:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.wait(grace)
                # Whether or not the leader went, a browser left in its group
                # goes now.
                os.killpg(self.process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            self.process.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self in LIVE:
            LIVE.remove(self)


def stop_everything() -> None:
    for tree in list(reversed(LIVE)):
        tree.stop()


def _scrubbed_env(**overrides: str) -> dict[str, str]:
    """The caller's environment without its lucida settings, so a run never
    reaches the caller's own server, config, token or database. The browser
    choice is kept, since it says which Chrome this machine has, and so are
    the source and link throttles, conditions every run file records."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("LUCIDA_") or k == "LUCIDA_BROWSER" or k.startswith(THROTTLE_SETTINGS)
    }
    env.update(overrides)
    return env


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _answers(url: str, timeout: float) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/healthz", timeout=timeout):
            return True
    except (urllib.error.URLError, OSError):
        return False


def existing_server(url: str) -> str:
    """A server someone else started. It opens datasets by the path a run
    names, so it has to see the data directory at the same absolute path."""
    url = url.rstrip("/")
    if not _answers(url, 5):
        raise PerfError(f"no server answers {url}/healthz; start one, or leave out --server to have one started")
    return url


def throttled(network: str | None) -> bool:
    """Whether the server the runner starts for `network` reads its sources
    through a throttle: a source profile other than local, or with no network
    named, a throttle the caller's environment sets. The link throttle has no
    part in it, since a warm server still sends every chunk over the link."""
    if network is not None:
        return NETWORKS[network][0] != "local"
    settings = [v for k, v in os.environ.items() if k.startswith("LUCIDA_SOURCE_THROTTLE")]
    return any(v not in ("", "0", "local") for v in settings)


def start_server(
    built: Build,
    out_dir: Path,
    port: int,
    network: str | None = None,
    log_name: str = "server.log",
    server_env: tuple[str, ...] = (),
) -> tuple[ProcessTree, str]:
    """Start the server, under the throttles of `network` when one is named
    and with the settings in `server_env`. Each network's server has a
    directory and database of its own."""
    assert built.server is not None and built.web_dist is not None
    # The server keeps its database in its working directory.
    server_dir = out_dir / (f"server-{network}" if network else "server")
    server_dir.mkdir(parents=True, exist_ok=True)
    # A generated coarse tier cached by an earlier server would make a
    # single-level dataset's first open look warm.
    shutil.rmtree(server_dir / "generated-coarse", ignore_errors=True)
    env = _scrubbed_env(
        LUCIDA_BIND=f"127.0.0.1:{port}",
        LUCIDA_AUTH="disabled",
        LUCIDA_WEB_DIST=str(built.web_dist),
        LUCIDA_GENERATED_COARSE_CACHE_DIR=str(server_dir / "generated-coarse"),
    )
    if network:
        # The profiles alone: a caller's latency or bandwidth would quietly
        # turn one into another throttle.
        env = {k: v for k, v in env.items() if not k.startswith(THROTTLE_SETTINGS)}
        env["LUCIDA_SOURCE_THROTTLE"], env["LUCIDA_LINK_THROTTLE"] = NETWORKS[network]
    env.update(setting.split("=", 1) for setting in server_env)
    tree = ProcessTree([str(built.server)], server_dir / log_name, server_dir, env)
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if tree.wait(0.25) is not None:
            raise PerfError(f"the server exited at startup; see {tree.log}")
        if _answers(url, 1):
            return tree, url
    raise PerfError(f"the server did not answer {url}/healthz within 30 s; see {tree.log}")


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@dataclass
class Row:
    case: Case
    run_file: Path
    log: Path
    exit_code: int | None = None
    error: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)


def parse_knob(text: str) -> str:
    """A Dev controls knob as NAME=VALUE, NAME being its `lucida trace` flag without the dashes."""
    if not re.fullmatch(r"[a-z][a-z0-9-]*=[^\s=]+", text):
        raise PerfError(f"a knob is NAME=VALUE, such as max-fetches=4, not {text!r}; `lucida trace --help` lists them")
    return text


def knob_args(knobs: tuple[str, ...]) -> list[str]:
    # The CLI judges the name and the value; a knob it does not know fails the run with its own message.
    return [arg for knob in knobs for arg in (f"--{knob.split('=', 1)[0]}", knob.split("=", 1)[1])]


def _first_error_line(log: Path) -> str:
    lines = [line.strip() for line in log.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    for line in lines:
        if line.lower().startswith("error"):
            return line[len("error") :].lstrip(":").strip()
    return lines[-1] if lines else "no output"


def script_file(scenario: Scenario, locations: dict[str, str], runs_dir: Path) -> Path:
    """The file `lucida trace --script` reads: the scenario's own, or, when its
    steps name catalog datasets, a copy with each one's location put in."""
    if not scenario.adds:
        return scenario.path
    steps = [
        {**step, "url": locations[step["url"][len(DATASET_REF) :]]}
        if step.get("kind") in ("add", "remove") and str(step.get("url", "")).startswith(DATASET_REF)
        else step
        for step in scenario.steps
    ]
    path = runs_dir / f"{scenario.name}.script.json"
    path.write_text(json.dumps({"steps": steps}, indent=2), encoding="utf-8")
    return path


def viewport_args(scenario: Scenario) -> list[str]:
    """The `lucida trace` flags for the window and the page a scenario asks
    for; none leaves the CLI's default desktop window on the capture surface."""
    argv = []
    if scenario.width is not None:
        argv += ["--width", str(scenario.width)]
    if scenario.height is not None:
        argv += ["--height", str(scenario.height)]
    if scenario.mobile:
        argv.append("--mobile")
    if scenario.full_ui:
        argv.append("--full-ui")
    return argv


def run_case(
    case: Case,
    built: Build,
    server_url: str,
    locations: dict[str, str],
    out_dir: Path,
    timeout: int,
    stamp: str,
    gate: bool = False,
    bundle: bool = False,
    knobs: tuple[str, ...] = (),
) -> Row:
    runs_dir = out_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    row = Row(case, runs_dir / f"{case.id}.json", runs_dir / f"{case.id}.txt")
    bundle_file = runs_dir / f"{case.id}.bundle.json"
    # An output directory used before may hold this case's files from then.
    row.run_file.unlink(missing_ok=True)
    bundle_file.unlink(missing_ok=True)
    # The browser's throwaway profile lands here rather than the system
    # temp directory, so one killed mid-run is cleaned up with the rest.
    tmp = out_dir / "tmp"
    tmp.mkdir(exist_ok=True)
    env = _scrubbed_env(
        LUCIDA_CONFIG_PATH=str(out_dir / "config.json"),
        LUCIDA_TRACE_DIR=str(runs_dir),
        TMP=str(tmp),
        TEMP=str(tmp),
        TMPDIR=str(tmp),
    )
    cli = [str(built.cli), "--server", server_url]
    # The page loads the whole workspace, so each run gets one of its own.
    workspace = f"perf-{case.id}-{stamp}"
    create = ProcessTree([*cli, "workspace", "create", workspace], runs_dir / f"{case.id}.workspace.txt", REPO, env)
    code = create.wait()
    create.stop()
    if code != 0:
        row.exit_code, row.log = code, create.log
        row.error = _first_error_line(create.log)
        return row

    scenario = case.scenario
    argv = [
        *cli,
        "--workspace",
        workspace,
        "trace",
        locations[case.dataset.name],
        "--camera",
        scenario.camera,
        "--device-pixel-ratio",
        format_ratio(case.ratio),
        "--timeout-seconds",
        str(timeout),
        "--output",
        str(row.run_file),
    ]
    argv += viewport_args(scenario)
    if gate:
        argv.append("--gate")
    if bundle:
        argv += ["--bundle", str(bundle_file)]
    argv += knob_args(knobs)
    if scenario.steps:
        # A scenario file is a script file: the CLI reads its steps and
        # ignores the keys around them.
        argv += ["--script", str(script_file(scenario, locations, runs_dir))]
    trace = ProcessTree(argv, row.log, REPO, env)
    try:
        # The CLI has its own deadline per wait; this one only catches a hang.
        row.exit_code = trace.wait(timeout * (len(scenario.steps) + 2) + 60)
    finally:
        trace.stop()
    if row.exit_code != 0 or not row.run_file.exists():
        row.error = "timed out" if row.exit_code is None else _first_error_line(row.log)
        return row
    row.fields = read_run(row.run_file)
    return row


def _metric(signals: list[dict[str, Any]] | None, name: str) -> Any:
    for signal_entry in signals or []:
        if signal_entry.get("metric") == name:
            return signal_entry.get("value")
    return None


def _lag(lag: Any) -> dict[str, Any]:
    """Input to frame at p95, the longest main-thread task and the frames
    dropped, from a lag reading; each None when the run took no input."""
    lag = lag or {}
    return {
        "inputToFrameP95Ms": (lag.get("inputToFrame") or {}).get("p95Ms"),
        "longestTaskMs": (lag.get("longTasks") or {}).get("longestMs"),
        "droppedFrames": (lag.get("frames") or {}).get("dropped"),
    }


def _load(load: Any) -> dict[str, Any]:
    """First frame, settle, prefetch, what the wire delivered and the wanted
    chunks not resident, from a load reading; each None where it says nothing."""
    load = load or {}
    received = load.get("received") or {}
    return {
        "firstFrameMs": load.get("firstFrameMs"),
        "settleMs": load.get("settleMs"),
        "prefetchMs": load.get("prefetchMs"),
        "bytesFetched": received.get("bytes"),
        # A run file from before the wire carried encoded chunks has no
        # `wireBytes`: its wire carried what it fetched.
        "bytesWire": received.get("wireBytes", received.get("bytes")),
        "chunksFetched": received.get("requests"),
        "chunksShort": load.get("coverageLossChunks"),
    }


def _attribution(attribution: Any) -> dict[str, Any]:
    attribution = attribution or {}
    return {"topLimiter": attribution.get("cause"), "confidence": attribution.get("confidence")}


def _errors(errors: list[dict[str, Any]], step: int | None = None) -> int:
    """The errors the page raised that its allow list does not name, repeats
    included: in script step `step`, counted from 1, or anywhere in the trace."""
    return sum(
        error.get("count") or 1
        for error in errors
        if not error.get("allowed") and (step is None or error.get("step") == step)
    )


def _step_label(step: dict[str, Any]) -> str:
    kind = step.get("kind") or "?"
    return f"{kind} {step['to']}" if kind == "mode" and step.get("to") else kind


def read_run(path: Path) -> dict[str, Any]:
    """The table's fields, as the run file's diagnostic and its step records state them."""
    run_file = _read_json(path)
    diagnostic = run_file.get("diagnostic") or {}
    header = run_file.get("header") or {}
    run = diagnostic.get("run") or {}
    verdict = diagnostic.get("verdict") or {}
    steps = (header.get("script") or {}).get("steps") or []
    errors = header.get("errors") or []
    return {
        "runId": diagnostic.get("runId"),
        "verdict": verdict.get("kind"),
        "verdictText": verdict.get("text"),
        **_load(diagnostic.get("load")),
        "chunksEvicted": _metric((diagnostic.get("coverage") or {}).get("notHealthSignals"), "evictions"),
        **_attribution(diagnostic.get("attribution")),
        "adapter": run.get("gpu"),
        "adapterKind": (run.get("adapterKind") or {}).get("label"),
        "sourceThrottle": header.get("sourceThrottle"),
        "linkThrottle": header.get("linkThrottle"),
        **_lag(diagnostic.get("lag")),
        "errors": _errors(errors),
        "steps": [
            {
                "kind": step.get("kind"),
                "label": _step_label(step),
                "runId": step.get("runId"),
                "verdict": (step.get("verdict") or {}).get("kind"),
                "durationMs": step["durationUs"] / 1000 if isinstance(step.get("durationUs"), (int, float)) else None,
                **_load(step.get("load")),
                **_attribution(step.get("attribution")),
                **_lag(step.get("lag")),
                "errors": _errors(errors, index),
            }
            for index, step in enumerate(steps, start=1)
        ],
    }


# ---------------------------------------------------------------------------
# The table
# ---------------------------------------------------------------------------

DASH = "-"
COLUMNS = [
    "dataset",
    "scenario",
    "dpr",
    "throttle",
    "first frame",
    "settle",
    "prefetch",
    "duration",
    "fetched",
    "wire",
    "chunks",
    "evicted",
    "short",
    "top limiter",
    "input to frame p95",
    "longest task",
    "dropped",
    "errors",
    "verdict",
    "run",
]


def _ms(value: Any) -> str:
    return DASH if value is None else f"{value:,.0f} ms"


def _bytes(value: Any) -> str:
    if value is None:
        return DASH
    for unit, size in (("GB", 1e9), ("MB", 1e6), ("kB", 1e3)):
        if value >= size:
            return f"{value / size:.1f} {unit}"
    return f"{value:.0f} B"


def _count(value: Any) -> str:
    return DASH if value is None else f"{value:,.0f}"


def _limiter(fields: dict[str, Any]) -> str:
    cause = fields.get("topLimiter")
    if not cause:
        return DASH
    text = " / ".join(cause) if isinstance(cause, list) else str(cause)
    return f"{text} ({fields['confidence']})" if fields.get("confidence") else text


def step_outcome(step: dict[str, Any]) -> str:
    """A step's verdict, or why it has none. A step without one is never
    clear: its run may have been the one that stalled."""
    if step.get("verdict"):
        return step["verdict"]
    # The recorder drops its oldest runs to stay under its memory cap, so a
    # long script can lose an early step's run before the export reads it.
    return "no verdict: run not exported" if step.get("runId") else "no verdict: no run opened"


# Numbers the table shows and the comparison does not judge, by column: no
# allowance has been measured for their noise.
READINGS = {
    "prefetch": ("prefetchMs", _ms),
    "wire": ("bytesWire", _bytes),
    "input to frame p95": ("inputToFrameP95Ms", _ms),
    "longest task": ("longestTaskMs", _ms),
    "dropped": ("droppedFrames", _count),
    "errors": ("errors", _count),
}


@dataclass(frozen=True)
class Metric:
    """A numeric column the comparison judges. Larger is worse for every one."""

    field: str
    label: str
    format: Callable[[Any], str]
    # A change is noise unless it exceeds both this share of the baseline
    # and the floor, in the metric's own unit, that keeps small values from
    # being judged by share alone.
    relative: float
    floor: float

    def allowance(self, baseline: float) -> float:
        return max(self.relative * baseline, self.floor)


# The allowances come from noise measured on an RTX A6000 shared with other
# agents' browsers: seven runs of every quick-suite cell on one build, five as
# repeats and two as separate invocations. Settle ranged by up to 228 ms on
# cells under 600 ms, widest on a volume's cold open as the neighbours' load
# came and went, and by up to 10% on cells near 2 s. First frame ranged by up
# to 106 ms. Bytes and chunks fetched ranged by up to 4%, or two chunks, and
# evictions not at all. The settle floor sits just above that noise because
# `--max-fetches 1` slows the same cells by only 234 to 368 ms.
METRICS = (
    Metric("firstFrameMs", "first frame", _ms, relative=0.2, floor=150),
    Metric("settleMs", "settle", _ms, relative=0.2, floor=250),
    Metric("bytesFetched", "fetched", _bytes, relative=0.1, floor=1e6),
    Metric("chunksFetched", "chunks", _count, relative=0.1, floor=8),
    Metric("chunksEvicted", "evicted", _count, relative=0.1, floor=8),
    Metric("chunksShort", "short", _count, relative=0.1, floor=8),
)


@dataclass(frozen=True)
class Stats:
    """One metric across a cell's repeats."""

    n: int
    median: float
    low: float
    high: float

    @classmethod
    def of(cls, values: list[float]) -> Stats | None:
        if not values:
            return None
        return cls(len(values), statistics.median(values), min(values), max(values))


UNRECORDED = "unrecorded"


def throttle_of(fields: dict[str, Any], record: str = "sourceThrottle") -> Any:
    """A throttle a run's server reported, the source throttle or with
    `linkThrottle` the link throttle: its settings, None when it had none, or
    UNRECORDED when the run file does not say."""
    value = fields.get(record)
    return value.get("settings") if isinstance(value, dict) else UNRECORDED


def _numbers(records: list[dict[str, Any]], name: str) -> Stats | None:
    return Stats.of([r[name] for r in records if isinstance(r.get(name), (int, float))])


@dataclass
class Cell:
    """The runs of one dataset, scenario, ratio and network: a row of the
    table, and what a baseline keeps and compares, under `key`, for its
    adapter and ratio."""

    dataset: str
    scenario: str
    ratio: float
    network: str | None
    rows: list[Row]

    @property
    def key(self) -> str:
        # A throttled cell, or one whose server ran with other settings, is a
        # cell of its own, so a baseline never compares it with the same cell
        # measured without that throttle or under the server's defaults.
        mark = self.throttle_mark()
        settings = self.server_env()
        return (
            f"{self.dataset}.{self.scenario}"
            + (f"@{mark}" if mark else "")
            + (f"[{','.join(settings)}]" if settings else "")
        )

    def server_env(self) -> tuple[str, ...]:
        return self.rows[0].case.server_env if self.rows else ()

    def throttle(self, record: str = "sourceThrottle") -> Any:
        """The throttle every measured run reported, or UNRECORDED when one
        did not say or they disagree."""
        reported = [throttle_of(f, record) for f in self.measured()]
        return reported[0] if reported and all(t == reported[0] for t in reported) else UNRECORDED

    def throttle_mark(self) -> str:
        """The throttles' names, empty when neither slowed the runs: the
        source profile the runs reported, then the link profile after
        `link-`, custom for values of no profile, or the network's profiles
        when no run got far enough to report them."""
        if self.measured():
            source, link = self._profile(self.throttle()), self._profile(self.throttle("linkThrottle"))
        else:
            source, link = ("" if p == "local" else p for p in NETWORKS[self.network or "local"])
        return "+".join(filter(None, [source, link and f"link-{link}"]))

    @staticmethod
    def _profile(settings: Any) -> str:
        if settings is None:
            return ""
        return UNRECORDED if settings == UNRECORDED else settings.get("profile") or "custom"

    def measured(self) -> list[dict[str, Any]]:
        return [row.fields for row in self.rows if row.error is None]

    def stats(self, name: str) -> Stats | None:
        return _numbers(self.measured(), name)

    def steps(self) -> list[list[dict[str, Any]]]:
        """Each script step across the measured repeats, in step order."""
        records = [f.get("steps") or [] for f in self.measured()]
        return [[steps[i] for steps in records if i < len(steps)] for i in range(max(map(len, records), default=0))]

    def outcomes(self) -> list[str]:
        return ["error" if row.error is not None else row.fields.get("verdict") or "no verdict" for row in self.rows]

    def adapter(self) -> str | None:
        return next((a for a in (adapter_of(f) for f in self.measured()) if a), None)

    def record(self) -> dict[str, Any]:
        """The cell as a baseline stores it and the comparison reads it."""
        metrics = {m.field: asdict(s) for m in METRICS if (s := self.stats(m.field)) is not None}
        return {"runs": len(self.rows), "metrics": metrics, "outcomes": dict(Counter(self.outcomes()))}


def adapter_of(fields: dict[str, Any]) -> str | None:
    return f"{fields['adapter']} ({fields['adapterKind']})" if fields.get("adapter") else None


def group_cells(rows: list[Row]) -> list[Cell]:
    """The rows gathered by dataset, scenario, ratio and network, in the order each first ran."""
    cells: dict[tuple[str, str, float, str | None], Cell] = {}
    for row in rows:
        case = row.case
        key = (case.dataset.name, case.scenario.name, case.ratio, case.network)
        cells.setdefault(key, Cell(*key, [])).rows.append(row)
    return list(cells.values())


def _distinct(values: list[str]) -> str:
    """One value when the repeats agree, else each with its count."""
    counts = Counter(values)
    if len(counts) == 1:
        return values[0]
    return ", ".join(f"{value} ×{n}" for value, n in counts.items())


def _stat(stats: Stats | None, fmt: Callable[[Any], str]) -> str:
    """The median, and half the range across repeats when they differ."""
    if stats is None:
        return DASH
    if stats.high == stats.low:
        return fmt(stats.median)
    return f"{fmt(stats.median)} ±{fmt((stats.high - stats.low) / 2)}"


def table_cells(cell: Cell, out_dir: Path) -> list[str]:
    """The cell's row: the run its file is about, which for a scripted
    scenario is the run its last step opened."""
    runs = len(cell.rows)
    first = cell.rows[0]
    run = (first.run_file if first.run_file.exists() else first.log).relative_to(out_dir).as_posix()
    measured = cell.measured()
    verdicts = [f"error: {row.error}" if row.error else row.fields.get("verdict") or DASH for row in cell.rows]
    texts = {
        "dataset": cell.dataset,
        "scenario": cell.scenario + (f" ×{runs}" if runs > 1 else ""),
        "dpr": format_ratio(cell.ratio),
        "throttle": cell.throttle_mark() or DASH,
        "duration": DASH,
        **{m.label: _stat(cell.stats(m.field), m.format) for m in METRICS},
        "top limiter": _distinct([_limiter(f) for f in measured]) if measured else DASH,
        **{label: _stat(cell.stats(name), fmt) for label, (name, fmt) in READINGS.items()},
        "verdict": _distinct(verdicts),
        "run": run + (f" +{runs - 1}" if runs > 1 else ""),
    }
    return [texts[column] for column in COLUMNS]


def step_cells(cell: Cell) -> list[list[str]]:
    """A row under the cell's for each script step, from the step's record:
    how long its run lasted, how it loaded, what it waited on, its lag, its
    errors and its verdict. The columns a step record does not carry stay
    empty."""
    rows = []
    for index, steps in enumerate(cell.steps(), start=1):
        texts = {
            "scenario": f"↳ {index} {steps[0].get('label') or steps[0].get('kind')}",
            "duration": _stat(_numbers(steps, "durationMs"), _ms),
            **{m.label: _stat(_numbers(steps, m.field), m.format) for m in METRICS if m.field in steps[0]},
            "top limiter": _distinct([_limiter(step) for step in steps]),
            **{label: _stat(_numbers(steps, name), fmt) for label, (name, fmt) in READINGS.items()},
            "verdict": _distinct([step_outcome(step) for step in steps]),
        }
        rows.append([texts.get(column, "") for column in COLUMNS])
    return rows


def unjudged_steps(cells: list[Cell]) -> list[str]:
    """Each script step some run of a cell left without a verdict."""
    found = []
    for cell in cells:
        for index, steps in enumerate(cell.steps(), start=1):
            missing = [outcome for step in steps if (outcome := step_outcome(step)).startswith("no verdict")]
            if missing:
                label = steps[0].get("label") or steps[0].get("kind")
                found.append(f"{cell.key} dpr {format_ratio(cell.ratio)} step {index} {label}: {_distinct(missing)}")
    return found


# ---------------------------------------------------------------------------
# Baselines
# ---------------------------------------------------------------------------

BASELINE_COLUMN = "vs baseline"


def default_baseline_dir() -> Path:
    """The clone's git directory, which every worktree of the clone shares and
    which neither `cargo clean` nor `git clean` empties, as they do `target/`."""
    common = _git("rev-parse", "--path-format=absolute", "--git-common-dir")
    return (Path(common) if common else REPO / "target") / "perf-baselines"


def baseline_path(root: Path, adapter: str, ratio: float) -> Path:
    slug = re.sub(r"[^a-z0-9]+", "-", adapter.lower()).strip("-")
    return root / slug / f"dpr{format_ratio(ratio)}.json"


def load_baseline(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    baseline = _read_json(path)
    if not isinstance(baseline, dict) or not isinstance(baseline.get("cells"), dict):
        raise PerfError(f"{path} is not a baseline: it has no cells")
    return baseline


@dataclass(frozen=True)
class Change:
    """One measure of a cell that moved by more than noise."""

    label: str
    before: str
    after: str
    share: float | None
    worse: bool

    def __str__(self) -> str:
        share = "" if self.share is None else f" ({self.share:+.0%})"
        return f"{self.label} {self.before} -> {self.after}{share}"


# Only these outcomes regress a verdict. A stall verdict means a finding
# crossed its threshold, and on one unchanged build that came and went on one
# run in three to five of a cell, so it shows in the verdict column unflagged.
UNSETTLED = frozenset({"unsettled", "error", "no verdict"})


def compare_records(baseline: dict[str, Any], current: dict[str, Any]) -> list[Change]:
    """What moved by more than noise between two records of one cell.

    Records are compared by what they hold, so a record that gains a
    measure is compared on it once both sides have it.
    """
    changes: list[Change] = []
    for metric in METRICS:
        stored = [record.get("metrics", {}).get(metric.field) for record in (baseline, current)]
        if None in stored:
            continue
        before, after = (Stats(**s) for s in stored)
        delta = after.median - before.median
        if abs(delta) <= metric.allowance(before.median):
            continue
        share = delta / before.median if before.median else None
        before_text, after_text = metric.format(before.median), metric.format(after.median)
        changes.append(Change(metric.label, before_text, after_text, share, delta > 0))
    before_outcomes, after_outcomes = baseline.get("outcomes") or {}, current.get("outcomes") or {}
    settled_before, settled_after = not set(before_outcomes) & UNSETTLED, not set(after_outcomes) & UNSETTLED
    if before_outcomes and after_outcomes and settled_before != settled_after:
        changes.append(
            Change("verdict", _outcome_text(before_outcomes), _outcome_text(after_outcomes), None, settled_before)
        )
    return changes


def _outcome_text(outcomes: dict[str, int]) -> str:
    return _distinct([outcome for outcome, n in outcomes.items() for _ in range(n)])


@dataclass
class Comparison:
    """What the baselines say about an invocation's cells."""

    root: Path
    # By cell key and ratio; a cell missing here had no baseline to compare with.
    changes: dict[tuple[str, float], list[Change]] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    compared: bool = False
    refused: bool = False

    def found(self, cell: Cell) -> list[Change] | None:
        return self.changes.get((cell.key, cell.ratio))

    def regressed(self, cell: Cell) -> bool:
        return any(change.worse for change in self.found(cell) or [])

    def describe(self, cell: Cell) -> str:
        changes = self.found(cell)
        if changes is None:
            return "no baseline"
        worse = ", ".join(str(c) for c in changes if c.worse)
        # Not "better": a view that loads less under a smaller budget also
        # settles sooner and fetches less.
        changed = ", ".join(str(c) for c in changes if not c.worse)
        parts = ([f"worse: {worse}"] if worse else []) + ([f"changed: {changed}"] if changed else [])
        return "; ".join(parts) or "within noise"


def _provenance(entries: list[dict[str, Any]]) -> str:
    commits = dict.fromkeys(
        f"{(e.get('commit') or 'unknown')[:9]}{' (dirty)' if e.get('dirty') else ''}, {e.get('savedAt') or 'undated'}"
        for e in entries
    )
    return "; ".join(commits)


def _knobs_text(knobs: Any) -> str:
    return " ".join(f"--{k.replace('=', ' ', 1)}" for k in knobs) if knobs else "none"


def compare(cells: list[Cell], root: Path, knobs: tuple[str, ...]) -> Comparison:
    """Each cell against the baseline its adapter and ratio have under `root`.

    Speed on one adapter says nothing about speed on another, so a baseline
    is found by adapter and a file recorded on another adapter is refused.
    Nor does speed under one source or link throttle say anything about
    speed under another, so a cell whose throttles differ from its
    baseline's is not compared; an entry saved before runs recorded a
    throttle ran without it.
    """
    comparison = Comparison(root)
    adapters = {a for cell in cells if (a := cell.adapter())}
    if len(adapters) != 1:
        comparison.notes.append(
            f"not compared: the runs recorded more than one adapter, {', '.join(sorted(adapters))}"
            if adapters
            else "not compared: no run recorded an adapter"
        )
        return comparison
    adapter = adapters.pop()
    for ratio in dict.fromkeys(cell.ratio for cell in cells):
        dpr = format_ratio(ratio)
        path = baseline_path(root, adapter, ratio)
        try:
            baseline = load_baseline(path)
        except PerfError as error:
            comparison.refused = True
            comparison.notes.append(f"dpr {dpr}: not compared: {error}")
            continue
        if baseline is None:
            # Nothing to say where no baseline was ever saved, as in CI.
            others = sorted(p.parent.name for p in root.glob(f"*/dpr{dpr}.json"))
            if others:
                has = f"{root} has one for {', '.join(others)}"
                comparison.notes.append(f"dpr {dpr}: no baseline for this adapter; {has}")
            continue
        if baseline.get("adapter") != adapter:
            comparison.refused = True
            comparison.notes.append(
                f"dpr {dpr}: not compared: {path} was recorded on {baseline.get('adapter') or 'an unnamed adapter'}, "
                f"these runs on {adapter}"
            )
            continue
        comparison.compared = True
        entries = []
        throttled_otherwise = []
        for cell in cells:
            entry = baseline["cells"].get(cell.key) if cell.ratio == ratio else None
            if entry is None:
                continue
            if cell.measured() and (
                cell.throttle() != entry.get("sourceThrottle")
                or cell.throttle("linkThrottle") != entry.get("linkThrottle")
            ):
                throttled_otherwise.append(cell.key)
                continue
            entries.append(entry)
            comparison.changes[(cell.key, ratio)] = compare_records(entry, cell.record())
        comparison.notes.append(f"dpr {dpr}: baseline {path}, from {_provenance(entries) or 'no matching cell'}")
        if throttled_otherwise:
            comparison.notes.append(
                f"dpr {dpr}: not compared, because a throttle differs from the baseline's: "
                + ", ".join(throttled_otherwise)
            )
        theirs = ", ".join(sorted({_knobs_text(e.get("knobs")) for e in entries} - {_knobs_text(knobs)}))
        if theirs:
            comparison.notes.append(f"dpr {dpr}: knobs differ: these runs {_knobs_text(knobs)}, the baseline {theirs}")
    return comparison


def save_baseline(cells: list[Cell], root: Path, meta: dict[str, Any], knobs: tuple[str, ...]) -> list[str]:
    """Write each clean cell into the baseline of its adapter and ratio,
    replacing that cell and keeping the rest. A cell with a failed run is
    left out, so a broken run never becomes the reference, and so is one
    whose runs do not say whether they were throttled."""
    notes: list[str] = []
    groups: dict[tuple[str, float], list[Cell]] = {}
    left_out = []
    unthrottled_unknown = []
    for cell in cells:
        adapter = cell.adapter()
        if adapter is None or any(row.error is not None for row in cell.rows):
            left_out.append(f"{cell.key} dpr {format_ratio(cell.ratio)}")
            continue
        if UNRECORDED in (cell.throttle(), cell.throttle("linkThrottle")):
            unthrottled_unknown.append(f"{cell.key} dpr {format_ratio(cell.ratio)}")
            continue
        groups.setdefault((adapter, cell.ratio), []).append(cell)
    for (adapter, ratio), group in groups.items():
        path = baseline_path(root, adapter, ratio)
        baseline = load_baseline(path)
        if baseline is None or baseline.get("adapter") != adapter:
            baseline = {"adapter": adapter, "ratio": ratio, "cells": {}}
        for cell in group:
            baseline["cells"][cell.key] = {
                **cell.record(),
                "commit": meta.get("commit"),
                "dirty": meta.get("dirty"),
                "savedAt": meta.get("startedAt"),
                "knobs": list(knobs),
                "sourceThrottle": cell.throttle(),
                "linkThrottle": cell.throttle("linkThrottle"),
                "serverEnv": list(cell.server_env()),
            }
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        partial.write_text(json.dumps(baseline, indent=2), encoding="utf-8")
        os.replace(partial, path)
        notes.append(f"saved {len(group)} cells as the dpr {format_ratio(ratio)} baseline: {path}")
    if left_out:
        notes.append(f"not saved, because a run failed: {', '.join(left_out)}")
    if unthrottled_unknown:
        notes.append(
            f"not saved, because the runs do not say whether they were throttled: {', '.join(unthrottled_unknown)}"
        )
    return notes


# ---------------------------------------------------------------------------
# The summary
# ---------------------------------------------------------------------------


def render_markdown(rows: list[Row], out_dir: Path, comparison: Comparison | None = None) -> str:
    def cell_text(text: str) -> str:
        return text.replace("|", "\\|")

    cells = group_cells(rows)
    lines = [f"adapter: {', '.join(sorted({a for r in rows if (a := adapter_of(r.fields))})) or 'not recorded'}"]
    throttled = sorted(
        {
            r.fields[record]["summary"]
            for r in rows
            for record in ("sourceThrottle", "linkThrottle")
            if (r.fields.get(record) or {}).get("settings")
        }
    )
    if throttled:
        lines.append(f"throttle: {'; '.join(throttled)}")
    server_env = sorted({setting for r in rows for setting in r.case.server_env})
    if server_env:
        lines.append(f"server settings: {' '.join(server_env)}")
    lines += comparison.notes if comparison else []
    compared = comparison if comparison and comparison.compared else None
    columns = COLUMNS + ([BASELINE_COLUMN] if compared else [])
    if compared:
        # Stable, so the rest keep the order they ran in.
        cells.sort(key=lambda c: not compared.regressed(c))
    lines += ["", "| " + " | ".join(columns) + " |", "|" + "|".join(" --- " for _ in columns) + "|"]
    for cell in cells:
        texts = table_cells(cell, out_dir) + ([compared.describe(cell)] if compared else [])
        lines.append("| " + " | ".join(cell_text(t) for t in texts) + " |")
        for step in step_cells(cell):
            texts = step + ([""] if compared else [])
            lines.append("| " + " | ".join(cell_text(t) for t in texts) + " |")
    unjudged = unjudged_steps(cells)
    if unjudged:
        lines += ["", f"{len(unjudged)} step(s) have no verdict, so the table does not call them clear:"]
        lines += [f"- {text}" for text in unjudged]
    return "\n".join(lines) + "\n"


def throttle_record(rows: list[Row], name: str) -> Any:
    """A server throttle as the runs recorded it: the one record they share,
    every distinct one if they differ, or None if none recorded it."""
    records: list[Any] = []
    for row in rows:
        record = row.fields.get(name)
        if record is not None and record not in records:
            records.append(record)
    if not records:
        return None
    return records[0] if len(records) == 1 else records


def summary_json(
    rows: list[Row], out_dir: Path, meta: dict[str, Any], comparison: Comparison | None = None
) -> dict[str, Any]:
    summary = {
        **meta,
        "sourceThrottle": throttle_record(rows, "sourceThrottle"),
        "linkThrottle": throttle_record(rows, "linkThrottle"),
        "rows": [
            {
                "dataset": row.case.dataset.name,
                "scenario": row.case.scenario.name,
                "ratio": row.case.ratio,
                "network": row.case.network,
                "repeat": row.case.repeat,
                "runFile": row.run_file.relative_to(out_dir).as_posix() if row.run_file.exists() else None,
                "log": row.log.relative_to(out_dir).as_posix(),
                "exitCode": row.exit_code,
                "error": row.error,
                **row.fields,
            }
            for row in rows
        ],
        "cells": [
            {
                "dataset": cell.dataset,
                "scenario": cell.scenario,
                "ratio": cell.ratio,
                "network": cell.network,
                "key": cell.key,
                **cell.record(),
                "vsBaseline": None
                if comparison is None or (changes := comparison.found(cell)) is None
                else [{**change.__dict__, "text": str(change)} for change in changes],
            }
            for cell in group_cells(rows)
        ],
    }
    if comparison is not None:
        summary["baseline"] = {"dir": str(comparison.root), "notes": comparison.notes, "refused": comparison.refused}
    return summary


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def write_summary(rows: list[Row], out_dir: Path, meta: dict[str, Any], comparison: Comparison | None = None) -> str:
    markdown = render_markdown(rows, out_dir, comparison)
    (out_dir / "summary.md").write_text(markdown, encoding="utf-8")
    summary = summary_json(rows, out_dir, meta, comparison)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return markdown


def report_failures(rows: list[Row], github: bool) -> None:
    """Name every run that failed, and in a GitHub Actions job annotate each
    on the workflow run."""
    failed = [row for row in rows if row.error]
    if not failed:
        return
    print(f"{len(failed)} of {len(rows)} runs failed:")
    for row in failed:
        print(f"  {row.case.id}: {row.error}")
    if github:
        for row in failed:
            # A workflow command ends at a newline, and % starts an escape.
            message = (row.error or "").replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::error title={row.case.id}::{message}")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _split(values: list[str] | None) -> list[str]:
    return [part for value in values or [] for part in value.split(",") if part]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="perf.py", description="Run lucida trace over datasets x scenarios x device pixel ratios."
    )
    parser.add_argument("--suite", help=f"a named suite from scripts/perf/suites.json (default {DEFAULT_SUITE})")
    parser.add_argument("--dataset", action="append", help="dataset names, comma-separated or repeated")
    parser.add_argument("--scenario", action="append", help="scenario names, comma-separated or repeated")
    parser.add_argument("--ratio", action="append", help="device pixel ratios, comma-separated or repeated")
    parser.add_argument(
        "--repeat", type=int, default=1, help="runs per dataset, scenario and ratio; the table shows their median"
    )
    parser.add_argument(
        "--knob",
        action="append",
        help="a Dev controls knob as NAME=VALUE, NAME being its `lucida trace` flag without the dashes",
    )
    parser.add_argument(
        "--save-baseline",
        action="store_true",
        help="keep these results as the baseline for their adapter and ratio, cell by cell",
    )
    parser.add_argument(
        "--baseline",
        type=Path,
        help="where baselines are kept (default perf-baselines in the clone's git directory)",
    )
    parser.add_argument("--timeout-seconds", type=int, default=120, help="per wait inside a run (default 120)")
    parser.add_argument("--output", type=Path, help="where runs and the summary go (default target/perf/runs/<time>)")
    parser.add_argument("--data", type=Path, help="where generated datasets are cached (default target/perf/datasets)")
    parser.add_argument("--local-catalog", type=Path, default=LOCAL_CATALOG, help="real datasets, merged in")
    server = parser.add_mutually_exclusive_group()
    server.add_argument("--port", type=int, help="the started server's port (default a free one)")
    server.add_argument(
        "--server", metavar="URL", help="drive this running server instead of building and starting one"
    )
    parser.add_argument(
        "--network",
        action="append",
        help=f"start the server under each of these networks' source and link throttles in turn, "
        f"comma-separated or repeated: {', '.join(NETWORKS)}",
    )
    parser.add_argument(
        "--server-env",
        action="append",
        metavar="KEY=VALUE",
        help="a setting for the server this script starts, repeated for more; the summary and the baseline key record it",
    )
    parser.add_argument("--cli", type=Path, metavar="PATH", help="run this built lucida CLI instead of building one")
    parser.add_argument(
        "--gate", action="store_true", help="fail a run that stalls or never settles, as `lucida trace --gate` does"
    )
    parser.add_argument("--bundle", action="store_true", help="also write each run's bundle beside its run file")
    parser.add_argument("--list", action="store_true", help="list datasets, scenarios and suites, then exit")
    parser.add_argument("--dry-run", action="store_true", help="print the runs the selection makes, then exit")
    args = parser.parse_args(argv)
    if args.network and args.server:
        parser.error("--network sets the throttle of a server this script starts; a --server sets its own")
    if args.server_env and args.server:
        parser.error("--server-env sets the environment of a server this script starts; a --server has its own")
    return args


def _interrupt(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt


def print_listing(catalog: dict[str, Dataset], scenarios: dict[str, Scenario], suites: dict[str, Suite]) -> None:
    print("datasets")
    for d in catalog.values():
        source = "local" if d.url else "generated"
        print(f"  {d.name:<16} {', '.join(sorted(d.traits)) or '2D':<28} {source}: {d.description}")
    print("scenarios")
    for s in scenarios.values():
        print(f"  {s.name:<16} needs {', '.join(sorted(s.requires)) or 'nothing':<22} {s.description}")
    print("suites")
    for suite in suites.values():
        print(f"  {suite.name:<16} {suite.description}")


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        # UTF-8 like summary.md: a Windows pipe, such as Git Bash's terminal,
        # would otherwise get the table's × and ± in the locale's code page.
        stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    args = parse_args(argv)
    catalog = load_catalog(PERF_DIR / "datasets.json", args.local_catalog)
    scenarios = load_scenarios(PERF_DIR / "scenarios")
    suites = load_suites(PERF_DIR / "suites.json", catalog, scenarios)
    if args.list:
        print_listing(catalog, scenarios, suites)
        return 0
    selection = Selection(
        suite=args.suite,
        datasets=_split(args.dataset),
        scenarios=_split(args.scenario),
        ratios=[parse_ratio(r) for r in _split(args.ratio)],
        networks=[parse_network(n) for n in _split(args.network)],
        repeat=args.repeat,
        own_server=args.server is None,
        server_env=parse_server_env(args.server_env or []),
    )
    knobs = tuple(parse_knob(k) for k in _split(args.knob))
    cases, skipped = plan(selection, catalog, scenarios, suites)
    suite = chosen_suite(selection, suites)
    if args.server and suite and suite.networks:
        print(
            f"--server: the {suite.name} suite's networks, {', '.join(suite.networks)}, need a server this "
            "script starts; each run records the throttle the given server reports"
        )
    if skipped:
        print(f"not applicable, left out: {describe_skipped(skipped, scenarios, catalog)}")
    if args.dry_run:
        for case in cases:
            print(case.id)
        return 0

    cli = args.cli.resolve() if args.cli else None
    if cli is not None and not cli.is_file():
        raise PerfError(f"--cli names no file: {cli}")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = (args.output or REPO / "target" / "perf" / "runs" / stamp).resolve()
    data_dir = (args.data or REPO / "target" / "perf" / "datasets").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, _interrupt)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _interrupt)

    meta = {
        "commit": _git("rev-parse", "HEAD"),
        "dirty": bool(_git("status", "--porcelain")),
        "startedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "selection": {
            "suite": selection.suite,
            "datasets": selection.datasets,
            "scenarios": selection.scenarios,
            "ratios": selection.ratios,
            "networks": selection.networks,
            "repeat": selection.repeat,
            "knobs": list(knobs),
            "serverEnv": list(selection.server_env),
        },
    }
    github = os.environ.get("GITHUB_ACTIONS") == "true"
    rows: list[Row] = []
    interrupted = False
    try:
        server_url = existing_server(args.server) if args.server else None
        built = build(cli, server=server_url is None)
        needed = [case.dataset for case in cases] + [catalog[name] for case in cases for name in case.scenario.adds]
        locations = ensure_datasets(list({d.name: d for d in needed}.values()), data_dir)
        servers: list[dict[str, Any]] = []
        meta["servers"] = servers
        server: ProcessTree | None = None
        for index, case in enumerate(cases, start=1):
            # One server at a time: the plan groups the cases by network.
            new_network = not servers or case.network != servers[-1]["network"]
            # A throttled server's source cache would serve every run after a
            # dataset's first from memory, past the throttle, so each run
            # gets a server of its own.
            per_run = args.server is None and throttled(case.network)
            if args.server is None and (new_network or per_run):
                if server is not None:
                    server.stop()
                log_name = f"{case.id}.server.log" if per_run else "server.log"
                server, server_url = start_server(
                    built, out_dir, args.port or free_port(), case.network, log_name, case.server_env
                )
            if new_network:
                servers.append({"url": server_url, "network": case.network, "perRun": per_run})
                profile = (
                    " on the {} network (source throttle {}, link throttle {})".format(
                        case.network, *NETWORKS[case.network]
                    )
                    if case.network
                    else ""
                )
                profile += f", settings {' '.join(case.server_env)}" if case.server_env else ""
                fresh = ", a fresh one for each run" if per_run else ""
                print(f"server {server_url}{profile}{fresh}, runs in {out_dir}", flush=True)
            assert server_url is not None
            print(f"[{index}/{len(cases)}] {case.id} ...", end=" ", flush=True)
            row = run_case(
                case,
                built,
                server_url,
                locations,
                out_dir,
                args.timeout_seconds,
                stamp,
                gate=args.gate,
                bundle=args.bundle,
                knobs=knobs,
            )
            rows.append(row)
            print(f"error: {row.error}" if row.error else (row.fields.get("verdict") or "no verdict"), flush=True)
            if github:
                print(f"::group::{case.id}\n{row.log.read_text(encoding='utf-8', errors='replace').rstrip()}")
                print("::endgroup::", flush=True)
    except KeyboardInterrupt:
        interrupted = True
        print("\ninterrupted; stopping the server and browsers", flush=True)
    finally:
        stop_everything()
        shutil.rmtree(out_dir / "tmp", ignore_errors=True)
    if not rows:
        return 130 if interrupted else 0
    cells = group_cells(rows)
    baseline_dir = (args.baseline or default_baseline_dir()).resolve()
    comparison = compare(cells, baseline_dir, knobs)
    print()
    markdown = write_summary(rows, out_dir, meta, comparison)
    print(markdown)
    print(f"summary: {out_dir / 'summary.md'}")
    report_failures(rows, github)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as step_summary:
            step_summary.write(markdown)
    if args.save_baseline and not interrupted:
        for note in save_baseline(cells, baseline_dir, meta, knobs):
            print(note)
    if interrupted:
        return 130
    # 1 when what was measured failed or got worse, 2 when the setup has to
    # change first: a baseline recorded on another adapter is the wrong one.
    if comparison.refused:
        return 2
    return 1 if any(row.error for row in rows) or any(comparison.regressed(c) for c in cells) else 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except PerfError as error:
        stop_everything()
        print(f"perf: {error}", file=sys.stderr)
        sys.exit(2)
