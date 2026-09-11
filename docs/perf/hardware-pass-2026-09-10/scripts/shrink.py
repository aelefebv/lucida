"""Halve PNGs through Chrome's canvas, since the host has no image library: 2880x1800 to 1440x900."""
import base64, glob, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
chrome = Chrome(port=9335, width=800, height=600, ratio=1)
try:
    chrome.goto("about:blank", settle=0.2)
    for path in sorted(glob.glob(f"{src}/*.png")):
        data = base64.b64encode(open(path, "rb").read()).decode()
        out = chrome.eval(
            "(async () => {"
            f" const r = await fetch('data:image/png;base64,{data}');"
            " const bmp = await createImageBitmap(await r.blob());"
            " const c = new OffscreenCanvas(Math.round(bmp.width / 2), Math.round(bmp.height / 2));"
            " const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';"
            " ctx.drawImage(bmp, 0, 0, c.width, c.height);"
            " const blob = await c.convertToBlob({type: 'image/png'});"
            " const buf = new Uint8Array(await blob.arrayBuffer());"
            " let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));"
            " return btoa(s); })()", await_promise=True)
        target = os.path.join(dst, os.path.basename(path))
        open(target, "wb").write(base64.b64decode(out))
        print(os.path.basename(path), os.path.getsize(path), "->", os.path.getsize(target), flush=True)
finally:
    chrome.close()
