"""Browser driver: run a scenario's declarative UI program in a real browser.

A scenario does not hold a live Playwright object — in this repo Playwright is
driven from Node (the web surface ships a Node ``.cjs`` driver), so to keep "the
framework owns the browser; the scenario is pure steps" we drive the SPA with a
*single generic Node Playwright driver* that executes a declarative **UI
program**: an ordered list of testid-driven actions (wait/click/type/focus) and
named ``shot`` captures. The scenario supplies the program (a list of
:class:`UiStep`); the framework launches/teardowns the browser and runs it.

This reuses the slice-3 web-surface launch config verbatim so the scenario sees
exactly the browser the rest of the harness uses:

  * **system Chrome** (``executablePath``) — no browser download;
  * ``--enable-unsafe-webgpu --ignore-gpu-blocklist`` so the WebGPU viewer
    renders;
  * ``NODE_PATH`` pointed at the harness-owned Playwright cache so
    ``require('playwright')`` resolves regardless of cwd;
  * an ``addInitScript`` hook that runs BEFORE any page script — used here to pin
    ``localStorage`` (e.g. the annotation author identity) so the SPA reads the
    seeded identity on first load.

Every action is driven by ``data-testid`` (or an explicit Playwright selector /
``getByPlaceholder``), never the canvas, so captures are content-bearing and the
program is readable. The driver is resilient: any failure prints one JSON object
with the per-step trace and exits, so the Python side always gets a structured
reason and whatever shots were taken survive.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Sequence

from ..browser_launch import headless_webgpu_browser_args
from ..errors import TryoutError
from ..surfaces._subproc import run_group, scan_json_line
from ..surfaces.web_surface import (
    capture_real_spa,
    _ensure_playwright,
    _system_browser_path,
)


# Hard ceiling for the whole UI program (launch + navigate + every step). The
# backstop against an orphaned browser; run_group SIGKILLs the whole group.
DEFAULT_PROGRAM_TIMEOUT_S = 240.0
# Per-step wait budget (e.g. waitForTestId) inside the driver, ms.
DEFAULT_STEP_WAIT_MS = 30_000
# How long to wait for the SPA shell to be ready after goto, ms.
DEFAULT_LOAD_WAIT_MS = 60_000
DEFAULT_VIEWPORT_W = 1400
DEFAULT_VIEWPORT_H = 900


@dataclass(frozen=True)
class UiStep:
    """One declarative UI action in a scenario's program.

    ``action`` names what to do; the remaining fields are its parameters (only
    the relevant ones are used per action). The supported actions:

      * ``wait_testid``   — wait for ``data-testid=<testid>`` to be visible.
      * ``click_testid``  — wait for + click ``data-testid=<testid>``.
      * ``click_row_with_text`` — among elements matching ``testid`` (exact) or
        ``testid_prefix`` (a ``data-testid^=`` prefix, for dynamic per-row ids
        like ``mention-of-me-item-<commentId>``), click the first whose visible
        text contains ``text`` — used to open a specific mention thread, not a
        toggle. If ``text`` is omitted, clicks the first matching row.
      * ``focus_placeholder`` — focus the input/textarea whose placeholder
        matches ``text`` (case-insensitive regex), e.g. the thread composer.
      * ``type``          — type ``text`` into the currently focused element.
      * ``wait_selector`` — wait for an arbitrary Playwright ``selector``.
      * ``shot``          — capture the page to ``<shots_dir>/<name>.png``.
      * ``sleep``         — pause ``ms`` (use sparingly; prefer waits).
    """

    action: str
    testid: str | None = None
    testid_prefix: str | None = None
    text: str | None = None
    selector: str | None = None
    name: str | None = None
    ms: int | None = None
    full_page: bool = False
    required: bool = True

    def to_request(self) -> dict[str, Any]:
        request: dict[str, Any] = {"action": self.action, "required": self.required}
        for key in ("testid", "testid_prefix", "text", "selector", "name", "ms"):
            value = getattr(self, key)
            if value is not None:
                request[key] = value
        if self.full_page:
            request["full_page"] = True
        return request


@dataclass
class StepOutcome:
    action: str
    ok: bool
    detail: str = ""
    name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        record = {"action": self.action, "ok": self.ok, "detail": self.detail}
        if self.name is not None:
            record["name"] = self.name
        return record


@dataclass
class DriveOutcome:
    """The result of running a UI program in the browser."""

    ran: bool
    reason: str
    steps: list[StepOutcome] = field(default_factory=list)
    shots_taken: list[str] = field(default_factory=list)
    console_messages: int | None = None
    console_log: str | None = None
    driver_log: str | None = None
    render_matrix: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "ran": self.ran,
            "reason": self.reason,
            "steps": [step.to_dict() for step in self.steps],
            "shots_taken": list(self.shots_taken),
        }
        if self.console_messages is not None:
            record["console_messages"] = self.console_messages
        if self.console_log is not None:
            record["console_log"] = self.console_log
        if self.driver_log is not None:
            record["driver_log"] = self.driver_log
        if self.render_matrix is not None:
            record["render_matrix"] = self.render_matrix
        return record


# The generic Node Playwright driver. It launches system Chrome with the
# WebGPU flags (matching the web surface), installs the addInitScript hooks
# BEFORE any navigation (so localStorage pins are present on first load), opens
# the URL, then executes the declarative step program. Every step's outcome is
# recorded; a required step that fails stops the program but the result (and any
# shots already taken) is always emitted as one JSON line.
_UI_DRIVER = r'''
'use strict';
const fs = require('fs');

function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch (e1) {
  try { ({ chromium } = require('@playwright/test')); }
  catch (e2) {
    out({ ran: false, reason: 'playwright_not_resolvable: ' + String(e2).split('\n')[0], steps: [], shots_taken: [] });
    process.exit(0);
  }
}

const req = JSON.parse(process.argv[2]);
const url = req.url;
const exe = req.executable_path || undefined;
const width = req.width || 1400;
const height = req.height || 900;
const deviceScaleFactor = req.device_scale_factor;
const shotsDir = req.shots_dir;
const consoleLog = req.console_log;
const initScripts = req.init_scripts || [];
const steps = req.steps || [];
const stepWaitMs = req.step_wait_ms || 30000;
const loadWaitMs = req.load_wait_ms || 60000;

function tid(id) { return '[data-testid="' + id + '"]'; }
function tidPrefix(p) { return '[data-testid^="' + p + '"]'; }
function rowSelector(step) {
  return step.testid_prefix ? tidPrefix(step.testid_prefix) : tid(step.testid);
}

async function runStep(page, step, shotsTaken) {
  const action = step.action;
  if (action === 'wait_testid') {
    await page.locator(tid(step.testid)).first().waitFor({ state: 'visible', timeout: stepWaitMs });
    return 'visible: ' + step.testid;
  }
  if (action === 'wait_testid_prefix') {
    await page.locator(tidPrefix(step.testid_prefix)).first().waitFor({ state: 'visible', timeout: stepWaitMs });
    return 'visible prefix: ' + step.testid_prefix;
  }
  if (action === 'click_testid') {
    const loc = page.locator(tid(step.testid)).first();
    await loc.waitFor({ state: 'visible', timeout: stepWaitMs });
    await loc.click();
    return 'clicked: ' + step.testid;
  }
  if (action === 'click_row_with_text') {
    // Among elements matching the testid (exact) or testid_prefix (dynamic
    // per-row ids), pick the first whose text contains the target string. With
    // no text, click the first matching row.
    const sel = rowSelector(step);
    const rows = page.locator(sel);
    await rows.first().waitFor({ state: 'visible', timeout: stepWaitMs });
    if (!step.text) {
      await rows.first().click();
      return 'clicked first row: ' + sel;
    }
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      let txt = '';
      try { txt = (await row.innerText()) || ''; } catch (_) { txt = ''; }
      if (txt.indexOf(step.text) !== -1) {
        await row.click();
        return 'clicked row[' + i + '] (' + sel + ') containing: ' + step.text;
      }
    }
    // Fallback: Playwright's text filter (handles split text nodes).
    const filtered = page.locator(sel).filter({ hasText: step.text }).first();
    await filtered.waitFor({ state: 'visible', timeout: stepWaitMs });
    await filtered.click();
    return 'clicked filtered row (' + sel + ') containing: ' + step.text;
  }
  if (action === 'focus_placeholder') {
    const re = new RegExp(step.text, 'i');
    const loc = page.getByPlaceholder(re).first();
    await loc.waitFor({ state: 'visible', timeout: stepWaitMs });
    await loc.click();
    await loc.focus();
    return 'focused placeholder ~ ' + step.text;
  }
  if (action === 'type') {
    await page.keyboard.type(step.text, { delay: 40 });
    return 'typed: ' + JSON.stringify(step.text);
  }
  if (action === 'wait_selector') {
    await page.locator(step.selector).first().waitFor({ state: 'visible', timeout: stepWaitMs });
    return 'visible selector: ' + step.selector;
  }
  if (action === 'shot') {
    const file = shotsDir + '/' + step.name + '.png';
    await page.screenshot({ path: file, fullPage: Boolean(step.full_page) });
    shotsTaken.push(step.name);
    return 'shot -> ' + step.name + '.png';
  }
  if (action === 'sleep') {
    await page.waitForTimeout(step.ms || 250);
    return 'slept ' + (step.ms || 250) + 'ms';
  }
  throw new Error('unknown action: ' + action);
}

(async () => {
  const messages = [];
  const stepResults = [];
  const shotsTaken = [];
  let browser = null;
  const browserArgs = req.browser_args;
  if (!Array.isArray(browserArgs) || browserArgs.length === 0) {
    out({ ran: false, reason: 'browser_launch_args_missing', steps: [], shots_taken: [] });
    process.exit(0);
  }
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: exe,
      args: browserArgs,
    });
  } catch (e) {
    out({ ran: false, reason: 'browser_launch_failed: ' + String(e).split('\n')[0], steps: [], shots_taken: [] });
    process.exit(0);
  }

  try {
    if (deviceScaleFactor !== 2) {
      throw new Error('scenario interaction driver must run at DPR2 after the DPR1/2 preflight');
    }
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
    // Pin localStorage (and anything else) BEFORE any page script runs.
    for (const script of initScripts) {
      await context.addInitScript(script);
    }
    const page = await context.newPage();
    page.on('console', (msg) => { try { messages.push('[' + msg.type() + '] ' + msg.text()); } catch (_) {} });
    page.on('pageerror', (err) => { messages.push('[pageerror] ' + String(err && err.message ? err.message : err)); });
    page.on('requestfailed', (rq) => { try { messages.push('[requestfailed] ' + rq.url() + ' ' + (rq.failure() && rq.failure().errorText)); } catch (_) {} });

    await page.goto(url, { waitUntil: 'load', timeout: loadWaitMs });

    let aborted = false;
    let abortReason = '';
    for (const step of steps) {
      try {
        const detail = await runStep(page, step, shotsTaken);
        stepResults.push({ action: step.action, ok: true, detail: detail || '', name: step.name || null });
      } catch (e) {
        const detail = String(e && e.message ? e.message : e).split('\n')[0];
        stepResults.push({ action: step.action, ok: false, detail: detail, name: step.name || null });
        if (step.required !== false) {
          aborted = true;
          abortReason = 'step_failed[' + step.action + (step.testid ? ' ' + step.testid : '') + ']: ' + detail;
          break;
        }
      }
    }

    try { fs.writeFileSync(consoleLog, messages.join('\n') + '\n'); } catch (_) {}

    out({
      ran: !aborted,
      reason: aborted ? abortReason : 'completed',
      steps: stepResults,
      shots_taken: shotsTaken,
      console_messages: messages.length,
      url,
    });
  } catch (e) {
    try { fs.writeFileSync(consoleLog, messages.join('\n') + '\n'); } catch (_) {}
    out({
      ran: false,
      reason: 'program_failed: ' + String(e && e.message ? e.message : e).split('\n')[0],
      steps: stepResults,
      shots_taken: shotsTaken,
      console_messages: messages.length,
    });
  } finally {
    try { await browser.close(); } catch (_) {}
  }
  process.exit(0);
})();
'''


def drive_ui_program(
    *,
    url: str,
    shots_dir: Path,
    steps: Sequence[UiStep],
    init_scripts: Sequence[str],
    work_dir: Path,
    viewport: tuple[int, int] = (DEFAULT_VIEWPORT_W, DEFAULT_VIEWPORT_H),
    program_timeout_s: float = DEFAULT_PROGRAM_TIMEOUT_S,
    step_wait_ms: int = DEFAULT_STEP_WAIT_MS,
    load_wait_ms: int = DEFAULT_LOAD_WAIT_MS,
    log=print,
) -> DriveOutcome:
    """Launch system Chrome via Playwright and run the declarative UI program.

    Reuses the web surface's Playwright provisioning + system-Chrome resolution so
    the scenario rides the identical launch config. Never raises for a UI step
    failure (those are captured in the per-step trace); raises
    :class:`TryoutError` (stage ``browser``) only if the browser/Playwright could
    not be provisioned at all, so the scenario can record a clean error and still
    write whatever shots exist.

    The driver runs in its OWN process group via ``run_group`` and has a hard
    timeout, so a stuck browser is SIGKILLed with all its children — no orphan
    survives a run.
    """
    shots_dir.mkdir(parents=True, exist_ok=True)
    console_log = work_dir / "ui-console.log"
    driver_log = work_dir / "ui-driver.log"

    # Every interactive scenario first proves that the same production URL can
    # present real canvas pixels at DPR1 and DPR2. The program itself then runs
    # at the stricter DPR2; we do not replay mutating UI steps in a second
    # browser and accidentally duplicate comments/saved views.
    render_matrix = capture_real_spa(
        url=url,
        web_out=work_dir / "render-matrix",
        log=log,
    )
    if not render_matrix.ok:
        return DriveOutcome(
            ran=False,
            reason=f"DPR1/2 render preflight failed: {render_matrix.reason}",
            render_matrix=render_matrix.to_dict(),
        )

    node = shutil.which("node")
    if node is None:
        raise TryoutError(
            "browser",
            "node not found on PATH; the scenario UI driver needs Node + Playwright",
        )

    # Reuse the web surface's provisioning (harness cache / NODE_PATH / npm) and
    # its system-Chrome resolution, so the scenario uses the same browser.
    node_path = _ensure_playwright(log=log)
    browser_path = _system_browser_path()
    if browser_path is None:
        raise TryoutError(
            "browser",
            "no Chrome/Chromium found (set LUCIDA_BROWSER) for the scenario UI driver",
        )

    request = json.dumps(
        {
            "url": url,
            "executable_path": browser_path,
            "browser_args": headless_webgpu_browser_args(),
            "width": viewport[0],
            "height": viewport[1],
            "device_scale_factor": 2,
            "shots_dir": str(shots_dir),
            "console_log": str(console_log),
            "init_scripts": list(init_scripts),
            "steps": [step.to_request() for step in steps],
            "step_wait_ms": step_wait_ms,
            "load_wait_ms": load_wait_ms,
        }
    )

    env = dict(os.environ)
    existing_node_path = env.get("NODE_PATH")
    env["NODE_PATH"] = (
        f"{node_path}{os.pathsep}{existing_node_path}" if existing_node_path else str(node_path)
    )
    env.setdefault("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")

    driver_path = work_dir / "ui-driver.cjs"
    _write_text(driver_path, _UI_DRIVER)
    argv = [node, str(driver_path), request]

    log(f"[tryout] scenario UI: driving the SPA via Playwright (system Chrome) at {url}")
    started = time.monotonic()
    try:
        completed = run_group(
            argv,
            cwd=str(work_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=program_timeout_s,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        returncode: int | None = completed.returncode
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else (error.stdout or "")
        stderr = (
            (error.stderr.decode() if isinstance(error.stderr, bytes) else (error.stderr or ""))
            + f"\n[tryout] UI program timed out after {program_timeout_s:g}s"
        )
        _write_text(driver_log, _driver_log_text(argv, stdout, stderr, None))
        # The whole process group was SIGKILLed by run_group; report a clean
        # not-ran with whatever shots already landed.
        return DriveOutcome(
            ran=False,
            reason=f"UI program timed out after {program_timeout_s:g}s",
            console_log=str(console_log) if console_log.is_file() else None,
            driver_log=str(driver_log),
            shots_taken=_existing_shot_names(shots_dir, steps),
            render_matrix=render_matrix.to_dict(),
        )

    duration = round(time.monotonic() - started, 3)
    _write_text(driver_log, _driver_log_text(argv, stdout, stderr, returncode))

    payload = scan_json_line(stdout, accept=lambda candidate: "ran" in candidate)
    if payload is None:
        reason = (
            f"UI driver produced no result (exit {returncode}); "
            + (("stderr: " + "\n".join(stderr.splitlines()[-6:])) if stderr.strip() else "no stderr")
        )
        return DriveOutcome(
            ran=False,
            reason=reason,
            console_log=str(console_log) if console_log.is_file() else None,
            driver_log=str(driver_log),
            shots_taken=_existing_shot_names(shots_dir, steps),
            render_matrix=render_matrix.to_dict(),
        )

    steps_out = [
        StepOutcome(
            action=str(step.get("action")),
            ok=bool(step.get("ok")),
            detail=str(step.get("detail") or ""),
            name=step.get("name"),
        )
        for step in (payload.get("steps") or [])
    ]
    log(
        f"[tryout]   scenario UI: {payload.get('reason')} "
        f"({sum(1 for s in steps_out if s.ok)}/{len(steps_out)} steps ok, {duration:g}s)"
    )
    return DriveOutcome(
        ran=bool(payload.get("ran")),
        reason=str(payload.get("reason") or ""),
        steps=steps_out,
        shots_taken=list(payload.get("shots_taken") or []),
        console_messages=payload.get("console_messages"),
        console_log=str(console_log) if console_log.is_file() else None,
        driver_log=str(driver_log),
        render_matrix=render_matrix.to_dict(),
    )


def _existing_shot_names(shots_dir: Path, steps: Sequence[UiStep]) -> list[str]:
    """Shot names whose PNG actually exists (for the timeout/no-result paths)."""
    names: list[str] = []
    for step in steps:
        if step.action == "shot" and step.name:
            if (shots_dir / f"{step.name}.png").is_file():
                names.append(step.name)
    return names


def _driver_log_text(argv: Sequence[str], stdout: str, stderr: str, returncode: int | None) -> str:
    return "\n".join(
        [
            "# lucida scenario UI (Playwright) driver log",
            f"# exit_code: {returncode}",
            "$ node ui-driver.cjs <request>",
            "",
            "--- stdout ---",
            stdout.rstrip("\n"),
            "",
            "--- stderr ---",
            stderr.rstrip("\n"),
            "",
        ]
    )


def _write_text(path: Path, text: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    except OSError:
        pass
