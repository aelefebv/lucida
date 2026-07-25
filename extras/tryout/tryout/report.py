"""The ``report`` capstone: one cross-surface run -> one portable report.

Slices 1-3 gave ``up`` and ``drive --surface cli|python|web|all``, each saving
raw artifacts (``server.log``, ``cli/*.log``, ``python/session.log``,
``web/viewer.png`` ...). This is the capstone the spec asks for: a *single*
command that exercises **every** surface and emits a self-contained verification
report a human opens to confirm lucida works — "the heart of screenshots and
logs saved for verification."

It does **not** re-implement the run. It reuses :func:`tryout.drive.drive`
wholesale (``--surface all``: CLI + Python + web), then consolidates that one
``DriveOutcome`` into two artifacts that sit next to the raw ones:

  * ``report.html`` — a *truly* self-contained single file: the web screenshots
    are embedded as base64 ``data:`` URIs, so the HTML opens and shares
    standalone with no sibling files needed (portability-first). A clear
    PASS/FAIL banner, per-surface sections (CLI command table with exit codes,
    Python steps, web shots inline), run metadata (lucida version, base_url,
    workspace/dataset ids), and log excerpts make it verifiable without
    re-running.
  * ``report.md`` — a Markdown mirror of the same facts (relative image links,
    since the raw PNGs sit alongside), for terminals / PR comments / diffs.

Invariants (mirroring the rest of the harness):
  * **Default output is gitignored.** With no ``--out`` we write to
    ``<repo>/.tmp/tryout/<timestamp>/`` (``.tmp/`` is gitignored) and report the
    chosen ``out_dir`` so an agent always knows where the evidence landed.
  * **The report is ALWAYS written**, even on failure (a bad fixture, a surface
    that errored) — it should *show* what failed. Exit is non-zero iff the run
    wasn't fully ok.
  * **Hermetic + always-reaped**, because the run *is* ``drive`` — same booted,
    free-port, throwaway-DB, auth-disabled server, prebuilt artifacts reused when
    offered, server reaped on every path.
"""

from __future__ import annotations

import base64
import html
import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import capture
from .drive import DriveOutcome, drive
from .server import repo_root
from .surfaces import registered_names


@dataclass(frozen=True)
class ReportOutcome:
    record: dict[str, Any]
    exit_code: int


# How many lines of a captured log we inline into the report as an excerpt. Kept
# small so the report stays scannable; the full logs sit next to it on disk.
_LOG_EXCERPT_LINES = 40


# --------------------------------------------------------------------------- #
# Output location.
# --------------------------------------------------------------------------- #

def default_out_dir(*, now: float | None = None) -> Path:
    """The default, gitignored, timestamped output dir: ``<repo>/.tmp/tryout/<ts>/``.

    ``.tmp/`` is gitignored, so an agent can just run ``report`` and know the
    evidence lands somewhere safe and discoverable (user story 2). The timestamp
    keeps successive runs from clobbering each other.
    """
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    return repo_root() / ".tmp" / "tryout" / stamp


def run_report(
    *,
    out_dir: Path | None,
    fixture: str | None,
    workspace_name: str,
    surfaces: list[str],
    health_timeout_s: float,
    open_timeout_s: float,
    server_binary: Path | None = None,
    log=print,
) -> ReportOutcome:
    """Run one full cross-surface session and consolidate it into a report.

    Reuses :func:`tryout.drive.drive` for the run (never re-implements the
    lifecycle), then always writes ``report.html`` + ``report.md`` next to the raw
    artifacts and returns the report record + exit code. Never raises outward: a
    failed run still yields a written report and a non-zero exit.
    """
    chosen_out = (out_dir if out_dir is not None else default_out_dir()).expanduser()
    chosen_out.mkdir(parents=True, exist_ok=True)
    if out_dir is None:
        log(f"[tryout] report: no --out given; writing to gitignored {chosen_out}")

    # --- the run itself: reuse drive --surface all (or the requested subset) ---
    outcome: DriveOutcome = drive(
        out_dir=chosen_out,
        fixture=fixture,
        workspace_name=workspace_name,
        surfaces=surfaces,
        health_timeout_s=health_timeout_s,
        open_timeout_s=open_timeout_s,
        server_binary=server_binary,
        log=log,
    )
    drive_record = outcome.record

    # --- enrich with run metadata the report header wants ----------------------
    versions = _collect_versions(log=log)

    # --- build + persist the consolidated report (ALWAYS, even on failure) -----
    html_path = chosen_out / "report.html"
    md_path = chosen_out / "report.md"
    summary = _summarize(drive_record)

    html_text = render_html(drive_record, summary=summary, versions=versions, out_dir=chosen_out)
    md_text = render_markdown(drive_record, summary=summary, versions=versions, out_dir=chosen_out)
    # Route the artifact writes through the one text-artifact writer (capture).
    html_written = capture.safe_write_text(html_path, html_text, log)
    md_written = capture.safe_write_text(md_path, md_text, log)

    overall_ok = bool(drive_record.get("ok"))
    record = _build_report_record(
        ok=overall_ok,
        out_dir=chosen_out,
        html_path=html_path if html_written else None,
        md_path=md_path if md_written else None,
        drive_record=drive_record,
        summary=summary,
        versions=versions,
    )
    log(
        f"[tryout] report: {'PASS' if overall_ok else 'FAIL'} -> {html_path}"
        + (f" (and {md_path.name})" if md_written else "")
    )
    return ReportOutcome(record=record, exit_code=outcome.exit_code)


