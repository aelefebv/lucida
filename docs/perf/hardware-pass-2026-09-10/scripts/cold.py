"""Present time on the page and on the capture surface, from the same CDP harness.

Cold-opens a workspace URL the way the hardware pass did (about:blank, the
server root, then the workspace URL), waits for the open's run to close, and
reads the run's own diagnostic through the trace seam. Repeats it, then runs
an interaction (a scrub) on the settled page and reads that run too. A
long-task observer is installed before every navigation, and one load per
mode can be taken under a DevTools trace with the sampling profiler on.

Usage: python3 cold.py <out dir> <mode> [repeats] [--trace]
  mode: page | surface | interaction
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = "http://127.0.0.1:9877"
OUT = sys.argv[1]
MODE = sys.argv[2]
REPEATS = int(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith("--") else 3
TRACE = "--trace" in sys.argv
PORT = int(os.environ.get("CDP_PORT", "9340"))
os.makedirs(OUT, exist_ok=True)

LONGTASK_HOOK = """
(() => {
  window.__longTasks = [];
  window.__navStartPerf = performance.now();
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__longTasks.push({
          start: e.startTime, dur: e.duration, name: e.name,
          attr: (e.attribution || []).map(a => `${a.containerType}:${a.containerName || ''}:${a.containerSrc || ''}`),
        });
      }
    });
    po.observe({ type: 'longtask', buffered: true });
  } catch (e) { window.__longTaskError = String(e); }
})();
"""

TRACE_CATEGORIES = [
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-v8.cpu_profiler",
    "blink.user_timing",
    "v8.execute",
]


def driver_url():
    run_file = os.environ.get("RUN_FILE", f"{HERE}/runs/driver-1.json")
    header = json.load(open(run_file))["header"]
    return header["composedView"]["url"]


def page_url():
    return driver_url().replace("?render=1", "")


DIRECT = "--direct" in sys.argv
GPU_TRACE = "--gpu-trace" in sys.argv
# Hide parts of the page's chrome with the same CSS the capture surface uses,
# to attribute a cost to one element without rebuilding the bundle.
HIDE_CSS = None
if "--hide-minimap" in sys.argv:
    HIDE_CSS = ".minimap-panel { display: none !important; }"
elif "--hide-minimap-gpu" in sys.argv:
    HIDE_CSS = ".minimap-panel canvas:not(.minimap-overlay) { display: none !important; }"
elif "--hide-minimap-overlay" in sys.argv:
    HIDE_CSS = ".minimap-panel canvas.minimap-overlay { display: none !important; }"
elif "--css" in sys.argv:
    HIDE_CSS = sys.argv[sys.argv.index("--css") + 1]
HIDE_HOOK = """
(() => {
  const css = %s;
  const add = () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
})();
"""
if GPU_TRACE:
    TRACE = True
    TRACE_CATEGORIES += ["gpu", "disabled-by-default-gpu.service", "disabled-by-default-gpu.dawn", "viz", "cc", "skia", "toplevel"]


def cold_load(chrome, url):
    """The pass's cold_load: about:blank, the server root, then the URL, with no overlays on.

    With --direct the tab goes straight from about:blank to the URL, as the
    driver's fresh browser does.
    """
    chrome.goto("about:blank", settle=0.2)
    if not DIRECT:
        chrome.call("Page.navigate", {"url": f"{SERVER}/"}, session=True)
        chrome.wait_for("document.readyState === 'complete'", timeout=30, every=0.05)
        chrome.eval("localStorage.removeItem('debug.overlays'); 'ok'")
    chrome.call("Page.navigate", {"url": url}, session=True)


def wait_run_closed(chrome, concluded_before=0, timeout=60):
    """Wait until a labelled run has concluded and nothing is open, then return the run state."""
    chrome.wait_for("!!window.lucidaTrace", timeout=60, every=0.05)
    deadline = time.time() + timeout
    state = None
    while time.time() < deadline:
        state = chrome.eval(
            "(() => { const s = window.lucidaTrace.runState; return {open: s.open, concluded: s.concluded, last: s.lastConcludedRunId}; })()"
        )
        if state and state["concluded"] > concluded_before and not state["open"]:
            # Hold a moment so a run opened right after (a contrast refit, a saved view) is seen as open.
            time.sleep(0.6)
            again = chrome.eval(
                "(() => { const s = window.lucidaTrace.runState; return {open: s.open, concluded: s.concluded, last: s.lastConcludedRunId}; })()"
            )
            if again and not again["open"] and again["concluded"] == state["concluded"]:
                return again
            state = again
            continue
        time.sleep(0.1)
    raise TimeoutError(f"run never closed: {state!r}")


def read_run(chrome, run_id):
    doc = chrome.eval(f"JSON.stringify(window.lucidaTrace.diagnose({json.dumps(run_id)}))")
    doc = json.loads(doc)
    text = chrome.eval(f"window.lucidaTrace.diagnoseText({json.dumps(run_id)}, {{depth: 'phases'}})")
    return doc, text


def present_of(doc):
    for phase in doc.get("phases", []):
        if phase["id"] == "browser.present":
            return {"p50": phase.get("p50Ms"), "p95": phase.get("p95Ms"), "max": phase.get("maxMs"), "n": phase.get("n")}
    return None


def page_facts(chrome):
    return chrome.eval("""(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        timeOrigin: performance.timeOrigin,
        now: performance.now(),
        dpr: window.devicePixelRatio,
        inner: [window.innerWidth, window.innerHeight],
        canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height, c.clientWidth, c.clientHeight] : null; })(),
        nav: nav ? {domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, responseEnd: nav.responseEnd} : null,
        longTasks: window.__longTasks || null,
        longTaskError: window.__longTaskError || null,
        resources: performance.getEntriesByType('resource').length,
      };
    })()""")


def start_trace(chrome):
    chrome.call("Tracing.start", {
        "traceConfig": {"includedCategories": TRACE_CATEGORIES, "recordMode": "recordContinuously"},
        "transferMode": "ReportEvents",
    }, session=True)


def end_trace(chrome, path):
    chrome.call("Tracing.end", session=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        chrome.eval("1")
        if any(e.get("method") == "Tracing.tracingComplete" for e in chrome.events):
            break
        time.sleep(0.2)
    events = []
    for e in chrome.events:
        if e.get("method") == "Tracing.dataCollected":
            events.extend(e["params"]["value"])
    chrome.events = [e for e in chrome.events if not e.get("method", "").startswith("Tracing.")]
    with open(path, "w") as f:
        json.dump({"traceEvents": events}, f)
    return len(events)


def one_cold_open(chrome, url, tag, trace=False):
    t0 = time.time()
    if trace:
        start_trace(chrome)
    cold_load(chrome, url)
    state = wait_run_closed(chrome)
    # Mark the moment on the page's clock so a trace can be aligned to it.
    chrome.eval("performance.mark('run-closed-observed'); 1")
    doc, text = read_run(chrome, state["last"])
    facts = page_facts(chrome)
    events = end_trace(chrome, f"{OUT}/{tag}.trace.json") if trace else None
    out = {
        "tag": tag, "url": url, "runId": state["last"], "concluded": state["concluded"],
        "cause": doc["run"].get("cause"), "warmth": doc["run"].get("warmth"), "wallMs": doc["run"].get("wallMs"),
        "verdict": doc.get("verdict"), "present": present_of(doc),
        "findings": [{"severity": f["severity"], "rule": f["rule"], "subject": f["subject"], "observed": f["observed"]} for f in doc.get("findings", [])],
        "renderTiming": doc.get("renderTiming"), "facts": facts, "traceEvents": events,
        "harnessSeconds": round(time.time() - t0, 1),
    }
    json.dump(doc, open(f"{OUT}/{tag}.diagnostic.json", "w"))
    open(f"{OUT}/{tag}.txt", "w").write(text)
    json.dump(out, open(f"{OUT}/{tag}.json", "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("tag", "runId", "cause", "wallMs", "present")}), flush=True)
    print("  verdict:", (out["verdict"] or {}).get("kind"), (out["verdict"] or {}).get("text", "")[:160], flush=True)
    return out


def one_interaction(chrome, url, tag, axis="z", count=16, trace=False):
    cold_load(chrome, url)
    opened = wait_run_closed(chrome)
    time.sleep(2.0)
    before = chrome.eval("window.lucidaTrace.runState.concluded")
    if trace:
        start_trace(chrome)
    outcome = chrome.eval(f"JSON.stringify(window.lucidaTrace.scrub({json.dumps(axis)}, {count}))")
    state = wait_run_closed(chrome, concluded_before=before)
    chrome.eval("performance.mark('run-closed-observed'); 1")
    doc, text = read_run(chrome, state["last"])
    facts = page_facts(chrome)
    events = end_trace(chrome, f"{OUT}/{tag}.trace.json") if trace else None
    out = {
        "tag": tag, "url": url, "openRunId": opened["last"], "runId": state["last"], "scrub": json.loads(outcome or "null"),
        "cause": doc["run"].get("cause"), "warmth": doc["run"].get("warmth"), "wallMs": doc["run"].get("wallMs"),
        "verdict": doc.get("verdict"), "present": present_of(doc),
        "findings": [{"severity": f["severity"], "rule": f["rule"], "subject": f["subject"], "observed": f["observed"]} for f in doc.get("findings", [])],
        "renderTiming": doc.get("renderTiming"), "facts": facts, "traceEvents": events,
    }
    json.dump(doc, open(f"{OUT}/{tag}.diagnostic.json", "w"))
    open(f"{OUT}/{tag}.txt", "w").write(text)
    json.dump(out, open(f"{OUT}/{tag}.json", "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("tag", "runId", "cause", "wallMs", "present")}), flush=True)
    print("  verdict:", (out["verdict"] or {}).get("kind"), (out["verdict"] or {}).get("text", "")[:160], flush=True)
    return out


def main():
    os.makedirs(f"{HERE}/profiles", exist_ok=True)
    profile = f"{HERE}/profiles/{PORT}"
    chrome = Chrome(port=PORT, width=1440, height=900, ratio=2, profile=profile)
    results = []
    try:
        chrome.call("Page.addScriptToEvaluateOnNewDocument", {"source": LONGTASK_HOOK}, session=True)
        if HIDE_CSS:
            chrome.call("Page.addScriptToEvaluateOnNewDocument", {"source": HIDE_HOOK % json.dumps(HIDE_CSS)}, session=True)
        url = page_url() if MODE in ("page", "interaction") else driver_url()
        for i in range(1, REPEATS + 1):
            tag = f"{MODE}-{i}"
            trace = TRACE and i == REPEATS
            if MODE == "interaction":
                results.append(one_interaction(chrome, url, tag, trace=trace))
            else:
                results.append(one_cold_open(chrome, url, tag, trace=trace))
    finally:
        chrome.close()
        json.dump({"mode": MODE, "results": results, "console": chrome.console[-60:]}, open(f"{OUT}/{MODE}-summary.json", "w"), indent=1)
    print("present p95 per run:", [r["present"] and r["present"]["p95"] for r in results])


main()
