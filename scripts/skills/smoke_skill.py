#!/usr/bin/env python3
"""Run runtime smoke checks for Lucida phase-1 skill workflows."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _wait_for_health(base_url: str, timeout_s: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_s
    with httpx.Client(timeout=2.0) as client:
        while time.monotonic() < deadline:
            try:
                response = client.get(f"{base_url}/healthz")
                if response.status_code == 200 and response.json().get("status") == "ok":
                    return
            except Exception:
                pass
            time.sleep(0.5)
    raise RuntimeError(f"Daemon did not become healthy at {base_url} within {timeout_s} seconds")


def _run_cli_json(command: list[str], env: dict[str, str]) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            cwd=_repo_root(),
            check=True,
            text=True,
            capture_output=True,
            env=env,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "CLI command failed: "
            f"{' '.join(command)}\nstdout:\n{exc.stdout}\nstderr:\n{exc.stderr}"
        ) from exc
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"CLI command did not return JSON: {' '.join(command)}\n{result.stdout}") from exc


def _create_dataset_uri(tmp_dir: Path) -> str:
    sys.path.insert(0, str(_repo_root() / "tests" / "python"))
    from parity.data_setup import create_sample_omezarr

    dataset_path = tmp_dir / "smoke.zarr"
    return create_sample_omezarr(str(dataset_path))


def run_smoke(base_url: str, tmp_dir: Path) -> None:
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dataset_uri = _create_dataset_uri(tmp_dir)

    env = os.environ.copy()
    env["LUCIDA_BASE_URL"] = base_url

    cli_session = _run_cli_json(["uv", "run", "lucida", "session", "create", "--json"], env=env)
    session_id = str(cli_session["session_id"])

    cli_dataset = _run_cli_json(
        [
            "uv",
            "run",
            "lucida",
            "dataset",
            "open",
            "--uri",
            dataset_uri,
            "--dataset-id",
            "smoke_dataset_cli",
            "--session-id",
            session_id,
            "--json",
        ],
        env=env,
    )
    dataset_id = str(cli_dataset["dataset_summary"]["dataset_id"])

    cli_view = _run_cli_json(
        [
            "uv",
            "run",
            "lucida",
            "view",
            "create",
            "--dataset-id",
            dataset_id,
            "--session-id",
            session_id,
            "--mode",
            "2d",
            "--json",
        ],
        env=env,
    )
    view_id = str(cli_view["view_state"]["view_id"])

    cli_render = _run_cli_json(
        [
            "uv",
            "run",
            "lucida",
            "render",
            "image",
            "--view-id",
            view_id,
            "--session-id",
            session_id,
            "--width-px",
            "192",
            "--height-px",
            "128",
            "--delivery",
            "inline_base64",
            "--json",
        ],
        env=env,
    )
    if cli_render.get("status") != "ok":
        raise RuntimeError("CLI render flow did not return status=ok")

    with httpx.Client(base_url=base_url, timeout=20.0) as client:
        session_resp = client.post("/session/create", json={"schema_version": 1})
        session_resp.raise_for_status()
        http_session = session_resp.json()
        http_session_id = str(http_session["session_id"])

        dataset_resp = client.post(
            "/dataset/open",
            json={
                "schema_version": 1,
                "uri": dataset_uri,
                "dataset_id": "smoke_dataset_http",
                "session_id": http_session_id,
            },
        )
        dataset_resp.raise_for_status()
        http_dataset = dataset_resp.json()
        http_dataset_id = str(http_dataset["dataset_summary"]["dataset_id"])

        view_resp = client.post(
            "/view/create",
            json={
                "schema_version": 1,
                "dataset_id": http_dataset_id,
                "session_id": http_session_id,
                "mode": "2d",
            },
        )
        view_resp.raise_for_status()
        http_view = view_resp.json()
        http_view_id = str(http_view["view_state"]["view_id"])

        get_view_resp = client.get(f"/view/{http_view_id}", params={"session_id": http_session_id})
        get_view_resp.raise_for_status()

        render_resp = client.post(
            "/render/image",
            json={
                "schema_version": 1,
                "view_id": http_view_id,
                "session_id": http_session_id,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 192,
                    "height_px": 128,
                },
            },
        )
        render_resp.raise_for_status()
        render_json = render_resp.json()
        if render_json.get("status") != "ok":
            raise RuntimeError("HTTP render flow did not return status=ok")

        missing_view_resp = client.post(
            "/view/update",
            json={
                "schema_version": 1,
                "view_id": "view_missing",
                "session_id": http_session_id,
                "patch": [{"op": "replace", "path": "/view_2d/camera/zoom", "value": 1.1}],
            },
        )
        if missing_view_resp.status_code != 404:
            raise RuntimeError("Expected 404 for missing view update")
        if missing_view_resp.json().get("code") != "view_not_found":
            raise RuntimeError("Expected view_not_found error code")

        unsupported_mode_resp = client.post(
            "/view/create",
            json={
                "schema_version": 1,
                "dataset_id": http_dataset_id,
                "session_id": http_session_id,
                "mode": "3d",
            },
        )
        if unsupported_mode_resp.status_code != 422:
            raise RuntimeError("Expected 422 for unsupported mode")
        if unsupported_mode_resp.json().get("code") != "unsupported_mode":
            raise RuntimeError("Expected unsupported_mode error code")

        oversize_render_resp = client.post(
            "/render/image",
            json={
                "schema_version": 1,
                "view_id": http_view_id,
                "session_id": http_session_id,
                "output": {
                    "format": "png",
                    "delivery": "inline_base64",
                    "width_px": 5000,
                    "height_px": 5000,
                },
            },
        )
        if oversize_render_resp.status_code != 422:
            raise RuntimeError("Expected 422 for oversized render")
        if oversize_render_resp.json().get("code") != "render_output_too_large":
            raise RuntimeError("Expected render_output_too_large error code")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Lucida skill smoke tests.")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000", help="Daemon base URL")
    parser.add_argument(
        "--tmp-dir",
        type=Path,
        default=Path("tmp") / "skills" / "smoke",
        help="Temporary dataset path.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    _wait_for_health(args.base_url)
    run_smoke(base_url=args.base_url, tmp_dir=args.tmp_dir)
    print("skill smoke tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
