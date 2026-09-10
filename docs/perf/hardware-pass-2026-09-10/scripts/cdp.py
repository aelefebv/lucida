"""A DevTools protocol client on the standard library alone.

Chrome's remote debugging endpoint speaks WebSocket. This module does the
handshake and the client-side framing itself, so it runs on a host with
python3 and nothing installed. It is enough for Runtime.evaluate, Input
events, and Page.captureScreenshot, which is what a UI pass needs.
"""

import base64
import json
import os
import socket
import struct
import subprocess
import time
import urllib.request
from urllib.parse import urlparse


class WebSocket:
    def __init__(self, url, timeout=120):
        u = urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake closed")
            response += chunk
        head, _, rest = response.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(f"websocket handshake failed: {head[:200]!r}")
        self.buffer = rest

    def _read(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(max(65536, n - len(self.buffer)))
            if not chunk:
                raise RuntimeError("websocket closed")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def send(self, text):
        payload = text.encode()
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv(self):
        message = bytearray()
        while True:
            b1, b2 = self._read(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                mask = self._read(4)
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read(n)))
            else:
                data = self._read(n)
            if opcode == 0x8:
                raise RuntimeError("websocket closed by peer")
            if opcode == 0x9:
                self._pong(data)
                continue
            if opcode == 0xA:
                continue
            message += data
            if fin:
                return message.decode()

    def _pong(self, data):
        header = bytearray([0x8A, 0x80 | len(data)])
        mask = os.urandom(4)
        self.sock.sendall(bytes(header) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def close(self):
        self.sock.close()


class Chrome:
    """Headless Chrome on the GPU, with one page attached."""

    FLAGS = [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=vulkan",
        "--disable-vulkan-surface",
        "--ignore-gpu-blocklist",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--mute-audio",
    ]

    def __init__(self, port=9333, width=1440, height=900, ratio=2, profile=None, extra=()):
        self.port = port
        self.profile = profile or f"/tmp/lucida-ui-pass-{port}"
        self.proc = subprocess.Popen(
            ["google-chrome-stable", *self.FLAGS, *extra,
             f"--remote-debugging-port={port}", f"--user-data-dir={self.profile}",
             f"--window-size={width},{height}", f"--force-device-scale-factor={ratio}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=open(f"{self.profile}.stderr", "ab"),
        )
        deadline = time.time() + 30
        while True:
            try:
                version = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version"))
                break
            except Exception:
                if time.time() > deadline:
                    raise
                time.sleep(0.3)
        self.ws = WebSocket(version["webSocketDebuggerUrl"])
        self._id = 0
        self.events = []
        target = self.call("Target.createTarget", {"url": "about:blank"})
        self.session = self.call("Target.attachToTarget", {"targetId": target["targetId"], "flatten": True})["sessionId"]
        self.call("Runtime.enable", session=True)
        self.call("Page.enable", session=True)
        self.call("Emulation.setDeviceMetricsOverride",
                  {"width": width, "height": height, "deviceScaleFactor": ratio, "mobile": False}, session=True)
        self.console = []

    def call(self, method, params=None, session=False):
        self._id += 1
        msg = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = self.session
        self.ws.send(json.dumps(msg))
        while True:
            reply = json.loads(self.ws.recv())
            if reply.get("id") == self._id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply.get("result", {})
            if reply.get("method") == "Runtime.consoleAPICalled":
                args = reply["params"].get("args", [])
                text = " ".join(str(a.get("value", a.get("description", ""))) for a in args)
                self.console.append((reply["params"].get("type"), text[:300]))
            elif reply.get("method") == "Runtime.exceptionThrown":
                detail = reply["params"].get("exceptionDetails", {})
                self.console.append(("exception", str(detail.get("text"))[:300]))
            else:
                self.events.append(reply)

    def goto(self, url, settle=2.0):
        self.call("Page.navigate", {"url": url}, session=True)
        deadline = time.time() + 60
        while time.time() < deadline:
            state = self.eval("document.readyState")
            if state == "complete":
                break
            time.sleep(0.2)
        time.sleep(settle)

    def eval(self, expression, await_promise=False):
        result = self.call("Runtime.evaluate",
                           {"expression": expression, "awaitPromise": await_promise, "returnByValue": True},
                           session=True)
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            text = detail.get("exception", {}).get("description") or detail.get("text")
            raise RuntimeError(f"page threw: {text}")
        return result.get("result", {}).get("value")

    def wait_for(self, expression, timeout=30, every=0.25):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = self.eval(expression)
            if last:
                return last
            time.sleep(every)
        raise TimeoutError(f"gave up waiting for {expression!r}; last value {last!r}")

    def screenshot(self, path, clip=None):
        params = {"format": "png", "captureBeyondViewport": False}
        if clip:
            params["clip"] = {**clip, "scale": 1}
        data = self.call("Page.captureScreenshot", params, session=True)["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return path

    def click(self, x, y):
        for kind, count in (("mousePressed", 1), ("mouseReleased", 1)):
            self.call("Input.dispatchMouseEvent",
                      {"type": kind, "x": x, "y": y, "button": "left", "clickCount": count}, session=True)

    def click_testid(self, testid):
        rect = self.eval(
            f"(() => {{ const el = document.querySelector('[data-testid=\"{testid}\"]'); if (!el) return null;"
            f" el.scrollIntoView({{block: 'nearest'}}); const r = el.getBoundingClientRect();"
            f" return {{x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height}}; }})()"
        )
        if not rect:
            raise RuntimeError(f"no element with data-testid {testid}")
        self.click(rect["x"], rect["y"])
        return rect

    def key(self, key, code=None, text=None):
        params = {"type": "keyDown", "key": key, "code": code or f"Key{key.upper()}", "windowsVirtualKeyCode": ord(key.upper())}
        if text is not None:
            params["text"] = text
        self.call("Input.dispatchKeyEvent", params, session=True)
        self.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": key, "code": code or f"Key{key.upper()}",
                                             "windowsVirtualKeyCode": ord(key.upper())}, session=True)

    def drag(self, x0, y0, x1, y1, steps=8, pointer_type="mouse"):
        self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0, "y": y0}, session=True)
        self.call("Input.dispatchMouseEvent",
                  {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "clickCount": 1, "pointerType": pointer_type},
                  session=True)
        for i in range(1, steps + 1):
            t = i / steps
            self.call("Input.dispatchMouseEvent",
                      {"type": "mouseMoved", "x": x0 + (x1 - x0) * t, "y": y0 + (y1 - y0) * t, "button": "left",
                       "buttons": 1, "pointerType": pointer_type}, session=True)
            time.sleep(0.02)
        self.call("Input.dispatchMouseEvent",
                  {"type": "mouseReleased", "x": x1, "y": y1, "button": "left", "clickCount": 1, "pointerType": pointer_type},
                  session=True)

    def close(self):
        try:
            self.call("Browser.close")
        except Exception:
            pass
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
