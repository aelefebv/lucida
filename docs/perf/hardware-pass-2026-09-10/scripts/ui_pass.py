"""The monitor's UI on real hardware: headless Chrome on the L4, driven over CDP.

Runs on the GPU host beside a lucida server. Reads the workspace and the two
view fragments from run files the trace driver wrote, opens the viewer with
its chrome, and walks the surfaces the monitor redesign added: the HUD, the
phase and churn overlays, the inspector, the dock with its timeline, the
brush and its highlight, Send report, the watch toggle, compare mode, and
the wireframe boxes in volume mode. Writes a PNG per step and a JSON
summary of what the page said at each one.

The trace-reading overlays colour the rows of the open interval, and on a
small local fixture a run is open for well under a second, so those frames
are taken during a cold page load with the overlay already on: the page is
sent to about:blank and back, which empties the CPU cache, and the frame is
grabbed the moment a cell carries a row.

Usage: python3 ui_pass.py <lucida dir> <out dir>
"""

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

LUCIDA = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
SERVER = "http://127.0.0.1:9876"

summary = {"steps": [], "console": []}


def note(step, **facts):
    facts["step"] = step
    summary["steps"].append(facts)
    print(json.dumps(facts)[:700], flush=True)


def run_url(name):
    header = json.load(open(f"{LUCIDA}/gpu-pass/{name}.json"))["header"]
    url = header["composedView"]["url"]
    # The driver's URL is the chrome-free capture surface. The pass wants the chrome.
    return url.replace("?render=1", "")


def shot(chrome, name, clip=None):
    path = chrome.screenshot(f"{OUT}/{name}.png", clip)
    print("wrote", path, os.path.getsize(path), flush=True)
    return path


def dock_clip(chrome):
    return chrome.eval("(() => { const el = document.querySelector('[data-testid=\"monitor-dock\"]');"
                       " if (!el) return null; const b = el.getBoundingClientRect();"
                       " return {x: b.left, y: b.top, width: b.width, height: b.height}; })()")


def wait_quiet(chrome, seconds=25):
    """A closed run and a quiet page: progress() is null once the open's run has closed."""
    chrome.wait_for("!!window.lucidaTrace", timeout=30)
    deadline = time.time() + seconds
    while time.time() < deadline:
        if chrome.eval("window.lucidaTrace.progress() === null"):
            time.sleep(1.0)
            if chrome.eval("window.lucidaTrace.progress() === null"):
                return True
        time.sleep(0.5)
    return False


def testid_count(chrome, testid):
    return chrome.eval(f"document.querySelectorAll('[data-testid=\"{testid}\"]').length")


def text_of(chrome, testid):
    return chrome.eval(f"(document.querySelector('[data-testid=\"{testid}\"]') || {{}}).textContent || null")


def set_overlay(chrome, name, on):
    return chrome.eval(
        f"(() => {{ const box = document.querySelector('[data-testid=\"hud-legend\"] input[aria-label=\"{name}\"]');"
        f" if (!box) return 'no legend'; if (box.checked !== {str(on).lower()}) box.click(); return box.checked; }})()"
    )


def overlay_state(chrome):
    return chrome.eval("""(() => {
      const cells = [...document.querySelectorAll('[title*="·"]')].filter(n => n.style && n.style.position === 'absolute' && n.style.border);
      const withRow = cells.filter(c => !c.title.includes('no row')).length;
      const selected = document.querySelectorAll('[data-selected="true"]').length;
      const batches = [...document.querySelectorAll('[data-testid="overlay-box-batch"]')];
      const boxes = batches.reduce((n, p) => n + Number(p.dataset.count || 0), 0);
      const selectedBoxes = batches.filter(p => p.dataset.selected === 'true').reduce((n, p) => n + Number(p.dataset.count || 0), 0);
      const absence = document.querySelector('[data-testid="overlay-absence"]')?.textContent || null;
      const selection = document.querySelector('[data-testid="overlay-selection"]')?.textContent || null;
      const inspector = document.querySelector('[data-testid="overlay-inspector"]')?.textContent || null;
      return { cells: cells.length, withRow, selected, boxBatches: batches.length, boxes, selectedBoxes, absence, selection, inspector };
    })()""")


def wait_rows(chrome, timeout=6.0, boxes=False):
    """Poll until a cell (or a box) carries a row of the open interval, then return the state at once."""
    deadline = time.time() + timeout
    state = None
    while time.time() < deadline:
        state = overlay_state(chrome)
        if state and state.get("absence") is None:
            if boxes and state.get("boxes"):
                return state
            if not boxes and state.get("withRow"):
                return state
        time.sleep(0.06)
    return state


