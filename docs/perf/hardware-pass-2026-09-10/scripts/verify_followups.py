"""Check the two merged follow-ups on the L4: the dock header at 1440 px (#1093)
and the page's bundle frame plus the inbox adapter line (#1095).

Usage: python3 verify_followups.py <lucida dir> <out dir> <server url> <workspace url> <chrome port>
"""

import glob
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

LUCIDA, OUT, SERVER, URL, PORT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
os.makedirs(OUT, exist_ok=True)
summary = {"steps": []}


def note(step, **facts):
    facts["step"] = step
    summary["steps"].append(facts)
    print(json.dumps(facts)[:900], flush=True)


def shot(chrome, name, clip=None):
    path = chrome.screenshot(f"{OUT}/{name}.png", clip)
    print("wrote", path, os.path.getsize(path), flush=True)


def testid_count(chrome, testid):
    return chrome.eval(f"document.querySelectorAll('[data-testid=\"{testid}\"]').length")


def text_of(chrome, testid):
    return chrome.eval(f"(document.querySelector('[data-testid=\"{testid}\"]') || {{}}).textContent || null")


def dock_clip(chrome):
    return chrome.eval("(() => { const el = document.querySelector('[data-testid=\"monitor-dock\"]');"
                       " if (!el) return null; const b = el.getBoundingClientRect();"
                       " return {x: b.left, y: b.top, width: b.width, height: b.height}; })()")


def wait_quiet(chrome, seconds=25):
    chrome.wait_for("!!window.lucidaTrace", timeout=30)
    deadline = time.time() + seconds
    while time.time() < deadline:
        if chrome.eval("window.lucidaTrace.progress() === null"):
            time.sleep(1.0)
            if chrome.eval("window.lucidaTrace.progress() === null"):
                return True
        time.sleep(0.5)
    return False


def cold_load(chrome, url):
    chrome.goto("about:blank", settle=0.2)
    chrome.call("Page.navigate", {"url": f"{SERVER}/"}, session=True)
    chrome.wait_for("document.readyState === 'complete'", timeout=30, every=0.05)
    chrome.eval("localStorage.removeItem('debug.overlays'); 'ok'")
    chrome.call("Page.navigate", {"url": url}, session=True)


def open_dock(chrome, height):
    chrome.eval(f"localStorage.setItem('monitor.dock.height', '{height}'); 'ok'")
    if testid_count(chrome, "monitor-dock"):
        chrome.click_testid("monitor-close")
        time.sleep(0.3)
    chrome.click_testid("open-monitor")
    chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-timeline-canvas\"], [data-testid=\"monitor-empty\"], [data-testid=\"monitor-live-counters\"]')", timeout=20)
    time.sleep(1.2)


HEADER_LAYOUT = """(() => {
  const dock = document.querySelector('[data-testid="monitor-dock"]');
  const header = dock && dock.querySelector('header');
  if (!header) return null;
  const actions = header.querySelector('.monitor-chrome-actions');
  const rect = (el) => { const b = el.getBoundingClientRect(); return {w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top)}; };
  const status = header.querySelector('[data-testid="monitor-watch-status"]');
  return {
    viewport: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio,
    header: rect(header), actions: actions ? rect(actions) : null,
    actionsWrap: actions ? getComputedStyle(actions).flexWrap : null,
    controls: [...header.querySelectorAll('button, select')].map(el => ({text: el.textContent.trim().slice(0, 28), ...rect(el)})),
    status: status ? {text: status.textContent, title: status.title, ...rect(status),
                      lineHeight: parseFloat(getComputedStyle(status).lineHeight) || null,
                      whiteSpace: getComputedStyle(status).whiteSpace} : null,
  };
})()"""


def cli(*args):
    proc = subprocess.run([f"{LUCIDA}/lucida", "--server", SERVER, *args], capture_output=True, text=True, timeout=120)
    return proc.returncode, proc.stdout, proc.stderr


def main():
    chrome = Chrome(port=PORT, width=1440, height=900, ratio=2, profile=f"/tmp/lucida-verify-{PORT}")
    try:
        cold_load(chrome, URL)
        quiet = wait_quiet(chrome)
        note("viewer", quiet=quiet)

        # #1093: read mode with a closed run and every action offered.
        open_dock(chrome, 620)
        layout = chrome.eval(HEADER_LAYOUT)
        note("dock-header", runId=text_of(chrome, "monitor-run-id"),
             verdict=(text_of(chrome, "monitor-callout-verdict") or "")[:300], **(layout or {}))
        shot(chrome, "06-dock")
        clip = dock_clip(chrome)
        if clip:
            shot(chrome, "06-dock-header", {**clip, "height": min(120, clip["height"])})

        # #1095: Send report from the page, then read the bundle back with the CLI.
        before = set(glob.glob(f"{OUT}/*.json"))
        if testid_count(chrome, "monitor-send-report"):
            chrome.click_testid("monitor-send-report")
            try:
                chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-sent\"], [data-testid=\"monitor-send-failed\"]')", timeout=40)
            except TimeoutError:
                pass
            note("send-report", sent=text_of(chrome, "monitor-sent"), failed=text_of(chrome, "monitor-send-failed"))
            shot(chrome, "09-send-report", dock_clip(chrome))
        else:
            note("send-report", missing="no monitor-send-report button")

        code, out, err = cli("trace", "inbox", "list")
        note("inbox-list", code=code, text=out[-1200:], err=err[-300:])
        code, out, err = cli("trace", "inbox", "list", "--json")
        entries = []
        try:
            listed = json.loads(out)
            entries = listed.get("entries", listed) if isinstance(listed, dict) else listed
        except Exception as exc:  # noqa: BLE001
            note("inbox-list-json", error=str(exc)[:200], text=out[:300])
        if entries:
            newest = sorted(entries, key=lambda e: e.get("sentAt") or e.get("sent_at") or "")[-1]
            entry_id = newest.get("id") or newest.get("entryId")
            target = f"{OUT}/page.bundle.json"
            proc = subprocess.run([f"{LUCIDA}/lucida", "--server", SERVER, "trace", "inbox", "fetch", entry_id, "--output", target],
                                  capture_output=True, text=True, timeout=120, cwd=OUT)
            code, err = proc.returncode, (proc.stderr or proc.stdout)[-300:]
            files = [target] if os.path.exists(target) else []
            facts = {"entry": entry_id, "code": code, "err": err, "files": [os.path.basename(f) for f in files]}
            if files:
                bundle = json.load(open(files[-1]))
                frame = bundle.get("frame")
                facts.update(absent=bundle.get("absent"),
                             frame=({k: frame[k] for k in ("width", "height", "devicePixelRatio", "capturedBy") if k in frame}
                                    | {"pngBytes": len(frame.get("png") or "")}) if frame else None,
                             gpu=(bundle.get("trace") or {}).get("runs", [{}])[-1].get("header", {}).get("gpu")
                             if isinstance(bundle.get("trace"), dict) else bundle.get("header", {}).get("gpu"))
                if frame and frame.get("png"):
                    import base64
                    with open(f"{OUT}/page-frame.png", "wb") as f:
                        f.write(base64.b64decode(frame["png"]))
                    facts["framePng"] = "page-frame.png"
            note("inbox-fetch", **facts)
    finally:
        summary["console"] = chrome.console[-40:]
        chrome.close()
        json.dump(summary, open(f"{OUT}/summary.json", "w"), indent=1)


if __name__ == "__main__":
    main()
