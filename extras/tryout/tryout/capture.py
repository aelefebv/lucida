"""Report assembly + on-disk artifacts.

The harness produces two artifacts for the human verifier (user story 2):
``DIR/server.log`` (written live by :class:`tryout.server.ServerProcess`) and
``DIR/up.json`` (the same record printed to stdout under ``--json``). Centralizing
the record shape here keeps the stdout object and the on-disk file identical, and
gives later slices one place to grow the report.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


# The keys the contract guarantees. Kept as a tuple so a test or a reader can
# see the promised surface at a glance, and so we can assert we never drop one.
REQUIRED_KEYS = (
    "ok",
    "base_url",
    "ws_url",
    "workspace_id",
    "out_dir",
    "server_log",
    "db_path",
    "pid",
    "fixture",
    "dataset_id",
    "healthz",
    "teardown",
)


def build_record(
    *,
    ok: bool,
    base_url: str | None,
    ws_url: str | None,
    workspace_id: str | None,
    out_dir: Path,
    server_log: Path | None,
    db_path: Path | None,
    pid: int | None,
    fixture: str | None,
    dataset_id: str | None,
    healthz: bool,
    teardown: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble the machine-readable record (also written to ``up.json``).

    ``extra`` carries optional, non-contract fields (dataset summary, health
    timing, error envelope) that enrich the report without changing the
    guaranteed keys.
    """
    record: dict[str, Any] = {
        "ok": ok,
        "base_url": base_url,
        "ws_url": ws_url,
        "workspace_id": workspace_id,
        "out_dir": str(out_dir),
        "server_log": str(server_log) if server_log is not None else None,
        "db_path": str(db_path) if db_path is not None else None,
        "pid": pid,
        "fixture": fixture,
        "dataset_id": dataset_id,
        "healthz": healthz,
        "teardown": teardown,
    }
    if extra:
        for key, value in extra.items():
            # Never let an extra field shadow a guaranteed key.
            if key not in record:
                record[key] = value
    return record


def write_up_json(out_dir: Path, record: dict[str, Any]) -> Path:
    """Write ``DIR/up.json`` and return its path. Best-effort, but loud on failure."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "up.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path