# --------------------------------------------------------------------------- #
# Run metadata: lucida version / commit (best-effort; never fatal).
# --------------------------------------------------------------------------- #

def _collect_versions(*, log=print) -> dict[str, Any]:
    """Best-effort ``--version`` of the prebuilt server/CLI + repo git commit.

    Pure metadata for the report header (user story 1: "lucida commit/version if
    available"). Every probe is wrapped so a missing binary or a non-git checkout
    never breaks the report — absent facts are simply omitted.
    """
    versions: dict[str, Any] = {}
    server_bin = os.environ.get("LUCIDA_TRYOUT_SERVER_BIN")
    cli_bin = os.environ.get("LUCIDA_TRYOUT_CLI")
    if server_bin:
        v = _probe_version(server_bin)
        if v:
            versions["server"] = v
    if cli_bin:
        v = _probe_version(cli_bin)
        if v:
            versions["cli"] = v
    commit = _git_commit()
    if commit:
        versions["commit"] = commit
    return versions


def _probe_version(binary: str) -> str | None:
    try:
        result = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=15.0,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    text = (result.stdout or result.stderr or "").strip()
    return text.splitlines()[0].strip() if text else None


def _git_commit() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(repo_root()),
            capture_output=True,
            text=True,
            timeout=15.0,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return (result.stdout or "").strip() or None


# --------------------------------------------------------------------------- #
# Summarize the drive record into a small, render-friendly shape.
# --------------------------------------------------------------------------- #

def _error_message(surface: dict[str, Any]) -> str | None:
    return (surface.get("error") or {}).get("message") if surface.get("error") else None


def _summary_cli(cli: dict[str, Any]) -> dict[str, Any]:
    return {
        "ran": bool(cli.get("ran")),
        "ok": bool(cli.get("ok")),
        "passed": cli.get("passed"),
        "total": cli.get("total"),
        "error": _error_message(cli),
    }


def _summary_python(py: dict[str, Any]) -> dict[str, Any]:
    steps = py.get("steps") or []
    return {
        "ran": bool(py.get("ran")),
        "ok": bool(py.get("ok")),
        "passed": sum(1 for s in steps if s.get("ok")),
        "total": len(steps),
        "error": _error_message(py),
    }


def _summary_web(web: dict[str, Any]) -> dict[str, Any]:
    real_spa = web.get("real_spa") or {}
    gate = web.get("render_gate") or real_spa.get("gate") or {}
    return {
        "ran": bool(web.get("ran")),
        "ok": bool(web.get("ok")),
        "viewer_png_nonblank": web.get("viewer_png_nonblank"),
        "real_spa_captured": bool(real_spa.get("captured")),
        # The retina render gate, summarized next to the floor's non-blank fact.
        # ``render_gate_enforced: false`` means no browser ran the DPR 2 arm — a
        # reader must be able to tell "gate passed" from "gate never ran".
        "render_gate_enforced": bool(gate.get("gated")),
        "render_gate_ok": bool(gate.get("ok")) if gate else None,
        "scale_factors": real_spa.get("scale_factors") or [],
        "error": _error_message(web),
    }


# Per-surface summarizers, keyed by surface name. The web summary is shaped
# differently (a render is non-blank/blank, not passed/total) — that asymmetry is
# intentional, and isolating it here is what lets the report-side logic dispatch
# by name instead of branching on ``if name == "web"`` in three places. The
# *driving* of surfaces lives in the surface REGISTRY; this is the matching
# presentation table, kept in the report layer so surface drivers stay free of
# report concerns.
_SURFACE_SUMMARIZERS = {
    "cli": _summary_cli,
    "python": _summary_python,
    "web": _summary_web,
}


def _summarize(drive_record: dict[str, Any]) -> dict[str, Any]:
    """Boil the drive record down to the per-surface facts the report shows.

    Iterates the known surfaces (in registry order) and dispatches to each one's
    summarizer, so ``report.html``, ``report.md``, and the JSON object are three
    views of one summary — not three re-derivations, and no ``if name == ...``
    ladder.
    """
    surfaces = drive_record.get("surfaces") or {}
    out: dict[str, Any] = {}
    for name in registered_names():
        record = surfaces.get(name)
        summarizer = _SURFACE_SUMMARIZERS.get(name)
        if record is not None and summarizer is not None:
            out[name] = summarizer(record)
    return out


def _build_report_record(
    *,
    ok: bool,
    out_dir: Path,
    html_path: Path | None,
    md_path: Path | None,
    drive_record: dict[str, Any],
    summary: dict[str, Any],
    versions: dict[str, Any],
) -> dict[str, Any]:
    """The one JSON object ``report`` prints (and the shape an agent parses).

    Carries everything the spec names: ``ok``, ``out_dir``, ``report_html``,
    ``report_md``, a ``surfaces`` summary (cli/python/web), ``workspace_id``,
    ``dataset_id``, plus run metadata (``base_url``, versions) and a pointer back
    to the raw ``drive.json`` for the agent that wants the full detail.
    """
    record: dict[str, Any] = {
        "ok": ok,
        "out_dir": str(out_dir),
        "report_html": str(html_path) if html_path is not None else None,
        "report_md": str(md_path) if md_path is not None else None,
        "surfaces": summary,
        "workspace_id": drive_record.get("workspace_id"),
        "dataset_id": drive_record.get("dataset_id"),
        "base_url": drive_record.get("base_url"),
        "fixture": drive_record.get("fixture"),
        "teardown": drive_record.get("teardown"),
        "versions": versions,
    }
    drive_json = drive_record.get("drive_json")
    if drive_json:
        record["drive_json"] = drive_json
    error = drive_record.get("error")
    if error:
        record["error"] = error
    return record


