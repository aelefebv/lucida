#!/usr/bin/env python3
"""Fixture-backed dataset reliability smoke for a running Lucida server."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE_ROOT = Path("/Users/austin/local_data/lucida_test_zarrs")
EXPECTED_OPEN_STAGES = {
    "request_received",
    "authorization",
    "source_lookup",
    "backend_open",
    "metadata_import",
    "binding_build",
    "workspace_persist",
    "broadcast",
    "complete",
}
FIXTURES = [
    {
        "name": "cppx_plate",
        "path": "20250925_CPPX245_ISR_Washout_v4.ome.zarr",
        "kind": "plate",
        "min_images": 1,
        "min_entities": 1,
        "min_channels": 3,
    },
    {
        "name": "yeast_3d",
        "path": "yeast_3d_mitochondria_large.ome.zarr",
        "kind": "single",
        "min_images": 1,
        "min_entities": 1,
        "min_channels": 1,
    },
    {
        "name": "lif_bundled_channels",
        "path": "lif_test.ome.zarr",
        "kind": "single",
        "min_images": 1,
        "min_entities": 1,
        "min_channels": 5,
    },
    {
        "name": "czi_noncanonical_axes",
        "path": "czi_test.ome.zarr",
        "kind": "single",
        "min_images": 1,
        "min_entities": 1,
        "min_channels": 1,
    },
]


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_json_error(stderr: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    payload = None
    for index, char in enumerate(stderr):
        if char != "{":
            continue
        try:
            candidate, _ = decoder.raw_decode(stderr[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and "error" in candidate:
            payload = candidate
    if payload is None:
        raise AssertionError(f"stderr did not contain a JSON error envelope:\n{stderr}")
    return payload


def slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-").lower()


class CliRunner:
    def __init__(self, command: list[str], server: str, config_path: Path, artifact_dir: Path):
        self.command = command
        self.server = server
        self.config_path = config_path
        self.artifact_dir = artifact_dir

    def run_json(self, label: str, args: list[str], *, expect_success: bool = True) -> dict[str, Any]:
        command = [*self.command, "--server", self.server, "--json", *args]
        env = os.environ.copy()
        env["LUCIDA_CONFIG_PATH"] = str(self.config_path)
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        command_record = {
            "command": command,
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
        write_json(self.artifact_dir / f"{label}.command.json", command_record)
        if expect_success:
            if result.returncode != 0:
                raise AssertionError(
                    f"{label} failed with {result.returncode}:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
                )
            payload = json.loads(result.stdout)
        else:
            if result.returncode == 0:
                raise AssertionError(f"{label} unexpectedly succeeded:\n{result.stdout}")
            payload = parse_json_error(result.stderr)
        write_json(self.artifact_dir / f"{label}.json", payload)
        return payload


def progress_stages(open_payload: dict[str, Any]) -> set[str]:
    progress = open_payload.get("dataset", {}).get("progress") or []
    return {
        item.get("stage")
        for item in progress
        if isinstance(item, dict) and isinstance(item.get("stage"), str)
    }


def assert_open_result(name: str, fixture: dict[str, Any], payload: dict[str, Any]) -> str:
    dataset = payload["dataset"]
    missing = EXPECTED_OPEN_STAGES - progress_stages(payload)
    if missing:
        raise AssertionError(f"{name} open did not report expected progress stages: {sorted(missing)}")
    if dataset.get("image_count", 0) < fixture["min_images"]:
        raise AssertionError(f"{name} image_count too small: {dataset.get('image_count')}")
    if dataset.get("entity_count", 0) < fixture["min_entities"]:
        raise AssertionError(f"{name} entity_count too small: {dataset.get('entity_count')}")
    return str(dataset["workspace_dataset_id"])


def assert_info_result(name: str, fixture: dict[str, Any], payload: dict[str, Any]) -> None:
    dataset = payload["dataset"]
    if dataset.get("kind") != fixture["kind"]:
        raise AssertionError(f"{name} kind expected {fixture['kind']}, got {dataset.get('kind')}")
    channel_count = dataset.get("channel_count")
    if channel_count is None or channel_count < fixture["min_channels"]:
        raise AssertionError(f"{name} channel_count too small: {channel_count}")
    if not dataset.get("images"):
        raise AssertionError(f"{name} did not expose image metadata")


def assert_health_result(name: str, payload: dict[str, Any]) -> dict[str, Any]:
    datasets = payload.get("datasets") or []
    if len(datasets) != 1:
        raise AssertionError(f"{name} expected one health record, got {len(datasets)}")
    health = datasets[0]
    if health.get("status") != "healthy":
        raise AssertionError(f"{name} expected healthy status, got {health.get('status')}: {health}")
    if health.get("binding", {}).get("status") != "healthy":
        raise AssertionError(f"{name} binding is not healthy: {health.get('binding')}")
    if not health.get("source_cache"):
        raise AssertionError(f"{name} missing source_cache health")
    if "generated_coarse" not in health:
        raise AssertionError(f"{name} missing generated_coarse health")
    return health


def assert_negative(payload: dict[str, Any], *, stage: str, kinds: set[str]) -> None:
    error = payload["error"]
    diagnostic = error.get("diagnostic")
    if not isinstance(diagnostic, dict):
        raise AssertionError(f"error did not include diagnostic: {payload}")
    if diagnostic.get("stage") != stage:
        raise AssertionError(f"expected failure stage {stage}, got {diagnostic.get('stage')}")
    if diagnostic.get("kind") not in kinds:
        raise AssertionError(f"expected failure kind in {sorted(kinds)}, got {diagnostic.get('kind')}")


def import_python_client() -> tuple[Any, Any]:
    sys.path.insert(0, str(REPO_ROOT / "lucida-py" / "python"))
    try:
        from lucida import LucidaClient, LucidaError
    except ImportError as error:
        raise SystemExit(
            "Could not import lucida Python client. Run this smoke as:\n"
            "  uv run --project lucida-py python scripts/smoke_dataset_reliability.py"
        ) from error
    return LucidaClient, LucidaError


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=os.environ.get("LUCIDA_SMOKE_SERVER", "http://127.0.0.1:9876"))
    parser.add_argument("--fixtures-root", default=os.environ.get("LUCIDA_FIXTURES_ROOT", str(DEFAULT_FIXTURE_ROOT)))
    parser.add_argument("--workspace", default=f"lucida-dataset-reliability-{time.strftime('%Y%m%d-%H%M%S')}")
    parser.add_argument("--output-dir")
    parser.add_argument("--config-path")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--cli", default=os.environ.get("LUCIDA_SMOKE_CLI", "cargo run --quiet -p lucida-cli --"))
    parser.add_argument("--skip-python", action="store_true")
    args = parser.parse_args()

    fixtures_root = Path(args.fixtures_root)
    output_dir = Path(args.output_dir or tempfile.mkdtemp(prefix="lucida-dataset-reliability."))
    output_dir.mkdir(parents=True, exist_ok=True)
    config_path = Path(args.config_path or output_dir / "config.json")
    cli = CliRunner(shlex.split(args.cli), args.server, config_path, output_dir / "cli")

    summary: dict[str, Any] = {
        "server": args.server,
        "fixtures_root": str(fixtures_root),
        "workspace": {"name": args.workspace},
        "fixtures": [],
        "negative": {},
    }

    cli.run_json("status", ["status"])
    workspace_payload = cli.run_json("workspace-create", ["workspace", "create", args.workspace])
    workspace_id = workspace_payload["workspace"]["id"]
    summary["workspace"]["id"] = workspace_id
    summary["workspace"]["url"] = f"{args.server.rstrip('/')}/w/{workspace_id}"
    cli.run_json("workspace-use", ["workspace", "use", workspace_id])
    cli.run_json("workspace-open", ["workspace", "open", workspace_id, "--no-browser"])

    python_workspace = None
    LucidaError = None
    if not args.skip_python:
        LucidaClient, LucidaError = import_python_client()
        python_client = LucidaClient(args.server, config_path=config_path, timeout=args.timeout)
        python_workspace = python_client.workspaces.use(workspace_id)

    ran_fixture = False
    for fixture in FIXTURES:
        path = fixtures_root / fixture["path"]
        record: dict[str, Any] = {
            "name": fixture["name"],
            "path": str(path),
            "present": path.is_dir(),
            "status": "skipped",
        }
        if not path.is_dir():
            summary["fixtures"].append(record)
            continue

        ran_fixture = True
        label = slug(fixture["name"])
        open_payload = cli.run_json(
            f"{label}-open",
            ["dataset", "open", str(path), "--timeout-seconds", str(int(args.timeout))],
        )
        dataset_id = assert_open_result(fixture["name"], fixture, open_payload)
        info_payload = cli.run_json(
            f"{label}-info",
            ["dataset", "info", dataset_id, "--timeout-seconds", str(int(args.timeout))],
        )
        assert_info_result(fixture["name"], fixture, info_payload)
        health_payload = cli.run_json(
            f"{label}-health",
            ["dataset", "health", dataset_id, "--timeout-seconds", str(int(args.timeout))],
        )
        health = assert_health_result(fixture["name"], health_payload)

        python_health = None
        if python_workspace is not None:
            python_health = python_workspace.datasets.health(dataset_id, timeout=args.timeout)
            if len(python_health) != 1 or python_health[0].get("status") != health.get("status"):
                raise AssertionError(f"{fixture['name']} Python health disagreed with CLI health")

        record.update(
            {
                "status": "passed",
                "workspace_dataset_id": dataset_id,
                "image_count": open_payload["dataset"]["image_count"],
                "entity_count": open_payload["dataset"]["entity_count"],
                "channel_count": info_payload["dataset"].get("channel_count"),
                "health": health.get("status"),
                "progress_stages": sorted(progress_stages(open_payload)),
                "python_health": python_health[0].get("status") if python_health else "skipped",
            }
        )
        summary["fixtures"].append(record)

    if not ran_fixture:
        raise SystemExit(f"No configured fixtures were found under {fixtures_root}")

    missing_path = output_dir / "missing-dataset-does-not-exist.ome.zarr"
    missing_payload = cli.run_json(
        "negative-missing-open",
        ["dataset", "open", str(missing_path), "--timeout-seconds", str(int(args.timeout))],
        expect_success=False,
    )
    assert_negative(missing_payload, stage="backend_open", kinds={"local_path", "missing_object"})
    summary["negative"]["missing_path"] = missing_payload["error"]

    malformed_path = output_dir / "malformed.ome.zarr"
    malformed_path.mkdir(parents=True, exist_ok=True)
    (malformed_path / "zarr.json").write_text("{", encoding="utf-8")
    malformed_payload = cli.run_json(
        "negative-malformed-open",
        ["dataset", "open", str(malformed_path), "--timeout-seconds", str(int(args.timeout))],
        expect_success=False,
    )
    assert_negative(malformed_payload, stage="metadata_import", kinds={"malformed_metadata"})
    summary["negative"]["malformed_metadata"] = malformed_payload["error"]

    if python_workspace is not None and LucidaError is not None:
        try:
            python_workspace.datasets.open(str(missing_path), timeout=args.timeout)
        except LucidaError as error:
            diagnostic = error.diagnostic or {}
            if diagnostic.get("stage") != "backend_open":
                raise AssertionError(f"Python missing-path failure stage was {diagnostic.get('stage')}")
            summary["negative"]["python_missing_path"] = error.to_dict()["error"]
        else:
            raise AssertionError("Python missing-path open unexpectedly succeeded")

    write_json(output_dir / "dataset-reliability-summary.json", summary)
    print("Lucida dataset reliability smoke passed.")
    print(f"Server: {args.server}")
    print(f"Workspace ID: {workspace_id}")
    print(f"Browser URL: {summary['workspace']['url']}")
    print(f"Artifacts: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