def cold_load(chrome, url, overlays):
    """Load `url` on an empty CPU cache with these overlays already on, so the load's rows are drawn."""
    chrome.goto("about:blank", settle=0.2)
    # localStorage belongs to the origin, so it is set from a page on it.
    chrome.call("Page.navigate", {"url": f"{SERVER}/"}, session=True)
    chrome.wait_for("document.readyState === 'complete'", timeout=30, every=0.05)
    if overlays:
        chrome.eval(f"localStorage.setItem('debug.overlays', {json.dumps(','.join(overlays))}); 'ok'")
    else:
        chrome.eval("localStorage.removeItem('debug.overlays'); 'ok'")
    chrome.call("Page.navigate", {"url": url}, session=True)


def first_cell_center(chrome):
    return chrome.eval("""(() => {
      const cells = [...document.querySelectorAll('[title*="·"]')].filter(n => n.style && n.style.position === 'absolute' && n.style.border);
      const withRow = cells.find(c => !c.title.includes('no row')) || cells[0];
      if (!withRow) return null;
      const b = withRow.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, title: withRow.title };
    })()""")


def first_box_point(chrome):
    return chrome.eval("""(() => {
      const path = document.querySelector('[data-testid="overlay-box-batch"]');
      if (!path) return null;
      const segs = [...(path.getAttribute('d') || '').matchAll(/M([\\d.]+) ([\\d.]+) L([\\d.]+) ([\\d.]+)/g)].slice(0, 12);
      if (!segs.length) return null;
      // The mean of a box's edge endpoints is its centre on screen, which its hull contains.
      let x = 0, y = 0;
      for (const m of segs) { x += Number(m[1]) + Number(m[3]); y += Number(m[2]) + Number(m[4]); }
      x /= segs.length * 2; y /= segs.length * 2;
      const svg = path.ownerSVGElement.getBoundingClientRect();
      return { x: svg.left + x, y: svg.top + y, edges: segs.length };
    })()""")


def timeline_drag(chrome, from_share, to_share):
    rect = chrome.eval("(() => { const c = document.querySelector('[data-testid=\"monitor-timeline-canvas\"]');"
                       " if (!c) return null; c.scrollIntoView({block: 'center'}); const b = c.getBoundingClientRect();"
                       " return {x: b.left, y: b.top, w: b.width, h: b.height}; })()")
    if not rect:
        raise RuntimeError("no timeline canvas")
    gutter = 132  # GUTTER_PX: the row titles; the plot starts after it
    plot_w = rect["w"] - gutter - 12
    y = rect["y"] + min(rect["h"] - 4, 30)
    x0 = rect["x"] + gutter + plot_w * from_share
    x1 = rect["x"] + gutter + plot_w * to_share
    under = chrome.eval(f"(() => {{ const el = document.elementFromPoint({x0}, {y}); return el ? (el.dataset.testid || el.className || el.tagName) : null; }})()")
    chrome.drag(x0, y, x1, y, steps=12)
    time.sleep(0.5)
    return {"under": under, "from": round(x0), "to": round(x1), "y": round(y)}


def open_dock(chrome, height):
    """Open the dock at `height` CSS pixels; it reads its height when it mounts."""
    chrome.eval(f"localStorage.setItem('monitor.dock.height', '{height}'); 'ok'")
    if testid_count(chrome, "monitor-dock"):
        chrome.click_testid("monitor-close")
        time.sleep(0.3)
    chrome.click_testid("open-monitor")
    chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-timeline-canvas\"], [data-testid=\"monitor-empty\"], [data-testid=\"monitor-live-counters\"]')", timeout=20)
    time.sleep(1.2)


def brush_and_note(chrome, name, to_share, shot_name):
    drag = timeline_drag(chrome, 0.04, to_share)
    time.sleep(1.2)
    state = overlay_state(chrome)
    note(name, drag=drag, brush=testid_count(chrome, "monitor-brush"),
         window=(text_of(chrome, "monitor-banner-window") or "")[:160],
         command=text_of(chrome, "monitor-brush-command"),
         published=(text_of(chrome, "monitor-brush-selection") or "")[:240], **state)
    shot(chrome, shot_name)
    return state


