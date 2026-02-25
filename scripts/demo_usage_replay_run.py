#!/usr/bin/env python3
"""Create a replay-friendly demo run for Lucida usage/replay UIs."""

from __future__ import annotations

import argparse
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse
from urllib.parse import urlencode

import httpx
import numpy as np
import zarr
import fsspec

from lucida.client import LucidaClient


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


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
            time.sleep(0.3)
    raise RuntimeError(f"Daemon did not become healthy at {base_url} within {timeout_s} seconds.")


def _open_group_for_write(uri: str) -> zarr.Group:
    parsed = urlparse(uri)
    if parsed.scheme in ("", "file"):
        if parsed.scheme == "file":
            path = Path(unquote(parsed.path))
        else:
            path = Path(uri)
        path = path.expanduser().resolve(strict=False)
        path.mkdir(parents=True, exist_ok=True)
        return zarr.open_group(store=str(path), mode="w")

    mapper = fsspec.get_mapper(uri, create=True)
    return zarr.open_group(store=mapper, mode="w")


def _create_demo_dataset(tmp_dir: Path) -> str:
    """Create a larger asymmetric OME-Zarr fixture for replay demos."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dataset_uri = str(tmp_dir / f"replay-demo-asym-{uuid.uuid4().hex}.zarr")
    root = _open_group_for_write(dataset_uri)

    shape_level0 = (1, 3, 48, 220, 340)  # (t, c, z, y, x) intentionally asymmetric
    chunk_level0 = (1, 1, 8, 64, 64)
    data_level0 = np.zeros(shape_level0, dtype=np.uint16)

    z = np.arange(shape_level0[2], dtype=np.float32)[:, None, None]
    y = np.arange(shape_level0[3], dtype=np.float32)[None, :, None]
    x = np.arange(shape_level0[4], dtype=np.float32)[None, None, :]

    # Channel 0: off-center ellipsoid + secondary lobe.
    ellipsoid = np.exp(-(((z - 14.0) / 7.0) ** 2 + ((y - 72.0) / 30.0) ** 2 + ((x - 236.0) / 50.0) ** 2))
    lobe = np.exp(-(((z - 33.0) / 9.0) ** 2 + ((y - 170.0) / 22.0) ** 2 + ((x - 102.0) / 28.0) ** 2))
    ch0 = (ellipsoid * 53000.0) + (lobe * 24000.0)

    # Channel 1: tilted ridge with x-wave modulation.
    ridge_center = (0.56 * x) + (0.32 * y) + 9.0
    ridge = np.exp(-((z - ridge_center) / 2.4) ** 2)
    wave = (np.sin((x / float(shape_level0[4])) * np.pi * 6.0) * 0.5) + 0.5
    vertical_band = ((y > 32.0) & (y < 204.0)).astype(np.float32)
    ch1 = ridge * vertical_band * (14000.0 + (wave * 36000.0))

    # Channel 2: dual blobs + diagonal filament to highlight pan/plane changes.
    blob_a = np.exp(-(((z - 21.0) / 5.8) ** 2 + ((y - 112.0) / 16.0) ** 2 + ((x - 60.0) / 19.0) ** 2))
    blob_b = np.exp(-(((z - 27.0) / 6.4) ** 2 + ((y - 186.0) / 17.0) ** 2 + ((x - 288.0) / 21.0) ** 2))
    filament = np.exp(-(((x - ((2.85 * y) + 18.0)) / 3.2) ** 2)) * np.exp(-(((z - 24.0) / 11.0) ** 2))
    ch2 = (blob_a * 42000.0) + (blob_b * 46000.0) + (filament * 23000.0)

    data_level0[0, 0] = np.clip(ch0, 0, 65535).astype(np.uint16)
    data_level0[0, 1] = np.clip(ch1, 0, 65535).astype(np.uint16)
    data_level0[0, 2] = np.clip(ch2, 0, 65535).astype(np.uint16)

    data_level1 = data_level0[:, :, ::2, ::2, ::2]
    chunk_level1 = (1, 1, 4, 32, 32)

    root.create_array("0", data=data_level0, chunks=chunk_level0, overwrite=True)
    root.create_array("1", data=data_level1, chunks=chunk_level1, overwrite=True)
    root.attrs["multiscales"] = [
        {
            "name": "primary",
            "axes": [
                {"name": "t", "type": "t"},
                {"name": "c", "type": "c"},
                {"name": "z", "type": "z"},
                {"name": "y", "type": "y"},
                {"name": "x", "type": "x"},
            ],
            "datasets": [
                {"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 1, 1, 1]}]},
                {"path": "1", "coordinateTransformations": [{"type": "scale", "scale": [1, 1, 2, 2, 2]}]},
            ],
        }
    ]
    root.attrs["omero"] = {
        "channels": [
            {"index": 0, "label": "asym_blob", "color": "ffff00", "window": {"start": 0, "end": 65000}},
            {"index": 1, "label": "tilted_ridge", "color": "ff00ff", "window": {"start": 0, "end": 65000}},
            {"index": 2, "label": "dual_lobe_diag", "color": "00ffff", "window": {"start": 0, "end": 65000}},
        ]
    }
    return dataset_uri


@dataclass(frozen=True, slots=True)
class DemoRunResult:
    run_id: str
    session_id: str
    dataset_id: str
    view_id: str
    event_count: int
    timeline_url: str
    replay_url: str
    events_api_url: str


def run_demo(
    *,
    base_url: str,
    run_id: str,
    agent_name: str,
    dataset_uri: str | None,
    tmp_dir: Path,
    width_px: int,
    height_px: int,
) -> DemoRunResult:
    resolved_dataset_uri = dataset_uri or _create_demo_dataset(tmp_dir)

    with LucidaClient(
        base_url=base_url,
        agent_run_id=run_id,
        agent_name=agent_name,
    ) as client:
        session = client.create_session(agent_step_id="session_create")
        opened = client.open_dataset(
            uri=resolved_dataset_uri,
            session_id=session.session_id,
            agent_step_id="dataset_open",
        )
        created = client.create_view(
            dataset_id=opened.dataset_summary.dataset_id,
            session_id=session.session_id,
            mode="2d",
            agent_step_id="view_create",
        )

        client.set_dim(
            view_id=created.view_state.view_id,
            axis="z",
            index=8,
            session_id=session.session_id,
            agent_step_id="set_z_low",
        )
        client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=width_px,
            height_px=height_px,
            agent_step_id="render_z_low",
        )
        client.set_dim(
            view_id=created.view_state.view_id,
            axis="z",
            index=34,
            session_id=session.session_id,
            agent_step_id="set_z_high",
        )
        client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=width_px,
            height_px=height_px,
            agent_step_id="render_z_high",
        )
        client.pan(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            dx_px=110.0,
            dy_px=-56.0,
            agent_step_id="pan",
        )
        client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=width_px,
            height_px=height_px,
            agent_step_id="render_after_pan",
        )
        client.zoom(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            factor=1.8,
            agent_step_id="zoom_in",
        )
        client.set_dim(
            view_id=created.view_state.view_id,
            axis="c",
            index=2,
            session_id=session.session_id,
            agent_step_id="set_channel_2",
        )
        client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=width_px,
            height_px=height_px,
            agent_step_id="render_channel_2",
        )
        client.set_plane(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            plane="yz",
            agent_step_id="set_plane_yz",
        )
        client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=width_px,
            height_px=height_px,
            agent_step_id="render_after_plane",
        )

        events = client.list_usage_events(run_id=run_id, limit=500)
        if len(events.events) < 14:
            raise RuntimeError(
                f"Expected at least 14 usage events for run {run_id}, got {len(events.events)}."
            )

    timeline_url = f"{base_url}/ui"
    replay_url = f"{base_url}/ui/replay"
    events_api_url = f"{base_url}/usage/events?{urlencode({'run_id': run_id, 'limit': 200})}"
    return DemoRunResult(
        run_id=run_id,
        session_id=session.session_id,
        dataset_id=opened.dataset_summary.dataset_id,
        view_id=created.view_state.view_id,
        event_count=len(events.events),
        timeline_url=timeline_url,
        replay_url=replay_url,
        events_api_url=events_api_url,
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a demo run for Lucida visual replay.")
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:3000",
        help="Lucida daemon base URL.",
    )
    parser.add_argument(
        "--run-id",
        default=f"demo_{uuid.uuid4().hex[:10]}",
        help="Agent run id to write into telemetry headers.",
    )
    parser.add_argument(
        "--agent-name",
        default="replay-demo-agent",
        help="Agent name to write into telemetry headers.",
    )
    parser.add_argument(
        "--dataset-uri",
        default=None,
        help="Optional existing OME-Zarr URI. If omitted, a synthetic demo dataset is created.",
    )
    parser.add_argument(
        "--tmp-dir",
        type=Path,
        default=Path("tmp") / "replay-demo",
        help="Temporary directory for generated demo dataset.",
    )
    parser.add_argument("--width-px", type=int, default=768, help="Render width for replay frames.")
    parser.add_argument("--height-px", type=int, default=768, help="Render height for replay frames.")
    parser.add_argument(
        "--skip-health-check",
        action="store_true",
        help="Skip waiting for /healthz before running demo calls.",
    )
    return parser.parse_args()


def _print_result(result: DemoRunResult) -> None:
    print("Demo run created successfully.")
    print(f"run_id: {result.run_id}")
    print(f"session_id: {result.session_id}")
    print(f"dataset_id: {result.dataset_id}")
    print(f"view_id: {result.view_id}")
    print(f"event_count: {result.event_count}")
    print(f"timeline_ui: {result.timeline_url}")
    print(f"replay_ui: {result.replay_url}")
    print(f"events_api: {result.events_api_url}")
    print(
        "Open replay UI, select run_id, and click Load Run to step through what the agent saw."
    )


def main() -> int:
    args = _parse_args()
    if not args.skip_health_check:
        _wait_for_health(args.base_url)
    result = run_demo(
        base_url=args.base_url,
        run_id=args.run_id,
        agent_name=args.agent_name,
        dataset_uri=args.dataset_uri,
        tmp_dir=args.tmp_dir,
        width_px=args.width_px,
        height_px=args.height_px,
    )
    _print_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
