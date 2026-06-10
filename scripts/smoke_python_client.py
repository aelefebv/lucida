#!/usr/bin/env python3
"""Smoke test the Lucida Python client against a running lucida-server."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from lucida import LucidaClient


DEFAULT_DATASET = Path(
    "/Users/austin/local_data/lucida_test_zarrs/20250925_CPPX245_ISR_Washout_v4.ome.zarr"
)


def resolve_dataset(value: str | None) -> str:
    if value:
        return value
    env_value = os.environ.get("LUCIDA_SMOKE_DATASET")
    if env_value:
        return env_value
    if DEFAULT_DATASET.is_dir():
        return str(DEFAULT_DATASET)
    raise SystemExit("Set --dataset or LUCIDA_SMOKE_DATASET to a server-visible OME-Zarr path or URL.")


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default=os.environ.get("LUCIDA_SMOKE_SERVER", "http://127.0.0.1:9876"))
    parser.add_argument("--dataset")
    parser.add_argument("--workspace", default=f"lucida-python-smoke-{time.strftime('%Y%m%d-%H%M%S')}")
    parser.add_argument("--output-dir")
    parser.add_argument("--config-path")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    dataset = resolve_dataset(args.dataset)
    output_dir = Path(args.output_dir or tempfile.mkdtemp(prefix="lucida-python-smoke."))
    output_dir.mkdir(parents=True, exist_ok=True)
    config_path = Path(args.config_path or output_dir / "config.json")

    client = LucidaClient(args.server, config_path=config_path, timeout=args.timeout)
    status = client.status()
    workspace = client.workspaces.create(args.workspace)
    workspace = client.workspaces.use(workspace.id)
    workspace.open()

    opened = workspace.datasets.open(dataset, timeout=max(args.timeout, 300.0))
    dataset_id = opened["workspace_dataset_id"]
    datasets = workspace.datasets.list(timeout=args.timeout)
    info = workspace.datasets.info(dataset_id, timeout=args.timeout)

    view_pan = workspace.view.pan(24.0, -12.0, timeout=args.timeout)
    view_zoom = workspace.view.set_zoom(1.2, timeout=args.timeout)
    channel_mode = workspace.channel.mode("multi", timeout=args.timeout)
    layer_opacity = workspace.layer.opacity(dataset_id, 0.9, timeout=args.timeout)
    channel_colormap = workspace.channel.colormap(dataset_id, 0, "magenta", timeout=args.timeout)
    debug = workspace.debug.state(timeout=args.timeout)

    summary = {
        "server": args.server,
        "workspace": {
            "id": workspace.id,
            "name": workspace.name,
            "web_url": workspace.web_url,
            "ws_url": workspace.ws_url,
        },
        "dataset": {
            "source": dataset,
            "workspace_dataset_id": dataset_id,
            "name": opened.get("name"),
            "image_count": opened.get("image_count"),
            "entity_count": opened.get("entity_count"),
        },
        "status": status,
        "dataset_count": len(datasets),
        "debug_dataset_count": len(debug.get("datasets", [])),
        "view": {
            "pan": view_pan,
            "zoom": view_zoom,
        },
        "channel_mode": channel_mode,
        "layer_opacity": layer_opacity,
        "channel_colormap": channel_colormap,
        "dataset_info": info,
    }
    write_json(output_dir / "python-smoke-summary.json", summary)

    print("Lucida Python smoke passed.")
    print(f"Server: {args.server}")
    print(f"Workspace ID: {workspace.id}")
    print(f"Dataset ID: {dataset_id}")
    print(f"Browser URL: {workspace.web_url}")
    print(f"Artifacts: {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
