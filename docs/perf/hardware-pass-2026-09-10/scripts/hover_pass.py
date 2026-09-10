"""The box under the pointer in volume mode, on hardware: a box whose centre is on screen."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome
import ui_pass_lib as lib

LUCIDA, OUT = sys.argv[1], sys.argv[2]
chrome = Chrome(port=9334, width=1440, height=900, ratio=2)
try:
    lib.cold_load(chrome, lib.run_url(LUCIDA, "arcball"), ["chunkGrid"])
    chrome.wait_for("!!document.querySelector('[data-testid=\"overlay-boxes\"]')", timeout=40, every=0.05)
    lib.wait_quiet(chrome)
    time.sleep(1.0)
    point = chrome.eval("""(() => {
      const svg = document.querySelector('[data-testid="overlay-boxes"]');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const centres = [];
      for (const path of svg.querySelectorAll('[data-testid="overlay-box-batch"]')) {
        const segs = [...(path.getAttribute('d') || '').matchAll(/M([\\d.]+) ([\\d.]+) L([\\d.]+) ([\\d.]+)/g)];
        for (let i = 0; i + 12 <= segs.length; i += 12) {
          let x = 0, y = 0;
          for (const m of segs.slice(i, i + 12)) { x += Number(m[1]) + Number(m[3]); y += Number(m[2]) + Number(m[4]); }
          x /= 24; y /= 24;
          if (x > 8 && y > 8 && x < r.width - 8 && y < r.height - 8) centres.push({ x: r.left + x, y: r.top + y });
        }
      }
      if (!centres.length) return null;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      centres.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
      return { ...centres[0], candidates: centres.length, svg: { w: r.width, h: r.height } };
    })()""")
    if point:
        chrome.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": point["x"], "y": point["y"]}, session=True)
        time.sleep(0.8)
    state = lib.overlay_state(chrome)
    print(json.dumps({"point": point, "hovered": lib.testid_count(chrome, "overlay-box-hovered"), **state})[:600])
    chrome.screenshot(f"{OUT}/14-box-hover.png")
finally:
    chrome.close()
