#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Iterable, Sequence

DEFAULT_PORTS: tuple[int, int] = (8787, 5173)


@dataclass(frozen=True)
class TerminationSummary:
    attempted: tuple[int, ...]
    terminated: tuple[int, ...]
    forced: tuple[int, ...]
    failed: tuple[int, ...]


def parse_ports(raw_ports: str) -> tuple[int, ...]:
    ports: list[int] = []
    for part in raw_ports.split(","):
        value = part.strip()
        if not value:
            continue
        try:
            port = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(
                f"invalid port value `{value}`; expected an integer"
            ) from exc
        if port < 1 or port > 65535:
            raise argparse.ArgumentTypeError(
                f"invalid port value `{value}`; expected 1-65535"
            )
        ports.append(port)
    if not ports:
        raise argparse.ArgumentTypeError("at least one port must be provided")
    return tuple(sorted(set(ports)))


def pids_from_lsof(port: int) -> set[int] | None:
    try:
        completed = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None

    if completed.returncode not in (0, 1):
        raise RuntimeError(
            f"lsof failed while checking port {port}: {completed.stderr.strip()}"
        )
    return {
        int(line.strip())
        for line in completed.stdout.splitlines()
        if line.strip().isdigit()
    }


def pids_from_ss(port: int) -> set[int] | None:
    try:
        completed = subprocess.run(
            ["ss", "-ltnp"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None

    if completed.returncode != 0:
        raise RuntimeError(f"ss failed while checking port {port}: {completed.stderr.strip()}")

    pids: set[int] = set()
    port_pattern = re.compile(rf":{port}\b")
    pid_pattern = re.compile(r"pid=(\d+)")
    for line in completed.stdout.splitlines():
        if not port_pattern.search(line):
            continue
        match = pid_pattern.search(line)
        if match:
            pids.add(int(match.group(1)))
    return pids


def collect_listener_pids(ports: Sequence[int]) -> tuple[int, ...]:
    all_pids: set[int] = set()
    for port in ports:
        lsof_result = pids_from_lsof(port)
        if lsof_result is not None:
            all_pids.update(lsof_result)
            continue

        ss_result = pids_from_ss(port)
        if ss_result is not None:
            all_pids.update(ss_result)
            continue

        raise RuntimeError(
            "unable to inspect listening ports: neither `lsof` nor `ss` is available"
        )
    return tuple(sorted(all_pids))


def pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    process_state = read_process_state(pid)
    if process_state is not None and process_state.startswith("Z"):
        return False
    return True


def read_process_state(pid: int) -> str | None:
    try:
        completed = subprocess.run(
            ["ps", "-o", "stat=", "-p", str(pid)],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None
    if completed.returncode != 0:
        return None
    state = completed.stdout.strip()
    if not state:
        return None
    return state


def wait_for_exit(pids: Iterable[int], timeout_seconds: float) -> tuple[int, ...]:
    remaining = set(pids)
    deadline = time.monotonic() + timeout_seconds
    while remaining and time.monotonic() < deadline:
        for pid in tuple(remaining):
            if not pid_exists(pid):
                remaining.remove(pid)
        if remaining:
            time.sleep(0.05)
    return tuple(sorted(remaining))


def terminate_pids(pids: Sequence[int], timeout_seconds: float) -> TerminationSummary:
    attempted = tuple(sorted(set(pids)))
    if not attempted:
        return TerminationSummary(attempted=(), terminated=(), forced=(), failed=())

    pending: set[int] = set(attempted)
    failed: set[int] = set()

    for pid in attempted:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pending.discard(pid)
        except PermissionError:
            pending.discard(pid)
            failed.add(pid)

    pending_after_term = set(wait_for_exit(pending, timeout_seconds))
    forced: set[int] = set()
    for pid in tuple(pending_after_term):
        try:
            os.kill(pid, signal.SIGKILL)
            forced.add(pid)
        except ProcessLookupError:
            pending_after_term.discard(pid)
        except PermissionError:
            pending_after_term.discard(pid)
            failed.add(pid)

    survivors = set(wait_for_exit(pending_after_term, timeout_seconds))
    failed.update(survivors)

    terminated = set(attempted) - failed
    return TerminationSummary(
        attempted=attempted,
        terminated=tuple(sorted(terminated)),
        forced=tuple(sorted(forced)),
        failed=tuple(sorted(failed)),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Close local Lucida runtime sessions by freeing default dev ports."
    )
    parser.add_argument(
        "--ports",
        type=parse_ports,
        default=DEFAULT_PORTS,
        help="Comma-separated ports to clear (default: 8787,5173).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=2.0,
        help="Grace period before escalating to SIGKILL (default: 2.0).",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    ports: tuple[int, ...] = args.ports
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be > 0")

    try:
        pids = collect_listener_pids(ports)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not pids:
        print(f"No listening processes found on ports: {', '.join(map(str, ports))}")
        return 0

    summary = terminate_pids(pids, args.timeout_seconds)
    print(f"Ports checked: {', '.join(map(str, ports))}")
    print(f"Processes targeted: {', '.join(map(str, summary.attempted))}")
    print(f"Processes terminated: {', '.join(map(str, summary.terminated))}")
    if summary.forced:
        print(f"Processes force-killed: {', '.join(map(str, summary.forced))}")
    if summary.failed:
        print(
            "Failed to terminate: "
            + ", ".join(map(str, summary.failed)),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
