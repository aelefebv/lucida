"""Network helpers: free-port allocation and the ``/healthz`` poll.

Stdlib only, on purpose — the harness must run from a fresh checkout with no
pip installs. The Python client (driven in the ``lucida-py`` env via ``uv``)
owns the workspace/dataset traffic; this module owns only the two things the
harness itself must do before handing off: pick a port nothing else holds, and
wait for the server to answer liveness.
"""

from __future__ import annotations

import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass


# Loopback only. The harness is hermetic by construction: we never want the
# throwaway server reachable off the host, and ADR-0018 keeps auth auto-disabled
# on loopback so LUCIDA_AUTH=disabled needs no LUCIDA_INSECURE opt-in.
LOOPBACK = "127.0.0.1"


def find_free_port(host: str = LOOPBACK) -> int:
    """Return a port the OS just confirmed is free on ``host``.

    We bind ``(host, 0)``, let the kernel assign an ephemeral port, read it
    back, then close the socket and hand the *number* to the server to bind.
    There is an unavoidable TOCTOU gap between our close and the server's bind;
    in practice the kernel does not immediately recycle the port, and the caller
    treats a bind failure as a normal (retryable / reported) boot error rather
    than a hang. We deliberately do *not* pass the port 0 through to the server,
    because lucida-server logs the configured bind verbatim and would report
    ``:0`` rather than the resolved port — pre-resolving keeps the reported
    ``base_url`` truthful.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


@dataclass(frozen=True)
class HealthOutcome:
    ok: bool
    status: int | None
    elapsed_s: float
    error: str | None = None


def wait_for_healthz(
    base_url: str,
    *,
    timeout_s: float,
    is_alive,
    interval_s: float = 0.1,
) -> HealthOutcome:
    """Poll ``GET {base_url}/healthz`` until it returns 200 or we give up.

    ``is_alive`` is a zero-arg callable returning ``False`` once the server
    process has exited; we short-circuit on it so a server that dies during
    startup fails *fast* with a clear signal instead of burning the full
    timeout. A timeout is itself a failure (never a hang): we return
    ``ok=False`` and let the caller tear down and report.
    """
    deadline = time.monotonic() + timeout_s
    url = base_url.rstrip("/") + "/healthz"
    last_error: str | None = None
    last_status: int | None = None
    start = time.monotonic()
    while True:
        if not is_alive():
            return HealthOutcome(
                ok=False,
                status=last_status,
                elapsed_s=time.monotonic() - start,
                error="server process exited before answering /healthz",
            )
        try:
            with urllib.request.urlopen(url, timeout=2.0) as response:
                last_status = int(response.status)
                if 200 <= last_status < 300:
                    return HealthOutcome(
                        ok=True,
                        status=last_status,
                        elapsed_s=time.monotonic() - start,
                    )
        except urllib.error.HTTPError as error:
            last_status = int(error.code)
        except (urllib.error.URLError, OSError, ValueError) as error:
            last_error = str(error)
        if time.monotonic() >= deadline:
            return HealthOutcome(
                ok=False,
                status=last_status,
                elapsed_s=time.monotonic() - start,
                error=last_error or f"timed out after {timeout_s:g}s waiting for /healthz",
            )
        time.sleep(interval_s)
