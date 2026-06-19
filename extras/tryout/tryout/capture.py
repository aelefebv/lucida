"""Report record shape + on-disk artifact writes — the one writer.

The harness produces machine-readable records for the human verifier (user story
2): ``DIR/server.log`` (written live by :class:`tryout.server.ServerProcess`),
``DIR/up.json`` / ``DIR/drive.json`` (the same record printed to stdout under
``--json``), and ``report.html`` / ``report.md``. This module owns BOTH the
record *shape* (:func:`build_record`, so the stdout object and the on-disk file
are identical) AND the *writes*:

  * :func:`build_record` — assemble the contract record (used by ``up`` and
    ``drive``, and by their interrupt/failure paths, so every emitted object for
    a command has the same shape).
  * :func:`write_record` — write a record as pretty, sorted JSON to
    ``DIR/<name>`` (``up.json`` / ``drive.json``); the single record writer.
  * :func:`safe_write_text` — write an arbitrary text artifact
    (``report.html`` / ``report.md``), best-effort but loud on failure; the
    single text-artifact writer.

Centralizing the writes here replaces the parallel ``_safe_write_*`` copies that
each module used to carry.
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


def write_record(out_dir: Path, name: str, record: dict[str, Any]) -> Path:
    """Write ``record`` as pretty, sorted JSON to ``DIR/<name>`` and return the path.

    The single record writer for the harness: ``up.json`` and ``drive.json`` both
    flow through here, so their on-disk JSON formatting (2-space indent, sorted
    keys, trailing newline) is defined in exactly one place and matches the stdout
    object. May raise :class:`OSError`; callers wrap it to keep writes best-effort.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / name
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def safe_write_text(path: Path, text: str, log) -> bool:
    """Write a text artifact (e.g. ``report.html`` / ``report.md``); best-effort.

    Returns ``True`` on success, ``False`` (with a warning via ``log``) on an
    :class:`OSError`, so an unwritable artifact never sinks a run that has already
    produced its result.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return True
    except OSError as error:
        log(f"[tryout] WARNING: could not write {path.name}: {error}")
        return False
