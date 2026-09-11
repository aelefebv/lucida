"""Does the captured frame track the view? Zoom in with the wheel, read the overlay's cells, capture again."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from frame_probe import Chrome, stats, canvas_rect, send_report, fetch, wait_quiet, OUT, SERVER, URL, PORT  # noqa: E402
from frame_probe3 import CELLS  # noqa: E402

chrome = Chrome(port=PORT, width=1440, height=900, ratio=2, profile=f"/tmp/lucida-probe4-{PORT}")
out = {}
try:
    chrome.goto("about:blank", settle=0.2)
    chrome.call("Page.navigate", {"url": f"{SERVER}/"}, session=True)
    chrome.wait_for("document.readyState === 'complete'", timeout=30, every=0.05)
    chrome.eval("localStorage.setItem('monitor.dock.height', '300'); localStorage.setItem('debug.overlays', 'chunkGrid'); 'ok'")
    chrome.call("Page.navigate", {"url": URL}, session=True)
    out["quiet"] = wait_quiet(chrome)
    rect = canvas_rect(chrome); out["canvas"] = rect
    out["cellsBefore"] = chrome.eval(CELLS)
    cx, cy = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
    for _ in range(6):
        chrome.call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": cx + 40, "y": cy + 40, "deltaX": 0, "deltaY": -120}, session=True)
        time.sleep(0.15)
    time.sleep(2.5)
    out["cellsAfterZoom"] = chrome.eval(CELLS)
    out["hash"] = chrome.eval("location.hash.slice(0, 60)")
    chrome.click_testid("open-monitor")
    chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-send-report\"]')", timeout=20); time.sleep(1.0)
    rect = canvas_rect(chrome); out["canvasWithDock"] = rect
    out["cellsWithDock"] = chrome.eval(CELLS)
    e = send_report(chrome); time.sleep(1.5)
    out["zoomedCapture"] = fetch(e, "zoomed") if e else "no entry"
    out["console"] = [c for c in chrome.console if c[0] in ("error", "exception", "warning")][-6:]
finally:
    chrome.close()
    json.dump(out, open(f"{OUT}/probe4.json", "w"), indent=1)
    print(json.dumps(out)[:2500])
