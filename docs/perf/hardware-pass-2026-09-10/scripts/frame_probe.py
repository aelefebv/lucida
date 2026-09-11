"""Does the page's captured frame match what the canvas shows? Screenshot the canvas before and
after a capture, capture after a scrub too, and compare pixel statistics with the bundle frames.

Usage: python3 frame_probe.py <lucida dir> <out dir> <server url> <workspace url> <chrome port>
"""
import base64, collections, json, os, struct, subprocess, sys, time, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Chrome  # noqa: E402

LUCIDA, OUT, SERVER, URL, PORT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
os.makedirs(OUT, exist_ok=True)


def read_png(path):
    data = open(path, 'rb').read(); pos = 8; idat = b''; w = h = ct = None
    while pos < len(data):
        n, = struct.unpack('>I', data[pos:pos+4]); t = data[pos+4:pos+8]; c = data[pos+8:pos+8+n]; pos += 12+n
        if t == b'IHDR': w, h, _, ct = struct.unpack('>IIBB', c[:10])
        elif t == b'IDAT': idat += c
    raw = zlib.decompress(idat); bpp = {6: 4, 2: 3}[ct]; stride = w*bpp; rows = []; prev = bytearray(stride); i = 0
    for y in range(h):
        f = raw[i]; line = bytearray(raw[i+1:i+1+stride]); i += 1+stride
        if f == 1:
            for x in range(bpp, stride): line[x] = (line[x]+line[x-bpp]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x]+prev[x]) & 255
        elif f == 3:
            for x in range(stride): line[x] = (line[x]+(((line[x-bpp] if x >= bpp else 0)+prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-bpp] if x >= bpp else 0; b = prev[x]; c = prev[x-bpp] if x >= bpp else 0
                p = a+b-c; pa = abs(p-a); pb = abs(p-b); pc = abs(p-c)
                line[x] = (line[x]+(a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(bytes(line)); prev = line
    return w, h, bpp, rows


def stats(path):
    w, h, bpp, rows = read_png(path); cnt = collections.Counter()
    for y in range(0, h, 4):
        r = rows[y]
        for x in range(0, w, 4): cnt[r[x*bpp:x*bpp+3]] += 1
    bg = cnt.most_common(1)[0][0]; xs = []; ys = []
    for y in range(0, h, 4):
        r = rows[y]
        for x in range(0, w, 4):
            if r[x*bpp:x*bpp+3] != bg: xs.append(x); ys.append(y)
    return {"size": f"{w}x{h}", "top": [(list(k), v) for k, v in cnt.most_common(3)],
            "nonBgBox": [min(xs), min(ys), max(xs), max(ys)] if xs else None}


def canvas_rect(chrome):
    return chrome.eval("(() => { const c = document.querySelector('canvas'); const b = c.getBoundingClientRect();"
                       " return {x: b.left, y: b.top, width: b.width, height: b.height, w: c.width, h: c.height}; })()")


def testid_count(chrome, testid):
    return chrome.eval(f"document.querySelectorAll('[data-testid=\"{testid}\"]').length")


def text_of(chrome, testid):
    return chrome.eval(f"(document.querySelector('[data-testid=\"{testid}\"]') || {{}}).textContent || null")


def wait_quiet(chrome, seconds=25):
    chrome.wait_for("!!window.lucidaTrace", timeout=30); deadline = time.time()+seconds
    while time.time() < deadline:
        if chrome.eval("window.lucidaTrace.progress() === null"):
            time.sleep(1.0)
            if chrome.eval("window.lucidaTrace.progress() === null"): return True
        time.sleep(0.5)
    return False


def send_report(chrome):
    chrome.click_testid("monitor-send-report")
    chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-sent\"], [data-testid=\"monitor-send-failed\"]')", timeout=40)
    text = text_of(chrome, "monitor-sent") or text_of(chrome, "monitor-send-failed") or ""
    return text.split(" as ")[1].split(".")[0] if " as " in text else None


def fetch(entry, name):
    target = f"{OUT}/{name}.bundle.json"
    subprocess.run([f"{LUCIDA}/lucida", "--server", SERVER, "trace", "inbox", "fetch", entry, "--output", target],
                   capture_output=True, text=True, timeout=120)
    b = json.load(open(target)); frame = b.get("frame")
    if frame and frame.get("png"):
        open(f"{OUT}/{name}-frame.png", "wb").write(base64.b64decode(frame["png"]))
        return {"absent": b.get("absent"), "frame": stats(f"{OUT}/{name}-frame.png"), "capturedBy": frame.get("capturedBy")}
    return {"absent": b.get("absent"), "frame": None}


def main():
    chrome = Chrome(port=PORT, width=1440, height=900, ratio=2, profile=f"/tmp/lucida-probe-{PORT}")
    out = {}
    try:
        chrome.goto("about:blank", settle=0.2)
        chrome.call("Page.navigate", {"url": f"{SERVER}/"}, session=True)
        chrome.wait_for("document.readyState === 'complete'", timeout=30, every=0.05)
        chrome.eval("localStorage.setItem('monitor.dock.height', '300'); localStorage.removeItem('debug.overlays'); 'ok'")
        chrome.call("Page.navigate", {"url": URL}, session=True)
        out["quiet"] = wait_quiet(chrome)
        rect = canvas_rect(chrome); out["canvas"] = rect
        clip = {k: rect[k] for k in ("x", "y", "width", "height")}
        chrome.screenshot(f"{OUT}/A-before.png", clip); out["A-before"] = stats(f"{OUT}/A-before.png")
        chrome.click_testid("open-monitor")
        chrome.wait_for("!!document.querySelector('[data-testid=\"monitor-send-report\"]')", timeout=20); time.sleep(1.0)
        rect = canvas_rect(chrome); out["canvasWithDock"] = rect
        clip = {k: rect[k] for k in ("x", "y", "width", "height")}
        chrome.screenshot(f"{OUT}/B-dock-open.png", clip); out["B-dock-open"] = stats(f"{OUT}/B-dock-open.png")
        e1 = send_report(chrome); time.sleep(1.5)
        chrome.screenshot(f"{OUT}/C-after-capture.png", clip); out["C-after-capture"] = stats(f"{OUT}/C-after-capture.png")
        out["capture1"] = fetch(e1, "capture1") if e1 else "no entry"
        out["scrub"] = chrome.eval("JSON.stringify(window.lucidaTrace.scrub('z', 16))")
        time.sleep(2.0)
        chrome.screenshot(f"{OUT}/D-after-scrub.png", clip); out["D-after-scrub"] = stats(f"{OUT}/D-after-scrub.png")
        e2 = send_report(chrome); time.sleep(1.5)
        chrome.screenshot(f"{OUT}/E-after-capture2.png", clip); out["E-after-capture2"] = stats(f"{OUT}/E-after-capture2.png")
        out["capture2"] = fetch(e2, "capture2") if e2 else "no entry"
        out["console"] = [c for c in chrome.console if c[0] in ("error", "exception", "warning")][-8:]
    finally:
        chrome.close()
        json.dump(out, open(f"{OUT}/probe.json", "w"), indent=1)
        print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
