#!/usr/bin/env python3
"""Check drift between skill matrix and implemented CLI/routes."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import click
from typer.main import get_command

ROUTE_RE = re.compile(r"\.route\(\"(?P<path>/[^\"]+)\",\s*(?P<method>get|post)\(")


@dataclass(frozen=True)
class DriftResult:
    ok: bool
    errors: list[str]


def _load_matrix(skill_root: Path) -> list[dict[str, object]]:
    matrix_path = skill_root / "references" / "operation-matrix.json"
    payload = json.loads(matrix_path.read_text(encoding="utf-8"))
    operations = payload.get("operations")
    if not isinstance(operations, list):
        raise ValueError("operation matrix must define operations list")
    return [item for item in operations if isinstance(item, dict)]


def _parse_cli_commands(repo_root: Path) -> set[str]:
    commands: set[str] = set()

    src_root = repo_root / "src"
    if str(src_root) not in sys.path:
        sys.path.insert(0, str(src_root))

    from lucida.cli import app as cli_app

    root = get_command(cli_app)
    for group_name, group_command in root.commands.items():
        group_path = group_name
        if isinstance(group_command, click.Group) and group_command.callback is not None:
            commands.add(group_path)
        if isinstance(group_command, click.Group):
            commands.update(_walk_group_commands(group_command, prefix=group_path))
        else:
            commands.add(group_path)
    return commands


def _walk_group_commands(group: click.Group, *, prefix: str) -> set[str]:
    commands: set[str] = set()
    for command_name, command in group.commands.items():
        command_path = f"{prefix}.{command_name}"
        if isinstance(command, click.Group) and command.callback is not None:
            commands.add(command_path)
        if isinstance(command, click.Group):
            commands.update(_walk_group_commands(command, prefix=command_path))
        else:
            commands.add(command_path)
    return commands


def _parse_routes(lib_rs_path: Path) -> set[tuple[str, str]]:
    routes: set[tuple[str, str]] = set()
    content = lib_rs_path.read_text(encoding="utf-8")
    for match in ROUTE_RE.finditer(content):
        method = match.group("method").upper()
        path = match.group("path")
        routes.add((method, path))
    return routes


def check_drift(repo_root: Path, skill_root: Path) -> DriftResult:
    errors: list[str] = []

    operations = _load_matrix(skill_root)
    matrix_cli_commands: set[str] = set()
    matrix_routes: set[tuple[str, str]] = set()

    for operation in operations:
        op_id = str(operation.get("id", "<unknown>"))
        cli_command = str(operation.get("cli_command", ""))
        http_method = str(operation.get("http_method", "")).upper()
        http_path = str(operation.get("http_path", ""))

        if not cli_command:
            errors.append(f"{op_id}: missing cli_command in matrix")
        else:
            matrix_cli_commands.add(cli_command)

        if not http_method or not http_path:
            errors.append(f"{op_id}: missing http_method/http_path in matrix")
        else:
            matrix_routes.add((http_method, http_path))

    cli_path = repo_root / "src" / "lucida" / "cli.py"
    lib_rs_path = repo_root / "crates" / "lucida-daemon" / "src" / "lib.rs"

    if not cli_path.exists():
        errors.append(f"Missing CLI source file: {cli_path}")
        return DriftResult(ok=False, errors=errors)
    if not lib_rs_path.exists():
        errors.append(f"Missing daemon route file: {lib_rs_path}")
        return DriftResult(ok=False, errors=errors)

    actual_cli_commands = _parse_cli_commands(repo_root)
    actual_routes = _parse_routes(lib_rs_path)

    expected_surface_groups = {
        command.split(".", 1)[0]
        for command in matrix_cli_commands
        if "." in command
    }
    actual_runtime_commands = {
        command
        for command in actual_cli_commands
        if command.split(".", 1)[0] in expected_surface_groups
    }

    stale_in_matrix = sorted(matrix_cli_commands - actual_runtime_commands)

    if stale_in_matrix:
        errors.append(
            "Matrix references unknown CLI commands: " + ", ".join(stale_in_matrix)
        )

    for route in sorted(matrix_routes):
        if route not in actual_routes:
            method, path = route
            errors.append(f"Matrix route not implemented: {method} {path}")

    return DriftResult(ok=not errors, errors=errors)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check Lucida skill drift against implementation.")
    parser.add_argument("--skill", type=Path, required=True, help="Path to skill root.")
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="Repository root path.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    result = check_drift(repo_root=args.repo_root.resolve(), skill_root=args.skill.resolve())
    if result.ok:
        print("skill drift check passed")
        return 0

    print("skill drift check failed")
    for error in result.errors:
        print(f"- {error}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
