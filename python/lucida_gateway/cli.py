"""CLI entrypoint for Step 11 gateway service."""

from __future__ import annotations

import argparse
import os
import sys

from aiohttp import web

from .config import GatewayConfig
from .server import WebGatewayServer


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lucida-gateway")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run the Step 11 web gateway")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--token", default=None)
    serve.add_argument("--local-ipc-uri", default=None)
    serve.add_argument("--tls-termination", action="store_true")
    serve.add_argument("--frame-rate", type=int, default=15)
    serve.add_argument("--tile-size", type=int, default=256)
    serve.add_argument("--jpeg-quality", type=int, default=75)
    serve.add_argument("--render-queue-capacity", type=int, default=2)
    serve.add_argument("--overflow-close-threshold", type=int, default=10)
    serve.add_argument("--event-poll-interval", type=float, default=0.05)
    serve.add_argument("--no-auto-launch-daemon", action="store_true")

    return parser


def _serve(args: argparse.Namespace) -> int:
    token = args.token or os.getenv("LUCIDA_GATEWAY_TOKEN")
    if not isinstance(token, str) or not token:
        print("gateway token is required via --token or LUCIDA_GATEWAY_TOKEN", file=sys.stderr)
        return 2

    config = GatewayConfig(
        host=args.host,
        port=args.port,
        token=token,
        local_ipc_uri=args.local_ipc_uri,
        tls_termination=bool(args.tls_termination),
        frame_rate_hz=args.frame_rate,
        tile_size_px=args.tile_size,
        jpeg_quality=args.jpeg_quality,
        render_queue_capacity=args.render_queue_capacity,
        overflow_close_threshold=args.overflow_close_threshold,
        event_poll_interval_s=args.event_poll_interval,
        auto_launch_daemon=not bool(args.no_auto_launch_daemon),
    )
    server = WebGatewayServer(config=config)
    web.run_app(server.app, host=config.host, port=config.port)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.command == "serve":
        return _serve(args)
    parser.error(f"unsupported command: {args.command}")
    return 2


__all__ = ["main"]
