#!/usr/bin/env python3
"""A Range-capable static file server with injected latency and an access log.

Stands in for a remote object store. object_store's HTTP backend issues plain
GETs for whole objects and `Range: bytes=a-b` GETs for range reads, and it
requires a 206 with Content-Range for the latter, which Python's bundled
static server does not send. Every response is delayed by LATENCY_MS so the
source-read cap is the constraint, as it is on a real link. One line per
request goes to the access log:

    <epoch_ms> <method> <status> <path> <range-or-whole> <bytes>

Usage: range_server.py ROOT PORT LATENCY_MS LOG_PATH
"""
from __future__ import annotations

import email.utils
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
PORT = int(sys.argv[2])
LATENCY_S = int(sys.argv[3]) / 1000.0
LOG = open(sys.argv[4], "a", buffering=1)
LOG_LOCK = threading.Lock()


def log(method: str, status: int, path: str, rng: str, size: int) -> None:
    with LOG_LOCK:
        LOG.write(f"{int(time.time() * 1000)} {method} {status} {path} {rng} {size}\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def _resolve(self):
        rel = self.path.split("?", 1)[0].lstrip("/")
        full = os.path.abspath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            return None
        return full

    def _serve(self, send_body: bool):
        method = "GET" if send_body else "HEAD"
        full = self._resolve()
        time.sleep(LATENCY_S)
        if full is None:
            body = b"not found"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if send_body:
                self.wfile.write(body)
            log(method, 404, self.path, "-", 0)
            return
        size = os.path.getsize(full)
        mtime = email.utils.formatdate(os.path.getmtime(full), usegmt=True)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng and rng.startswith("bytes="):
            spec = rng[len("bytes=") :]
            if spec.startswith("-"):
                n = int(spec[1:])
                start, end = max(0, size - n), size - 1
            else:
                a, _, b = spec.partition("-")
                start = int(a)
                end = int(b) if b else size - 1
                end = min(end, size - 1)
            if start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                log(method, 416, self.path, rng, 0)
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Last-Modified", mtime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", f'"{size}-{int(os.path.getmtime(full))}"')
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if send_body:
            with open(full, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(remaining, 1 << 20))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        log(method, status, self.path, rng or "whole", length)

    def do_GET(self):
        self._serve(True)

    def do_HEAD(self):
        self._serve(False)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"serving {ROOT} on http://127.0.0.1:{PORT} latency={LATENCY_S * 1000:.0f}ms", flush=True)
    server.serve_forever()