def main():
    chrome = Chrome(port=9333, width=1440, height=900, ratio=2)
    try:
        baseline = run_url("baseline")
        arcball = run_url("arcball")

        # --- the viewer in slice mode, quiet -----------------------------------
        cold_load(chrome, baseline, [])
        quiet = wait_quiet(chrome)
        adapter = chrome.eval("(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? {vendor: a.info?.vendor, arch: a.info?.architecture, fallback: a.info?.isFallbackAdapter ?? a.isFallbackAdapter ?? null} : null; })()", await_promise=True)
        note("viewer", quiet=quiet, adapter=adapter)
        shot(chrome, "01-viewer-slice")

        # --- the HUD strip -----------------------------------------------------
        chrome.key("h", code="KeyH")
        chrome.wait_for("!!document.querySelector('[data-testid=\"hud\"]')", timeout=10)
        time.sleep(1.5)
        note("hud", text=(text_of(chrome, "hud") or "")[:300])
        shot(chrome, "02-hud")
        chrome.key("h", code="KeyH")

        # --- overlays during a cold load: phase colour, churn tint, inspector ----
        cold_load(chrome, baseline, ["phaseColor"])
        state = wait_rows(chrome)
        shot(chrome, "03-overlay-phase")
        note("overlay-phase", **(state or {}))
        wait_quiet(chrome)

        cold_load(chrome, baseline, ["churnTint"])
        state = wait_rows(chrome)
        shot(chrome, "04-overlay-churn")
        note("overlay-churn", **(state or {}))
        wait_quiet(chrome)

        cold_load(chrome, baseline, ["phaseColor"])
        state = wait_rows(chrome)
        cell = first_cell_center(chrome)
        if cell:
            chrome.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cell["x"], "y": cell["y"]}, session=True)
            time.sleep(0.2)
        state = overlay_state(chrome)
        shot(chrome, "05-overlay-inspector")
        note("overlay-inspector", cell=cell, **(state or {}))
        chrome.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 5}, session=True)
        wait_quiet(chrome)

        # --- the dock over the open's run, which has rows to brush --------------
        cold_load(chrome, baseline, [])
        wait_quiet(chrome)
        open_dock(chrome, 620)
        note("dock", runId=text_of(chrome, "monitor-run-id"),
             verdict=(text_of(chrome, "monitor-callout-verdict") or "")[:300],
             timeline=(text_of(chrome, "monitor-timeline-statement") or "")[:200],
             buttons=chrome.eval("[...document.querySelectorAll('[data-testid=\"monitor-dock\"] header button')].map(b => b.textContent.trim())"))
        shot(chrome, "06-dock")
        chrome.eval("document.querySelector('[data-testid=\"monitor-timeline\"]')?.scrollIntoView({block: 'start'})")
        time.sleep(0.4)
        shot(chrome, "06b-dock-timeline")

        # A shorter dock, so the highlighted cells show above it.
        open_dock(chrome, 380)
        brush_and_note(chrome, "brush", 0.5, "07-brush")
        if testid_count(chrome, "monitor-drill-verdict"):
            chrome.click_testid("monitor-drill-verdict")
            time.sleep(1.0)
            note("brush-drill", published=(text_of(chrome, "monitor-brush-selection") or "")[:240], **overlay_state(chrome))
            shot(chrome, "08-brush-drill")
            chrome.eval("[...document.querySelectorAll('button')].find(b => b.textContent === 'Close drill-down')?.click()")
        if testid_count(chrome, "monitor-brush-clear"):
            chrome.click_testid("monitor-brush-clear")
            time.sleep(0.8)
        note("brush-cleared", brush=testid_count(chrome, "monitor-brush"), **overlay_state(chrome))

        # --- Send report -------------------------------------------------------
        open_dock(chrome, 620)
        if testid_count(chrome, "monitor-send-report"):
            chrome.click_testid("monitor-send-report")
            try:
                chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-sent\"], [data-testid=\"monitor-send-failed\"]')", timeout=30)
            except TimeoutError:
                pass
            note("send-report", sent=text_of(chrome, "monitor-sent"), failed=text_of(chrome, "monitor-send-failed"))
            shot(chrome, "09-send-report", dock_clip(chrome))

        # --- the watch stream: toggle on, then scrubs while the CLI listens -----
        if testid_count(chrome, "monitor-watch-toggle"):
            chrome.click_testid("monitor-watch-toggle")
            time.sleep(1.0)
            watch = subprocess.Popen(
                [f"{LUCIDA}/lucida", "--server", SERVER, "trace", "watch", "--seconds", "10", "--json"],
                cwd=LUCIDA, stdout=open(f"{OUT}/watch.jsonl", "w"), stderr=open(f"{OUT}/watch.stderr", "w"))
            time.sleep(2.0)
            outcome = chrome.eval("JSON.stringify(window.lucidaTrace.scrub('z', 16))")
            time.sleep(3.0)
            outcome2 = chrome.eval("JSON.stringify(window.lucidaTrace.scrub('z', -16))")
            time.sleep(1.0)
            note("watch", toggle=text_of(chrome, "monitor-watch-toggle"), status=text_of(chrome, "monitor-watch-status"),
                 banner=text_of(chrome, "watch-stream-banner"), scrub=(outcome or "")[:120], scrub2=(outcome2 or "")[:120])
            shot(chrome, "10-watch")
            watch.wait(timeout=40)
            chrome.click_testid("monitor-watch-toggle")
            time.sleep(0.5)

        # --- compare mode: the baseline bundle against its replay ---------------
        chrome.click_testid("monitor-compare-runs")
        chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-compare-mode\"]')", timeout=10)
        left = open(f"{LUCIDA}/gpu-pass/baseline.bundle.json").read()
        right = open(f"{LUCIDA}/gpu-pass/replay.bundle.json").read()
        chrome.eval(
            "(() => { const input = document.querySelector('[data-testid=\"monitor-file-input\"]');"
            " const dt = new DataTransfer();"
            f" dt.items.add(new File([{json.dumps(left)}], 'baseline.bundle.json', {{type: 'application/json'}}));"
            f" dt.items.add(new File([{json.dumps(right)}], 'replay.bundle.json', {{type: 'application/json'}}));"
            " input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles: true})); return input.files.length; })()"
        )
        chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-compare\"], [data-testid=\"monitor-file-failed\"]')", timeout=20)
        time.sleep(1.5)
        note("compare", runId=text_of(chrome, "monitor-run-id"), failed=text_of(chrome, "monitor-file-failed"),
             warning=text_of(chrome, "monitor-compare-warning"), wall=text_of(chrome, "monitor-compare-wall"),
             timelines=chrome.eval("document.querySelectorAll('[data-testid=\"monitor-compare-timelines\"] canvas').length"),
             text_head=(text_of(chrome, "monitor-compare-text") or "")[:160])
        shot(chrome, "11-compare")
        chrome.eval("document.querySelector('[data-testid=\"monitor-compare-timelines\"]')?.scrollIntoView({block: 'start'})")
        time.sleep(0.4)
        shot(chrome, "12-compare-timelines")
        chrome.eval("document.querySelector('[data-testid=\"monitor-compare-header\"]')?.scrollIntoView({block: 'start'})")
        time.sleep(0.4)
        shot(chrome, "12b-compare-tables")
        chrome.click_testid("monitor-leave-compare")
        time.sleep(0.5)

        # --- a dropped bundle on its own: the report with the settled frame -----
        chrome.eval(
            "(() => { const input = document.querySelector('[data-testid=\"monitor-file-input\"]');"
            " const dt = new DataTransfer();"
            f" dt.items.add(new File([{json.dumps(left)}], 'baseline.bundle.json', {{type: 'application/json'}}));"
            " input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles: true})); return input.files.length; })()"
        )
        chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-file\"], [data-testid=\"monitor-file-failed\"]')", timeout=20)
        time.sleep(1.0)
        note("dropped-file", runId=text_of(chrome, "monitor-run-id"), failed=text_of(chrome, "monitor-file-failed"),
             frame=testid_count(chrome, "monitor-frame"), frameAbsent=text_of(chrome, "monitor-frame-absent"))
        shot(chrome, "12c-dropped-bundle")
        chrome.click_testid("monitor-close-file")
        time.sleep(0.3)
        chrome.click_testid("monitor-close")

        # --- volume mode: phase colours at load, the boxes, the hover, the brush -
        cold_load(chrome, arcball, ["phaseColor"])
        chrome.wait_for("!!document.querySelector('[data-testid=\"overlay-boxes\"]')", timeout=40, every=0.05)
        state = wait_rows(chrome, boxes=True)
        shot(chrome, "13-boxes-phase")
        note("boxes-phase", **(state or {}))
        quiet = wait_quiet(chrome)
        chrome.key("h", code="KeyH")
        chrome.wait_for("!!document.querySelector('[data-testid=\"hud\"]')", timeout=10)
        set_overlay(chrome, "phaseColor", False)
        set_overlay(chrome, "chunkGrid", True)
        time.sleep(1.5)
        note("boxes-grid", quiet=quiet, **overlay_state(chrome))
        shot(chrome, "13b-boxes-grid")

        point = first_box_point(chrome)
        if point:
            chrome.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": point["x"], "y": point["y"]}, session=True)
            time.sleep(0.6)
        note("box-hover", point=point, hovered=testid_count(chrome, "overlay-box-hovered"), **overlay_state(chrome))
        shot(chrome, "14-box-hover")
        chrome.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 5}, session=True)

        open_dock(chrome, 380)
        if testid_count(chrome, "monitor-timeline-canvas"):
            brush_and_note(chrome, "boxes-brush", 0.6, "15-boxes-brush")
            if testid_count(chrome, "monitor-brush-clear"):
                chrome.click_testid("monitor-brush-clear")
        chrome.click_testid("monitor-close")

        summary["console"] = chrome.console[-40:]
    finally:
        chrome.close()
        json.dump(summary, open(f"{OUT}/summary.json", "w"), indent=2)


main()
