from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .client import AttachMode, LucidaClient

STATE_ROOT = Path.home() / ".lucida_cli"


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    output = _dispatch(args)
    if args.output == "json":
        print(json.dumps(output, indent=2, sort_keys=True))
    else:
        print(_to_human(output))
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lucida")
    parser.add_argument("--output", choices=["json", "text"], default="json")

    subparsers = parser.add_subparsers(dest="command", required=True)

    open_parser = subparsers.add_parser("open")
    _add_session_identifiers(open_parser)
    open_parser.add_argument("--name", required=True)
    open_parser.add_argument("--uri", required=True)

    attach_parser = subparsers.add_parser("attach")
    _add_session_identifiers(attach_parser)
    attach_parser.add_argument("--client-label", required=True)
    attach_parser.add_argument(
        "--mode",
        choices=[mode.value for mode in AttachMode],
        default=AttachMode.OPEN_VIEW.value,
    )
    attach_parser.add_argument("--token")

    pan_parser = subparsers.add_parser("pan")
    _add_session_identifiers(pan_parser)
    pan_parser.add_argument("--dx", required=True, type=float)
    pan_parser.add_argument("--dy", required=True, type=float)

    set_parser = subparsers.add_parser("set")
    _add_session_identifiers(set_parser)
    set_group = set_parser.add_mutually_exclusive_group(required=True)
    set_group.add_argument(
        "--point",
        nargs=4,
        metavar=("X", "Y", "Z", "T"),
        type=float,
    )
    set_group.add_argument(
        "--camera",
        nargs=3,
        metavar=("CENTER_X", "CENTER_Y", "ZOOM"),
        type=float,
    )
    set_group.add_argument("--z", type=int)
    set_group.add_argument("--t", type=int)
    set_group.add_argument("--channels")

    overview_parser = subparsers.add_parser("overview")
    _add_session_identifiers(overview_parser)
    overview_parser.add_argument("--active-layer-id")

    snapshot_parser = subparsers.add_parser("snapshot")
    _add_session_identifiers(snapshot_parser)

    return parser


def _dispatch(args: argparse.Namespace) -> dict[str, Any]:
    client = LucidaClient(session_id=args.session_id, client_id=args.client_id)
    command = args.command

    if command == "open":
        envelope = client.add_image(name=args.name, source_uri=args.uri)
        output = {"command": "open", "envelope": envelope.as_dict()}
        _append_history(args.session_id, args.client_id, output)
        return output

    if command == "attach":
        mode = AttachMode(args.mode)
        attach_payload = client.attach_session(
            client_label=args.client_label,
            mode=mode,
            token=args.token,
        )
        output = {"command": "attach", "payload": attach_payload}
        _append_history(args.session_id, args.client_id, output)
        return output

    if command == "pan":
        envelope = client.pan(dx=args.dx, dy=args.dy)
        output = {"command": "pan", "envelope": envelope.as_dict()}
        _append_history(args.session_id, args.client_id, output)
        return output

    if command == "set":
        output = {"command": "set", "envelope": _build_set_envelope(client, args).as_dict()}
        _append_history(args.session_id, args.client_id, output)
        return output

    if command == "overview":
        envelope = client.set_active_layer(active_layer_id=args.active_layer_id)
        output = {"command": "overview", "envelope": envelope.as_dict()}
        _append_history(args.session_id, args.client_id, output)
        return output

    if command == "snapshot":
        return {
            "command": "snapshot",
            "session_id": args.session_id,
            "client_id": args.client_id,
            "history": _load_history(args.session_id, args.client_id),
        }

    raise ValueError(f"unsupported command: {command}")


def _build_set_envelope(client: LucidaClient, args: argparse.Namespace) -> Any:
    if args.point is not None:
        x, y, z, t = args.point
        return client.set_point(x=x, y=y, z=int(z), t=int(t))
    if args.camera is not None:
        center_x, center_y, zoom = args.camera
        return client.set_camera(center_x=center_x, center_y=center_y, zoom=zoom)
    if args.z is not None:
        return client.set_z(args.z)
    if args.t is not None:
        return client.set_t(args.t)
    if args.channels is not None:
        channels = [int(part) for part in args.channels.split(",") if part]
        return client.set_channels(channels)
    raise ValueError("unsupported set command payload")


def _add_session_identifiers(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--client-id", required=True)


def _state_path(session_id: str, client_id: str) -> Path:
    return STATE_ROOT / f"{session_id}_{client_id}.json"


def _load_history(session_id: str, client_id: str) -> list[dict[str, Any]]:
    path = _state_path(session_id, client_id)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _append_history(session_id: str, client_id: str, item: dict[str, Any]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    history = _load_history(session_id, client_id)
    history.append(item)
    path = _state_path(session_id, client_id)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(history, handle, indent=2, sort_keys=True)


def _to_human(output: dict[str, Any]) -> str:
    command = output.get("command", "unknown")
    if command == "snapshot":
        history = output.get("history", [])
        return f"snapshot: {len(history)} history entries"
    if "envelope" in output:
        envelope = output["envelope"]
        return f"{command}: {envelope['op']} seq={envelope['client_seq']}"
    if "payload" in output:
        payload = output["payload"]
        return f"{command}: mode={payload['auth']['mode']}"
    return json.dumps(output, sort_keys=True)


if __name__ == "__main__":
    raise SystemExit(main())
