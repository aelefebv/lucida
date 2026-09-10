"""Where is the dataset on screen? Read the chunk-grid overlay's DOM cells (CSS px) and the page's own globals,
and try a screenshot that bypasses the surface."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from frame_probe import Chrome, stats, canvas_rect, wait_quiet, OUT, SERVER, URL, PORT  # noqa: E402

CELLS = """(() => {
  const cells = [...document.querySelectorAll('[title*="·"]')].filter(n => n.style && n.style.position === 'absolute' && n.style.border);
  const rects = cells.map(c => c.getBoundingClientRect());
  if (!rects.length) return {cells: 0};
  const box = [Math.min(...rects.map(r => r.left)), Math.min(...rects.map(r => r.top)), Math.max(...rects.map(r => r.right)), Math.max(...rects.map(r => r.bottom))];
  return {cells: cells.length, first: {w: rects[0].width, h: rects[0].height}, box: box.map(Math.round), titles: cells.slice(0, 2).map(c => c.title.slice(0, 80))};
})()"""

chrome = Chrome(port=PORT, width=1440, height=900, ratio=2, profile=f"/tmp/lucida-probe3-{PORT}")
out = {}
try:
    chrome.goto("about:blank", settle=0.2)
    chrome.call("Page.navigate", {"url": f"{SERVER}/"}, session=True)
    chrome.wait_for("document.readyState === 'complete'", timeout=30, every=0.05)
    chrome.eval("localStorage.setItem('debug.overlays', 'chunkGrid'); 'ok'")
    chrome.call("Page.navigate", {"url": URL}, session=True)
    out["quiet"] = wait_quiet(chrome)
    time.sleep(1.0)
    out["canvas"] = canvas_rect(chrome)
    out["cells"] = chrome.eval(CELLS)
    out["globals"] = chrome.eval("Object.keys(window).filter(k => /lucida/i.test(k))")
    out["traceKeys"] = chrome.eval("Object.keys(window.lucidaTrace || {})")
    out["hash"] = chrome.eval("location.hash.slice(0, 200)")
    out["legend"] = chrome.eval("[...document.querySelectorAll('[data-testid=\"hud-legend\"] input')].map(i => i.getAttribute('aria-label') + ':' + i.checked)")
    rect = out["canvas"]; clip = {k: rect[k] for k in ("x", "y", "width", "height")}
    chrome.screenshot(f"{OUT}/G-grid.png", clip); out["G-grid"] = stats(f"{OUT}/G-grid.png")
    data = chrome.call("Page.captureScreenshot", {"format": "png", "fromSurface": False, "clip": {**clip, "scale": 1}}, session=True)["data"]
    import base64; open(f"{OUT}/G-nosurface.png", "wb").write(base64.b64decode(data)); out["G-nosurface"] = stats(f"{OUT}/G-nosurface.png")
    out["console"] = [c for c in chrome.console if c[0] in ("error", "exception", "warning")][-6:]
finally:
    chrome.close()
    json.dump(out, open(f"{OUT}/probe3.json", "w"), indent=1)
    print(json.dumps(out)[:2500])
