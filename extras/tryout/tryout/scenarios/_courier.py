"""The ``--email`` step: bundle a scenario's shots + summary, hand to courier.

After a scenario runs, ``--email`` packages the captured screenshots and a short
text summary into an email via **courier** (the local Gmail-sending skill). Two
hard safety rules:

  * **Dry-run by default.** Without ``--email-send`` we build + preview the
    message only (``courier send --dry-run``), which lists the attachments and
    the body but connects to nothing and reads no secret. A run never
    surprise-sends mail; sending is opt-in.
  * **Courier-absent is not a failure.** If courier can't be located, we record
    ``{attempted: true, emailed: false, reason: ...}`` and the scenario's verdict
    is unaffected — the shots are still on disk.

Courier is located via ``LUCIDA_TRYOUT_COURIER`` (a path to ``courier.py``) or,
failing that, the installed skill on ``PATH``. We invoke it through ``run_group``
so even courier's subprocess is reaped with the harness.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..surfaces._subproc import run_group, shquote


# Wall-clock ceiling for the courier invocation. A dry-run is instant; a real
# send opens SMTP, so allow generously but never hang.
DEFAULT_COURIER_TIMEOUT_S = 120.0


@dataclass
class EmailResult:
    """The outcome of the optional email step (always present under ``--email``)."""

    attempted: bool
    dry_run: bool
    sent: bool
    attachments: list[str] = field(default_factory=list)
    reason: str | None = None
    subject: str | None = None
    courier: str | None = None
    log: str | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "attempted": self.attempted,
            "dry_run": self.dry_run,
            "sent": self.sent,
            "attachments": list(self.attachments),
        }
        if self.reason is not None:
            record["reason"] = self.reason
        if self.subject is not None:
            record["subject"] = self.subject
        if self.courier is not None:
            record["courier"] = self.courier
        if self.log is not None:
            record["log"] = self.log
        return record


def not_attempted() -> EmailResult:
    """The email block when ``--email`` was not requested."""
    return EmailResult(attempted=False, dry_run=True, sent=False, reason="not requested")


def locate_courier() -> str | None:
    """Resolve the courier entrypoint.

    Honors ``LUCIDA_TRYOUT_COURIER`` (a path to ``courier.py``) first, then a
    ``courier`` executable on ``PATH``. Returns ``None`` if neither is found so
    the caller records a clean skip rather than failing.
    """
    pointed = os.environ.get("LUCIDA_TRYOUT_COURIER")
    if pointed and pointed.strip():
        candidate = Path(pointed).expanduser()
        if candidate.is_file():
            return str(candidate)
        return None
    found = shutil.which("courier")
    if found:
        return found
    return None


def _courier_argv(courier: str) -> list[str]:
    """The argv prefix to invoke courier (``python3 courier.py`` or the exe)."""
    if courier.endswith(".py"):
        return ["python3", courier]
    return [courier]


def send_email(
    *,
    scenario_name: str,
    shots: Sequence[Path],
    summary: str,
    out_dir: Path,
    send: bool,
    subject: str | None = None,
    timeout_s: float = DEFAULT_COURIER_TIMEOUT_S,
    log=print,
) -> EmailResult:
    """Bundle the shots + summary and hand them to courier.

    DRY-RUN unless ``send`` is true (``--email-send``). Returns an
    :class:`EmailResult`; a missing courier or a courier error is recorded as
    ``emailed: false`` with a reason and never raises. The attachments listed are
    the shots that actually exist on disk.
    """
    dry_run = not send
    subject = subject or f"lucida tryout: {scenario_name} scenario verification"
    existing = [shot for shot in shots if shot.is_file()]

    courier = locate_courier()
    if courier is None:
        log("[tryout] email: courier not found (set LUCIDA_TRYOUT_COURIER); skipping send")
        return EmailResult(
            attempted=True,
            dry_run=dry_run,
            sent=False,
            attachments=[str(p) for p in existing],
            reason=(
                "courier not found (set LUCIDA_TRYOUT_COURIER to courier.py or install "
                "the courier skill on PATH)"
            ),
            subject=subject,
        )

    argv = [
        *_courier_argv(courier),
        "send",
        "--subject",
        subject,
        "--body",
        summary,
    ]
    for shot in existing:
        argv += ["--attach", str(shot)]
    if dry_run:
        argv.append("--dry-run")

    log(
        f"[tryout] email: {'DRY-RUN (preview only, sending nothing)' if dry_run else 'SENDING'} "
        f"via courier with {len(existing)} attachment(s)"
    )
    log_path = out_dir / "email.log"
    try:
        completed = run_group(
            argv,
            cwd=str(out_dir),
            env=dict(os.environ),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        returncode: int | None = completed.returncode
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = (
            (error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or ""))
            + f"\n[tryout] courier timed out after {timeout_s:g}s"
        )
        _write_email_log(log_path, argv, stdout, stderr, None, dry_run)
        return EmailResult(
            attempted=True,
            dry_run=dry_run,
            sent=False,
            attachments=[str(p) for p in existing],
            reason=f"courier timed out after {timeout_s:g}s",
            subject=subject,
            courier=courier,
            log=str(log_path),
        )

    _write_email_log(log_path, argv, stdout, stderr, returncode, dry_run)

    ok = returncode == 0
    # On a dry-run, success means "preview built" (sent stays false). On a real
    # send, success means the mail went out.
    sent = bool(ok and not dry_run)
    reason: str | None
    if ok:
        reason = "previewed (dry-run, nothing sent)" if dry_run else "sent"
    else:
        tail = "\n".join((stderr or stdout or "").splitlines()[-6:])
        reason = f"courier exited {returncode}: {tail}" if tail else f"courier exited {returncode}"

    if ok and dry_run:
        log("[tryout]   email: preview built, nothing sent (use --email-send to send)")
    elif ok:
        log("[tryout]   email: sent")
    else:
        log(f"[tryout]   email: failed ({reason})")

    return EmailResult(
        attempted=True,
        dry_run=dry_run,
        sent=sent,
        attachments=[str(p) for p in existing],
        reason=reason,
        subject=subject,
        courier=courier,
        log=str(log_path),
    )


def _write_email_log(
    path: Path,
    argv: Sequence[str],
    stdout: str,
    stderr: str,
    returncode: int | None,
    dry_run: bool,
) -> None:
    lines = [
        "# lucida scenario email (courier) log",
        f"# mode: {'dry-run (nothing sent)' if dry_run else 'send'}",
        f"# exit_code: {returncode}",
        "$ " + " ".join(shquote(part) for part in argv),
        "",
        "--- stdout ---",
        stdout.rstrip("\n"),
        "",
        "--- stderr ---",
        stderr.rstrip("\n"),
        "",
    ]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass
