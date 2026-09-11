"""Time the first 2D canvas draw in a fresh headless Chrome with the page's flags.

Usage: python3 canvas2d.py [url]

Opens about:blank (or the URL) at device pixel ratio 2, then times: the first
clearRect on a fresh 400 x 400 canvas, a second fresh canvas, a fresh canvas
of the same size that is display:none, and the same again after the page has
settled. Prints milliseconds.
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("CDP_PORT", "9342"))
URL = sys.argv[1] if len(sys.argv) > 1 else "about:blank"

PROBE = """
((label, hidden, attach) => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  if (hidden) c.style.display = 'none';
  if (attach) document.body.appendChild(c);
  const t0 = performance.now();
  const ctx = c.getContext('2d');
  const t1 = performance.now();
  ctx.clearRect(0, 0, 400, 400);
  const t2 = performance.now();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(10, 10, 100, 100);
  const t3 = performance.now();
  ctx.getImageData(0, 0, 1, 1);
  const t4 = performance.now();
  return { label, getContext: +(t1 - t0).toFixed(2), clearRect: +(t2 - t1).toFixed(2), strokeRect: +(t3 - t2).toFixed(2), readback: +(t4 - t3).toFixed(2) };
})
"""


def main():
    os.makedirs(f"{HERE}/profiles", exist_ok=True)
    chrome = Chrome(port=PORT, width=1440, height=900, ratio=2, profile=f"{HERE}/profiles/{PORT}")
    try:
        chrome.goto(URL, settle=1.0)
        if URL != "about:blank":
            chrome.wait_for("!!window.lucidaTrace && window.lucidaTrace.runState.concluded > 0", timeout=60)
            time.sleep(1.0)
        for label, hidden, attach in (("attached", False, True), ("attached again", False, True), ("hidden", True, True), ("detached", False, False), ("attached third", False, True)):
            print(json.dumps(chrome.eval(f"{PROBE}({json.dumps(label)}, {str(hidden).lower()}, {str(attach).lower()})")), flush=True)
            time.sleep(0.3)
    finally:
        chrome.close()


main()