# --------------------------------------------------------------------------- #
# Shared small helpers (artifacts on disk; image embedding).
# --------------------------------------------------------------------------- #

def _data_uri(path: Path) -> str | None:
    """A ``data:image/png;base64,...`` URI for ``path``, or None if unreadable.

    This is the portability hinge: embedding the bytes makes ``report.html`` a
    single self-contained file you can email/attach and open anywhere, with the
    screenshot still showing inline — no sibling files required.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _rel(path: str | None, out_dir: Path) -> str | None:
    """Path relative to ``out_dir`` (so HTML/MD links work when opened in place)."""
    if not path:
        return None
    try:
        return os.path.relpath(path, str(out_dir))
    except (ValueError, OSError):
        return path


def _read_excerpt(path: str | None, *, lines: int = _LOG_EXCERPT_LINES) -> str | None:
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            head = []
            for index, line in enumerate(handle):
                if index >= lines:
                    head.append("... (truncated; see full log on disk)")
                    break
                head.append(line.rstrip("\n"))
        return "\n".join(head)
    except OSError:
        return None


def _status_word(ran: bool | None, ok: bool | None) -> str:
    if not ran:
        return "DID NOT RUN"
    return "PASS" if ok else "FAIL"


# --------------------------------------------------------------------------- #
# HTML rendering (the primary, portable artifact).
# --------------------------------------------------------------------------- #

_CSS = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  margin: 0; padding: 0 0 4rem; color: #1b1f24; background: #f6f8fa;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
.banner {
  border-radius: 10px; padding: 1.1rem 1.4rem; margin: 1rem 0 1.5rem;
  display: flex; align-items: center; gap: 1rem; color: #fff;
}
.banner h1 { margin: 0; font-size: 1.5rem; letter-spacing: .01em; }
.banner .sub { opacity: .92; font-size: .95rem; }
.banner.pass { background: linear-gradient(90deg, #1a7f37, #2da44e); }
.banner.fail { background: linear-gradient(90deg, #b42318, #d1242f); }
.verdict { font-size: 2rem; font-weight: 800; line-height: 1; }
.meta { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: .25rem 1rem; margin-bottom: 1.5rem; }
.meta table { width: 100%; border-collapse: collapse; }
.meta td { padding: .35rem .5rem; border-bottom: 1px solid #eaeef2; vertical-align: top; }
.meta td.k { color: #57606a; width: 12rem; white-space: nowrap; }
.meta tr:last-child td { border-bottom: 0; }
.meta code, code.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
section.surface { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; margin-bottom: 1.4rem; overflow: hidden; }
section.surface > h2 {
  margin: 0; padding: .8rem 1.1rem; font-size: 1.15rem; border-bottom: 1px solid #d0d7de;
  display: flex; align-items: center; gap: .6rem; background: #f6f8fa;
}
section.surface .body { padding: 1rem 1.1rem; }
.pill { font-size: .78rem; font-weight: 700; padding: .12rem .6rem; border-radius: 999px; color: #fff; letter-spacing: .03em; }
.pill.pass { background: #2da44e; }
.pill.fail { background: #d1242f; }
.pill.skip { background: #6e7781; }
/* An UNENFORCED gate is not a pass and not a skip: it is the one state a reader
   must never mistake for "verified", so it gets its own colour. */
.pill.warn { background: #bf8700; }
.count { color: #57606a; font-weight: 500; font-size: .9rem; }
table.cmd { width: 100%; border-collapse: collapse; font-size: .9rem; }
table.cmd th, table.cmd td { text-align: left; padding: .4rem .55rem; border-bottom: 1px solid #eaeef2; }
table.cmd th { color: #57606a; font-weight: 600; background: #fafbfc; }
table.cmd td.argv { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .82em; color: #24292f; word-break: break-all; }
td.ok { color: #1a7f37; font-weight: 700; }
td.bad { color: #d1242f; font-weight: 700; }
.shots { display: flex; flex-wrap: wrap; gap: 1.2rem; }
.shot { flex: 1 1 420px; min-width: 320px; }
.shot figcaption { font-size: .85rem; color: #57606a; margin: .4rem 0 0; }
.shot img { width: 100%; height: auto; border: 1px solid #d0d7de; border-radius: 8px; background: #fff; display: block; }
.shot .missing { border: 1px dashed #d1242f; border-radius: 8px; padding: 2rem; text-align: center; color: #d1242f; background: #fff5f5; }
details { margin-top: .8rem; }
details > summary { cursor: pointer; color: #0969da; font-size: .9rem; }
pre.log { background: #0d1117; color: #d1d5da; padding: .8rem 1rem; border-radius: 8px; overflow-x: auto; font-size: .8rem; line-height: 1.45; margin: .5rem 0 0; }
.err { background: #fff5f5; border: 1px solid #ffc1c1; border-radius: 8px; padding: .6rem .9rem; color: #b42318; margin-top: .5rem; font-size: .9rem; }
ul.steps { list-style: none; padding: 0; margin: 0; }
ul.steps li { padding: .3rem 0; border-bottom: 1px solid #eaeef2; font-size: .9rem; display: flex; gap: .6rem; align-items: baseline; }
ul.steps li:last-child { border-bottom: 0; }
ul.steps .name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
ul.steps .mark.ok { color: #1a7f37; font-weight: 700; }
ul.steps .mark.bad { color: #d1242f; font-weight: 700; }
ul.steps .summary { color: #57606a; }
footer { color: #8b949e; font-size: .82rem; text-align: center; margin-top: 1.5rem; }
"""


