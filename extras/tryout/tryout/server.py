"""Boot, health-gate, and reap a throwaway ``lucida-server``.

This is the spine every later surface (CLI / Python / web) builds on, so the
lifecycle is the explicit contract here:

    build (or reuse a pointed-at binary)
      -> allocate a free port + a temp DB under a temp dir
      -> spawn with LUCIDA_BIND / LUCIDA_DB_URL / LUCIDA_AUTH=disabled,
         streaming stdout+stderr into DIR/server.log
      -> wait for GET /healthz
      -> (caller does its work)
      -> teardown: SIGTERM, then SIGKILL, ALWAYS

``ServerProcess`` is a context manager precisely so teardown is structural: the
``with`` block guarantees ``stop()`` runs on success, exception, or signal.
Hermeticity is built in — the temp DB lives in a per-run temp dir we create and
remove, so the repo's real ``lucida.db`` is never touched.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .errors import TryoutError
from .netutil import LOOPBACK, HealthOutcome, find_free_port, wait_for_healthz


# Sentinel DB filename inside the throwaway temp dir. Never the repo root.
TEMP_DB_NAME = "tryout.db"
# How long to wait for the server to answer /healthz after spawn.
DEFAULT_HEALTH_TIMEOUT_S = 90.0
# Graceful-shutdown grace period before we escalate to SIGKILL.
TEARDOWN_GRACE_S = 8.0


@dataclass(frozen=True)
class ServerHandle:
    """Immutable facts about a booted server, safe to put in the report."""

    base_url: str
    ws_url: str
    host: str
    port: int
    pid: int
    db_path: Path
    server_log: Path
    healthz: bool
    health_elapsed_s: float


def repo_root() -> Path:
    """Repo root inferred from this file's location (``<repo>/extras/tryout/tryout/``).

    Deriving it from ``__file__`` rather than the cwd is what makes the harness
    "reflect the working tree": run it from any checkout/worktree and it builds
    and drives *that* tree's code.
    """
    return Path(__file__).resolve().parents[3]


def _ws_url_for(host: str, port: int) -> str:
    return f"ws://{host}:{port}"


def resolve_server_binary(*, build_timeout_s: float = 1200.0, log=print) -> Path:
    """Return a path to a runnable ``lucida-server``.

    Fast path (the loop the spec calls out): if ``LUCIDA_TRYOUT_SERVER_BIN``
    points at an existing executable, reuse it and skip the build. Otherwise
    build from source with ``cargo build -p lucida-server`` so uncommitted
    working-tree changes are reflected, then use the produced debug binary.
    """
    pointed = os.environ.get("LUCIDA_TRYOUT_SERVER_BIN")
    if pointed:
        candidate = Path(pointed)
        if not candidate.is_file():
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_SERVER_BIN points at a non-existent file: {candidate}",
            )
        if not os.access(candidate, os.X_OK):
            raise TryoutError(
                "config",
                f"LUCIDA_TRYOUT_SERVER_BIN is not executable: {candidate}",
            )
        return candidate

    root = repo_root()
    cargo = shutil.which("cargo")
    if cargo is None:
        raise TryoutError(
            "build",
            "cargo not found on PATH; install Rust toolchain or set "
            "LUCIDA_TRYOUT_SERVER_BIN to a prebuilt lucida-server",
        )
    log("[tryout] building lucida-server from source (cargo build -p lucida-server) ...")
    started = time.monotonic()
    try:
        result = subprocess.run(
            [cargo, "build", "-p", "lucida-server"],
            cwd=root,
            timeout=build_timeout_s,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except subprocess.TimeoutExpired as error:
        raise TryoutError(
            "build",
            f"cargo build -p lucida-server timed out after {build_timeout_s:g}s",
        ) from error
    if result.returncode != 0:
        tail = "\n".join((result.stdout or "").splitlines()[-40:])
        raise TryoutError(
            "build",
            f"cargo build -p lucida-server failed (exit {result.returncode})",
            detail={"output_tail": tail},
        )
    log(f"[tryout] build finished in {time.monotonic() - started:.1f}s")
    binary = root / "target" / "debug" / "lucida-server"
    if not binary.is_file():
        raise TryoutError(
            "build",
            f"build reported success but {binary} is missing",
        )
    return binary


class ServerProcess:
    """A throwaway server bound to its own temp DB and free port.

    Use as a context manager so teardown is guaranteed::

        with ServerProcess(out_dir=Path("/tmp/x")) as server:
            server.start()
            ...  # talk to server.handle.base_url
        # server is reaped here no matter what

    The temp dir (and its DB) is created on ``start`` and removed on ``stop``,
    so nothing leaks onto disk and the repo's real ``lucida.db`` is never in
    play.
    """

    def __init__(
        self,
        *,
        out_dir: Path,
        binary: Path | None = None,
        host: str = LOOPBACK,
        data_dir: Path | None = None,
        web_dist: Path | None = None,
        health_timeout_s: float = DEFAULT_HEALTH_TIMEOUT_S,
        log=print,
    ):
        self._out_dir = out_dir
        self._binary = binary
        self._host = host
        self._data_dir = data_dir
        self._web_dist = web_dist
        self._health_timeout_s = health_timeout_s
        self._log = log

        self._proc: subprocess.Popen | None = None
        self._log_handle = None
        self._temp_dir: Path | None = None
        self._db_path: Path | None = None
        self._port: int | None = None
        self.handle: ServerHandle | None = None
        self.teardown_state = "pending"

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> ServerHandle:
        binary = self._binary or resolve_server_binary(log=self._log)
        self._out_dir.mkdir(parents=True, exist_ok=True)

        # Per-run temp dir for the DB so we are hermetic by construction.
        self._temp_dir = Path(tempfile.mkdtemp(prefix="lucida-tryout."))
        self._db_path = self._temp_dir / TEMP_DB_NAME

        self._port = find_free_port(self._host)
        base_url = f"http://{self._host}:{self._port}"
        log_path = self._out_dir / "server.log"

        env = self._build_env()
        self._log(
            f"[tryout] booting {binary} on {base_url} "
            f"(db={self._db_path}, log={log_path})"
        )
        self._log_handle = open(log_path, "w", encoding="utf-8")
        # Header line so a human opening server.log sees exactly what was run.
        self._log_handle.write(
            f"# lucida-server: {binary}\n"
            f"# bind: {self._host}:{self._port}\n"
            f"# db: {self._db_path}\n"
            + (f"# web_dist: {self._web_dist}\n" if self._web_dist is not None else "")
            + f"# argv: {binary} serve\n\n"
        )
        self._log_handle.flush()

        argv = [str(binary), "serve"]
        if self._data_dir is not None:
            argv += ["--data-dir", str(self._data_dir)]
        try:
            self._proc = subprocess.Popen(
                argv,
                cwd=self._temp_dir,  # never the repo root: extra guard for cwd-relative DB
                env=env,
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # own process group -> we can reap the whole tree
            )
        except OSError as error:
            raise TryoutError("boot", f"failed to spawn lucida-server: {error}") from error

        health = self._await_health(base_url)
        self.handle = ServerHandle(
            base_url=base_url,
            ws_url=_ws_url_for(self._host, self._port),
            host=self._host,
            port=self._port,
            pid=self._proc.pid,
            db_path=self._db_path,
            server_log=log_path,
            healthz=health.ok,
            health_elapsed_s=round(health.elapsed_s, 3),
        )
        if not health.ok:
            raise TryoutError(
                "healthz",
                health.error or "server did not become healthy",
                detail={"log": str(log_path)},
            )
        self._log(f"[tryout] healthy in {health.elapsed_s:.2f}s")
        return self.handle

    def _build_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["LUCIDA_BIND"] = f"{self._host}:{self._port}"
        env["LUCIDA_DB_URL"] = f"sqlite://{self._db_path}"
        env["LUCIDA_AUTH"] = "disabled"
        # Be explicit: drop any inherited overrides that would point the server
        # at a non-loopback bind (which would then demand LUCIDA_INSECURE) or at
        # a different DB. We own these for the throwaway server.
        env.pop("LUCIDA_INSECURE", None)
        # Web surface: point the server at the SPA bundle to serve (ADR-0020) so a
        # real browser can render the viewer. Absolute, because the server's cwd
        # is our throwaway temp dir, not the repo. When unset, we leave the
        # server's own default (./lucida-web/dist) untouched so non-web bring-ups
        # (up, drive --surface cli/python) behave exactly as before.
        if self._web_dist is not None:
            env["LUCIDA_WEB_DIST"] = str(self._web_dist)
        # Make the boot deterministic & greppable in server.log.
        env.setdefault("RUST_LOG", "info")
        return env

    def _await_health(self, base_url: str) -> HealthOutcome:
        return wait_for_healthz(
            base_url,
            timeout_s=self._health_timeout_s,
            is_alive=self._is_alive,
        )

    def _is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def stop(self) -> str:
        """Reap the server and clean up the temp dir. Idempotent.

        Returns the teardown state (``"clean"`` once reaped). Escalates
        SIGTERM -> SIGKILL on the whole process group so nothing is orphaned.
        Always runs — that is the entire point of the context-manager wrapper.
        """
        if self.teardown_state == "clean":
            return self.teardown_state
        try:
            self._terminate_process()
        finally:
            self._close_log()
            self._cleanup_temp_dir()
        self.teardown_state = "clean"
        return self.teardown_state

    def _terminate_process(self) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is not None:
            return  # already exited; nothing to signal
        self._signal_group(proc, signal.SIGTERM)
        try:
            proc.wait(timeout=TEARDOWN_GRACE_S)
            return
        except subprocess.TimeoutExpired:
            self._log("[tryout] server did not exit on SIGTERM; sending SIGKILL")
        self._signal_group(proc, signal.SIGKILL)
        try:
            proc.wait(timeout=TEARDOWN_GRACE_S)
        except subprocess.TimeoutExpired:
            # Last resort: a single-process kill so we don't block forever.
            try:
                proc.kill()
            except OSError:
                pass

    @staticmethod
    def _signal_group(proc: subprocess.Popen, sig: int) -> None:
        # start_new_session=True put the child in its own process group; signal
        # the whole group so any helper subprocesses die with it.
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except (ProcessLookupError, PermissionError):
            try:
                proc.send_signal(sig)
            except OSError:
                pass

    def _close_log(self) -> None:
        if self._log_handle is not None:
            try:
                self._log_handle.flush()
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None

    def _cleanup_temp_dir(self) -> None:
        if self._temp_dir is not None and self._temp_dir.exists():
            shutil.rmtree(self._temp_dir, ignore_errors=True)
        self._temp_dir = None

    # -- best-known facts (valid even when start() raised mid-boot) --------

    @property
    def server_log_path(self) -> Path | None:
        """The server.log path if it was opened (exists even on a boot failure)."""
        log_path = self._out_dir / "server.log"
        return log_path if log_path.exists() else None

    @property
    def db_path(self) -> Path | None:
        return self._db_path

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc is not None else None

    # -- context manager ---------------------------------------------------

    def __enter__(self) -> "ServerProcess":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.stop()
        return False  # never swallow exceptions; teardown is a side effect