def render_html(
    drive_record: dict[str, Any],
    *,
    summary: dict[str, Any],
    versions: dict[str, Any],
    out_dir: Path,
) -> str:
    """Render the self-contained ``report.html``.

    Screenshots are embedded as base64 ``data:`` URIs so the file is portable;
    the original ``web/*.png`` filename is still shown (as a caption + a link), so
    the report both *shows* the render inline and *names* the artifact on disk.
    """
    ok = bool(drive_record.get("ok"))
    surfaces = drive_record.get("surfaces") or {}
    parts: list[str] = []

    parts.append("<!doctype html>")
    parts.append('<html lang="en"><head><meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    parts.append("<title>lucida tryout report — " + ("PASS" if ok else "FAIL") + "</title>")
    parts.append("<style>" + _CSS + "</style>")
    parts.append("</head><body><div class='wrap'>")

    # --- the headline verdict (impossible to miss) ----------------------------
    parts.append(f"<div class='banner {'pass' if ok else 'fail'}'>")
    parts.append(f"<span class='verdict'>{'PASS' if ok else 'FAIL'}</span>")
    parts.append("<div>")
    parts.append("<h1>lucida tryout — cross-surface verification</h1>")
    parts.append(
        "<div class='sub'>"
        + _esc(_headline_sub(drive_record, summary))
        + "</div>"
    )
    parts.append("</div></div>")

    # --- run metadata ---------------------------------------------------------
    parts.append(_render_meta_html(drive_record, versions))

    # --- per-surface sections -------------------------------------------------
    parts.append(_render_cli_html(surfaces.get("cli")))
    parts.append(_render_python_html(surfaces.get("python")))
    parts.append(_render_web_html(surfaces.get("web"), out_dir=out_dir))

    # --- server log excerpt (shared context) ----------------------------------
    parts.append(_render_serverlog_html(drive_record))

    # --- a top-level error envelope, if the whole run failed pre-surface -------
    error = drive_record.get("error")
    if error:
        parts.append("<section class='surface'><h2>Run error</h2><div class='body'>")
        parts.append(
            "<div class='err'><strong>"
            + _esc(str(error.get("stage")))
            + "</strong>: "
            + _esc(str(error.get("message")))
            + "</div>"
        )
        parts.append("</div></section>")

    parts.append(
        "<footer>Generated by <code>tryout.py report</code> — "
        "a self-contained verification artifact (screenshots embedded inline). "
        "Raw logs and PNGs sit next to this file.</footer>"
    )
    parts.append("</div></body></html>")
    return "\n".join(parts) + "\n"


def _headline_sub(drive_record: dict[str, Any], summary: dict[str, Any]) -> str:
    bits = []
    for name in registered_names():
        surf = summary.get(name)
        if surf is None:
            continue
        bits.append(f"{name} {_status_word(surf.get('ran'), surf.get('ok'))}")
    teardown = drive_record.get("teardown")
    suffix = f" · server teardown: {teardown}" if teardown else ""
    return (" · ".join(bits) if bits else "no surfaces exercised") + suffix


def _render_meta_html(drive_record: dict[str, Any], versions: dict[str, Any]) -> str:
    rows: list[tuple[str, str]] = []

    def add(key: str, value: Any, *, mono: bool = False) -> None:
        if value is None or value == "":
            return
        cell = f"<code class='mono'>{_esc(str(value))}</code>" if mono else _esc(str(value))
        rows.append((key, cell))

    add("lucida server", versions.get("server"))
    add("lucida CLI", versions.get("cli"))
    add("git commit", versions.get("commit"), mono=True)
    add("base_url", drive_record.get("base_url"), mono=True)
    add("workspace_id", drive_record.get("workspace_id"), mono=True)
    add("dataset_id", drive_record.get("dataset_id"), mono=True)
    add("fixture", drive_record.get("fixture"), mono=True)
    add("out_dir", drive_record.get("out_dir"), mono=True)
    add("server teardown", drive_record.get("teardown"))
    elapsed = drive_record.get("elapsed_s")
    if elapsed is not None:
        add("elapsed", f"{elapsed}s")

    body = ["<div class='meta'><table>"]
    for key, cell in rows:
        body.append(f"<tr><td class='k'>{_esc(key)}</td><td>{cell}</td></tr>")
    body.append("</table></div>")
    return "\n".join(body)


def _surface_header(title: str, *, ran: bool | None, ok: bool | None, count: str | None) -> str:
    if not ran:
        pill = "<span class='pill skip'>DID NOT RUN</span>"
    elif ok:
        pill = "<span class='pill pass'>PASS</span>"
    else:
        pill = "<span class='pill fail'>FAIL</span>"
    count_html = f"<span class='count'>{_esc(count)}</span>" if count else ""
    return f"<h2>{_esc(title)} {pill} {count_html}</h2>"


def _render_cli_html(cli: dict[str, Any] | None) -> str:
    if cli is None:
        return ""
    ran = cli.get("ran")
    ok = cli.get("ok")
    passed, total = cli.get("passed"), cli.get("total")
    count = f"{passed}/{total} commands ok" if ran and total is not None else None
    out = ["<section class='surface'>", _surface_header("CLI surface", ran=ran, ok=ok, count=count)]
    out.append("<div class='body'>")
    if not ran:
        out.append(_err_html(cli.get("error"), fallback="CLI surface could not be exercised."))
    else:
        out.append("<table class='cmd'>")
        out.append("<tr><th>#</th><th>command</th><th>argv</th><th>exit</th><th>result</th></tr>")
        for index, command in enumerate(cli.get("commands") or [], start=1):
            ec = command.get("exit_code")
            cmd_ok = command.get("ok")
            argv = command.get("argv") or []
            # Trim the injected connection globals so the table reads as intent.
            shown = _trim_argv(argv)
            ec_text = "—" if ec is None else str(ec)
            if command.get("timed_out"):
                ec_text = "timeout"
            result_cls = "ok" if cmd_ok else "bad"
            result_text = "ok" if cmd_ok else "FAIL"
            out.append(
                "<tr>"
                f"<td>{index}</td>"
                f"<td><code class='mono'>{_esc(str(command.get('name')))}</code></td>"
                f"<td class='argv'>{_esc(shown)}</td>"
                f"<td class='{result_cls}'>{_esc(ec_text)}</td>"
                f"<td class='{result_cls}'>{result_text}</td>"
                "</tr>"
            )
        out.append("</table>")
    out.append("</div></section>")
    return "\n".join(out)


def _render_python_html(py: dict[str, Any] | None) -> str:
    if py is None:
        return ""
    ran = py.get("ran")
    ok = py.get("ok")
    steps = py.get("steps") or []
    passed = sum(1 for s in steps if s.get("ok"))
    count = f"{passed}/{len(steps)} steps ok" if ran else None
    out = ["<section class='surface'>", _surface_header("Python surface (LucidaClient)", ran=ran, ok=ok, count=count)]
    out.append("<div class='body'>")
    if not ran:
        out.append(_err_html(py.get("error"), fallback="Python surface could not be exercised."))
    else:
        out.append("<ul class='steps'>")
        for step in steps:
            step_ok = step.get("ok")
            mark = "ok" if step_ok else "bad"
            glyph = "PASS" if step_ok else "FAIL"
            opt = " <span class='count'>(optional)</span>" if step.get("optional") else ""
            detail = ""
            if step_ok and step.get("summary") is not None:
                detail = f"<span class='summary'>{_esc(_compact_json(step.get('summary')))}</span>"
            elif not step_ok and step.get("error"):
                msg = (step.get("error") or {}).get("message") or _compact_json(step.get("error"))
                detail = f"<span class='summary'>{_esc(str(msg))}</span>"
            out.append(
                "<li>"
                f"<span class='mark {mark}'>{glyph}</span>"
                f"<span class='name'>{_esc(str(step.get('name')))}</span>{opt}"
                f"{detail}"
                "</li>"
            )
        out.append("</ul>")
        log_excerpt = _read_excerpt(py.get("log"))
        if log_excerpt:
            out.append(
                "<details><summary>session transcript excerpt</summary>"
                f"<pre class='log'>{_esc(log_excerpt)}</pre></details>"
            )
    out.append("</div></section>")
    return "\n".join(out)


def _render_web_html(web: dict[str, Any] | None, *, out_dir: Path) -> str:
    if web is None:
        return ""
    ran = web.get("ran")
    ok = web.get("ok")
    nonblank = web.get("viewer_png_nonblank")
    count = ("viewer render: non-blank" if nonblank else "viewer render: BLANK/missing") if ran else None
    out = ["<section class='surface'>", _surface_header("Web surface (rendered viewer)", ran=ran, ok=ok, count=count)]
    out.append("<div class='body'>")
    if not ran:
        out.append(_err_html(web.get("error"), fallback="Web surface could not be exercised."))
        out.append("</div></section>")
        return "\n".join(out)

    url = web.get("viewer_url")
    if url:
        out.append(
            f"<p class='count'>Re-open this exact view: "
            f"<a href='{_esc(url)}'><code class='mono'>{_esc(url)}</code></a></p>"
        )

    # The screenshots — embedded inline (portable) but each labelled with its
    # real ``web/*.png`` filename so the artifact on disk is named, not hidden.
    out.append("<div class='shots'>")
    out.append(_shot_html(web.get("viewer_png"), out_dir=out_dir,
                          title="Floor — product viewer", required=True,
                          nonblank=web.get("viewer_png_nonblank")))
    # The fit-overview capture, if present in captures.
    overview = _find_capture(web.get("captures"), "overview")
    if overview is not None:
        out.append(_shot_html(overview.get("png"), out_dir=out_dir,
                              title="Overview — fit-to-dataset", required=False,
                              nonblank=overview.get("nonblank")))
    # The ceiling is a matrix: one arm per deviceScaleFactor. Show every arm's
    # page shot, and — only when the gate FAILED — the exact canvas crop that was
    # judged, so the evidence for a failure is the image the verdict came from.
    real_spa = web.get("real_spa") or {}
    arms = real_spa.get("arms") or []
    for arm in arms:
        title = _arm_title(arm)
        if arm.get("spa_png"):
            # Deliberately no non-blank pill: the PAGE is richly coloured even
            # when the viewer is dead, and saying "non-blank" here would repeat
            # the exact mistake the gate exists to correct.
            out.append(_shot_html(arm.get("spa_png"), out_dir=out_dir,
                                  title=title, required=False, nonblank=None))
        if arm.get("gating") and not arm.get("ok") and arm.get("canvas_png"):
            out.append(_shot_html(
                arm.get("canvas_png"), out_dir=out_dir,
                title=f"Retina gate — the judged canvas "
                      f"(deviceScaleFactor {arm.get('device_scale_factor')}); its centre is what failed",
                required=False, nonblank=None))
    out.append("</div>")

    out.append(_render_gate_html(web))
    if not real_spa.get("captured"):
        out.append(
            "<p class='count'>Real-SPA ceiling skipped (floor still verified): "
            f"{_esc(str(real_spa.get('reason') or 'not attempted'))}</p>"
        )
    out.append("</div></section>")
    return "\n".join(out)


def _arm_title(arm: dict[str, Any]) -> str:
    """One render-matrix arm's caption: which scale factor, and its verdict.

    The verdict goes in the title rather than a "non-blank" pill because the
    full-page image IS non-blank on a dead viewer — labelling it that way is the
    false confidence the gate exists to remove.
    """
    dsf = arm.get("device_scale_factor")
    gates = " (gates)" if arm.get("gating") else ""
    if not arm.get("ran"):
        verdict = "did not run"
    else:
        verdict = "content frame presented" if arm.get("ok") else "NO CONTENT FRAME"
    return f"Ceiling — real SPA at deviceScaleFactor {dsf}{gates}: {verdict}"


def _render_gate_html(web: dict[str, Any]) -> str:
    """The retina render gate's verdict, stated in words.

    Three distinct states, never collapsed: enforced+pass, enforced+fail, and
    *not enforced* (no browser, so the DPR 2 arm never ran). The third must not
    read like the first — an unenforced gate is the false confidence this whole
    mechanism exists to prevent.
    """
    real_spa = web.get("real_spa") or {}
    gate = web.get("render_gate") or real_spa.get("gate") or {}
    if not gate:
        return ""
    dsf = gate.get("device_scale_factor", 2)
    reason = _esc(str(gate.get("reason") or ""))
    if not gate.get("gated"):
        return (
            f"<p class='count'><span class='pill warn'>gate not enforced</span> "
            f"Retina render gate (deviceScaleFactor {dsf}) did not run: {reason}</p>"
        )
    if gate.get("ok"):
        return (
            f"<p class='count'><span class='pill pass'>gate passed</span> "
            f"Retina render gate (deviceScaleFactor {dsf}): {reason}</p>"
        )
    failures = "".join(f"<li>{_esc(str(item))}</li>" for item in (gate.get("failures") or []))
    return (
        f"<p class='count'><span class='pill fail'>gate FAILED</span> "
        f"Retina render gate (deviceScaleFactor {dsf}) — the viewer did not present "
        f"a content frame at retina:</p><ul class='count'>{failures}</ul>"
    )


def _shot_html(
    png: str | None,
    *,
    out_dir: Path,
    title: str,
    required: bool,
    nonblank: Any,
) -> str:
    """One inline screenshot figure: embedded data-URI + a named ``.png`` caption.

    If the PNG is missing/unreadable we render an obvious placeholder rather than
    a broken image, so the failure is visible in the report itself.
    """
    name = Path(png).name if png else "(no file)"
    rel = _rel(png, out_dir) or name
    tag = " (required)" if required else ""
    nb = ""
    if nonblank is True:
        nb = " <span class='pill pass'>non-blank</span>"
    elif nonblank is False:
        nb = " <span class='pill fail'>blank</span>"

    uri = _data_uri(Path(png)) if png else None
    if uri is None:
        body = (
            f"<div class='missing'>screenshot not available<br>"
            f"<code class='mono'>{_esc(rel)}</code></div>"
        )
    else:
        # alt + caption both name the .png so the artifact is discoverable and the
        # report references the file even though the bytes are embedded inline.
        body = f"<img src='{uri}' alt='{_esc(name)} ({_esc(title)})'>"

    caption = (
        f"<figcaption><strong>{_esc(title)}</strong>{tag}{nb}<br>"
        f"file: <code class='mono'>{_esc(rel)}</code></figcaption>"
    )
    return f"<figure class='shot'>{body}{caption}</figure>"


def _render_serverlog_html(drive_record: dict[str, Any]) -> str:
    excerpt = _read_excerpt(drive_record.get("server_log"))
    if not excerpt:
        return ""
    server_log = drive_record.get("server_log")
    name = Path(server_log).name if server_log else "server.log"
    out = ["<section class='surface'><h2>Server log</h2><div class='body'>"]
    out.append(f"<p class='count'>First {_LOG_EXCERPT_LINES} lines of <code class='mono'>{_esc(name)}</code>:</p>")
    out.append(f"<pre class='log'>{_esc(excerpt)}</pre>")
    out.append("</div></section>")
    return "\n".join(out)


def _err_html(error: dict[str, Any] | None, *, fallback: str) -> str:
    if not error:
        return f"<div class='err'>{_esc(fallback)}</div>"
    stage = error.get("stage")
    msg = error.get("message") or fallback
    prefix = f"<strong>{_esc(str(stage))}</strong>: " if stage else ""
    return f"<div class='err'>{prefix}{_esc(str(msg))}</div>"


def _find_capture(captures: list[dict[str, Any]] | None, name: str) -> dict[str, Any] | None:
    for capture in captures or []:
        if capture.get("name") == name:
            return capture
    return None


def _esc(text: str) -> str:
    return html.escape(text, quote=True)


# --------------------------------------------------------------------------- #
# Markdown rendering (the mirror).
# --------------------------------------------------------------------------- #

def render_markdown(
    drive_record: dict[str, Any],
    *,
    summary: dict[str, Any],
    versions: dict[str, Any],
    out_dir: Path,
) -> str:
    """Render ``report.md`` — the same facts as the HTML, in Markdown.

    Images are relative links (the raw PNGs sit alongside this file), so the
    Markdown renders inline in a viewer that resolves relative paths (GitHub, an
    IDE preview) while staying readable as plain text in a terminal.
    """
    ok = bool(drive_record.get("ok"))
    surfaces = drive_record.get("surfaces") or {}
    lines: list[str] = []

    verdict = "PASS" if ok else "FAIL"
    lines.append(f"# lucida tryout report — {verdict}")
    lines.append("")
    lines.append(f"**Overall: {verdict}** — {_headline_sub(drive_record, summary)}")
    lines.append("")

    # --- run metadata ---------------------------------------------------------
    lines.append("## Run metadata")
    lines.append("")
    lines.append("| field | value |")
    lines.append("| --- | --- |")

    def row(key: str, value: Any) -> None:
        if value is None or value == "":
            return
        lines.append(f"| {key} | `{value}` |")

    row("lucida server", versions.get("server"))
    row("lucida CLI", versions.get("cli"))
    row("git commit", versions.get("commit"))
    row("base_url", drive_record.get("base_url"))
    row("workspace_id", drive_record.get("workspace_id"))
    row("dataset_id", drive_record.get("dataset_id"))
    row("fixture", drive_record.get("fixture"))
    row("out_dir", drive_record.get("out_dir"))
    row("server teardown", drive_record.get("teardown"))
    if drive_record.get("elapsed_s") is not None:
        row("elapsed", f"{drive_record.get('elapsed_s')}s")
    lines.append("")

    # --- CLI surface ----------------------------------------------------------
    cli = surfaces.get("cli")
    if cli is not None:
        passed, total = cli.get("passed"), cli.get("total")
        head = _status_word(cli.get("ran"), cli.get("ok"))
        suffix = f" ({passed}/{total} commands ok)" if cli.get("ran") and total is not None else ""
        lines.append(f"## CLI surface — {head}{suffix}")
        lines.append("")
        if not cli.get("ran"):
            lines.append(f"> {_md_error(cli.get('error'), 'CLI surface could not be exercised.')}")
        else:
            lines.append("| # | command | argv | exit | result |")
            lines.append("| --- | --- | --- | --- | --- |")
            for index, command in enumerate(cli.get("commands") or [], start=1):
                ec = command.get("exit_code")
                ec_text = "timeout" if command.get("timed_out") else ("—" if ec is None else str(ec))
                result = "ok" if command.get("ok") else "**FAIL**"
                argv = _md_code(_trim_argv(command.get("argv") or []))
                lines.append(
                    f"| {index} | `{command.get('name')}` | {argv} | {ec_text} | {result} |"
                )
        lines.append("")

    # --- Python surface -------------------------------------------------------
    py = surfaces.get("python")
    if py is not None:
        steps = py.get("steps") or []
        passed = sum(1 for s in steps if s.get("ok"))
        head = _status_word(py.get("ran"), py.get("ok"))
        suffix = f" ({passed}/{len(steps)} steps ok)" if py.get("ran") else ""
        lines.append(f"## Python surface — {head}{suffix}")
        lines.append("")
        if not py.get("ran"):
            lines.append(f"> {_md_error(py.get('error'), 'Python surface could not be exercised.')}")
        else:
            for step in steps:
                glyph = "[ok]" if step.get("ok") else "[FAIL]"
                opt = " _(optional)_" if step.get("optional") else ""
                tail = ""
                if step.get("ok") and step.get("summary") is not None:
                    tail = " — " + _md_code(_compact_json(step.get("summary")))
                elif not step.get("ok") and step.get("error"):
                    msg = (step.get("error") or {}).get("message") or _compact_json(step.get("error"))
                    tail = " — " + str(msg)
                lines.append(f"- {glyph} `{step.get('name')}`{opt}{tail}")
        lines.append("")

    # --- Web surface ----------------------------------------------------------
    web = surfaces.get("web")
    if web is not None:
        head = _status_word(web.get("ran"), web.get("ok"))
        nb = web.get("viewer_png_nonblank")
        suffix = ""
        if web.get("ran"):
            suffix = " (viewer non-blank)" if nb else " (viewer BLANK/missing)"
        lines.append(f"## Web surface — {head}{suffix}")
        lines.append("")
        if not web.get("ran"):
            lines.append(f"> {_md_error(web.get('error'), 'Web surface could not be exercised.')}")
        else:
            url = web.get("viewer_url")
            if url:
                lines.append(f"Re-open this exact view: <{url}>")
                lines.append("")
            lines.append(_md_shot(web.get("viewer_png"), out_dir, "Floor — product viewer (required)",
                                  web.get("viewer_png_nonblank")))
            overview = _find_capture(web.get("captures"), "overview")
            if overview is not None:
                lines.append(_md_shot(overview.get("png"), out_dir, "Overview — fit-to-dataset",
                                      overview.get("nonblank")))
            real_spa = web.get("real_spa") or {}
            for arm in (real_spa.get("arms") or []):
                if arm.get("spa_png"):
                    lines.append(_md_shot(arm.get("spa_png"), out_dir, _arm_title(arm), None))
                if arm.get("gating") and not arm.get("ok") and arm.get("canvas_png"):
                    lines.append(_md_shot(
                        arm.get("canvas_png"), out_dir,
                        f"Retina gate — the judged canvas (deviceScaleFactor "
                        f"{arm.get('device_scale_factor')}); its centre is what failed",
                        None,
                    ))
            lines.extend(_render_gate_md(web))
            if not real_spa.get("captured"):
                lines.append("")
                lines.append(
                    f"_Real-SPA ceiling skipped (floor still verified): "
                    f"{real_spa.get('reason') or 'not attempted'}_"
                )
        lines.append("")

    # --- a top-level error envelope -------------------------------------------
    error = drive_record.get("error")
    if error:
        lines.append("## Run error")
        lines.append("")
        lines.append(f"> **{error.get('stage')}**: {error.get('message')}")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(
        "_Generated by `tryout.py report`. The HTML report embeds screenshots "
        "inline (self-contained); this Markdown links the raw PNGs that sit next "
        "to it. Full per-command logs are under `cli/`, `python/`, `web/`._"
    )
    lines.append("")
    return "\n".join(lines)


def _render_gate_md(web: dict[str, Any]) -> list[str]:
    """The retina render gate's verdict in Markdown. Mirrors :func:`_render_gate_html`."""
    real_spa = web.get("real_spa") or {}
    gate = web.get("render_gate") or real_spa.get("gate") or {}
    if not gate:
        return []
    dsf = gate.get("device_scale_factor", 2)
    reason = str(gate.get("reason") or "")
    if not gate.get("gated"):
        return ["", f"> **Retina render gate (deviceScaleFactor {dsf}) NOT enforced** — {reason}"]
    if gate.get("ok"):
        return ["", f"**Retina render gate (deviceScaleFactor {dsf}): PASS** — {reason}"]
    lines = [
        "",
        f"**Retina render gate (deviceScaleFactor {dsf}): FAIL** — the viewer did not "
        "present a content frame at retina:",
        "",
    ]
    lines.extend(f"- {item}" for item in (gate.get("failures") or []))
    return lines


def _md_shot(png: str | None, out_dir: Path, title: str, nonblank: Any) -> str:
    rel = _rel(png, out_dir) if png else None
    name = Path(png).name if png else "(no file)"
    tag = ""
    if nonblank is True:
        tag = " — non-blank"
    elif nonblank is False:
        tag = " — **blank**"
    if rel is None:
        return f"**{title}**{tag}: _screenshot not available_"
    # Markdown image (renders inline where relative paths resolve) + a plain link
    # so the file is named and clickable even in a raw text view.
    return (
        f"**{title}**{tag} (`{name}`):\n\n"
        f"![{title}]({rel})\n"
    )


def _md_error(error: dict[str, Any] | None, fallback: str) -> str:
    if not error:
        return fallback
    stage = error.get("stage")
    msg = error.get("message") or fallback
    return f"**{stage}**: {msg}" if stage else str(msg)


def _md_code(text: str) -> str:
    """Inline-code a value for a Markdown table cell (escape pipes/backticks)."""
    safe = text.replace("`", "'").replace("|", "\\|")
    return f"`{safe}`"


# --------------------------------------------------------------------------- #
# Shared argv / json formatting.
# --------------------------------------------------------------------------- #

def _trim_argv(argv: list[str]) -> str:
    """Drop the injected connection globals so a command reads as intent.

    The CLI surface prepends ``<binary> --server URL --workspace ID [--json]``;
    showing all of that in every row is noise. We strip the leading binary +
    ``--server``/``--workspace`` pairs and keep the meaningful tail (the
    subcommand and its args), which is what a reader actually wants to see.
    """
    if not argv:
        return ""
    rest = list(argv[1:])  # drop the binary / cargo prefix's first token
    # The prefix may be multi-token for `cargo run -p lucida-cli --`; strip up to
    # and including a lone `--` if present.
    if "--" in rest:
        cut = rest.index("--")
        # Only treat it as the cargo separator if it's near the front.
        if cut <= 4:
            rest = rest[cut + 1:]
    cleaned: list[str] = []
    skip = 0
    for token in rest:
        if skip:
            skip -= 1
            continue
        if token in ("--server", "--workspace"):
            skip = 1  # also skip its value
            continue
        if token == "--json":
            continue
        cleaned.append(token)
    return " ".join(cleaned) if cleaned else " ".join(rest)


def _compact_json(value: Any) -> str:
    try:
        return json.dumps(value, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError):
        return str(value)
