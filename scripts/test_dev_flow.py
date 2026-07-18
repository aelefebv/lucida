#!/usr/bin/env python3
"""Regression tests for local development and delivery contracts."""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "wasm-dev-fingerprint.sh"
DELIVERY_VALIDATOR_PATH = ROOT / "scripts" / "validate-delivery-contracts.py"


def load_delivery_validator():
    spec = importlib.util.spec_from_file_location(
        "lucida_validate_delivery_contracts",
        DELIVERY_VALIDATOR_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load delivery validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DELIVERY_VALIDATOR = load_delivery_validator()


class DeliveryValidatorMutationTests(unittest.TestCase):
    def test_each_required_kubernetes_volume_ownership_field_is_fail_closed(self) -> None:
        deployment = (ROOT / "extras/deploy/k8s/deployment.yaml").read_text()
        DELIVERY_VALIDATOR.validate_kubernetes_pod_security_context(deployment)

        for field in ("fsGroup", "fsGroupChangePolicy"):
            with self.subTest(field=field):
                mutated, replacements = re.subn(
                    rf"(?m)^        {field}:.*\n",
                    "",
                    deployment,
                    count=1,
                )
                self.assertEqual(replacements, 1)
                with self.assertRaisesRegex(AssertionError, field):
                    DELIVERY_VALIDATOR.validate_kubernetes_pod_security_context(mutated)

    def test_container_scoped_fs_group_markers_cannot_satisfy_the_pod_contract(self) -> None:
        deployment = (ROOT / "extras/deploy/k8s/deployment.yaml").read_text()
        mutated = re.sub(
            r"(?m)^        fsGroup(?:ChangePolicy)?:.*\n",
            "",
            deployment,
        )
        mutated = mutated.replace(
            "          securityContext:\n            allowPrivilegeEscalation:",
            "          securityContext:\n"
            "            fsGroup: 10001\n"
            "            fsGroupChangePolicy: OnRootMismatch\n"
            "            allowPrivilegeEscalation:",
            1,
        )
        self.assertIn("            fsGroup: 10001", mutated)
        with self.assertRaisesRegex(AssertionError, "fsGroup"):
            DELIVERY_VALIDATOR.validate_kubernetes_pod_security_context(mutated)

    def test_mounted_child_guard_omission_is_rejected(self) -> None:
        compose = (ROOT / "extras/deploy/docker-compose.yml").read_text()
        DELIVERY_VALIDATOR.validate_compose_volume_migration_contract(compose)

        guard = 'test "$${path_device}" = "$${volume_device}" || {'
        self.assertEqual(compose.count(guard), 1)
        mutated = compose.replace(guard, "true || {", 1)
        with self.assertRaisesRegex(AssertionError, "volume-migration contract"):
            DELIVERY_VALIDATOR.validate_compose_volume_migration_contract(mutated)

    def test_mounted_child_guard_must_precede_ownership_traversal(self) -> None:
        compose = (ROOT / "extras/deploy/docker-compose.yml").read_text()
        guard_block = (
            '            test "$${path_device}" = "$${volume_device}" || {\n'
            '              echo "refusing separately mounted application path: '
            '$${path}" >&2\n'
            "              exit 66\n"
            "            }\n"
        )
        traversal = '            find "$${path}" -xdev -exec chown -h 10001:10001 {} +\n'
        self.assertIn(guard_block, compose)
        self.assertIn(traversal, compose)
        mutated = compose.replace(guard_block, "", 1).replace(
            traversal,
            traversal + guard_block,
            1,
        )
        with self.assertRaisesRegex(AssertionError, "before any ownership traversal"):
            DELIVERY_VALIDATOR.validate_compose_volume_migration_contract(mutated)


class WasmFingerprintTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self._tempdir.name)
        for directory in (
            "lucida-core/src",
            "lucida-core/pkg",
            "lucida-protocol/src",
            "scripts",
        ):
            (self.repo / directory).mkdir(parents=True, exist_ok=True)

        files = {
            "Cargo.toml": "[workspace]\nmembers = ['lucida-core', 'lucida-protocol']\n",
            "Cargo.lock": "version = 4\n",
            "rust-toolchain.toml": "[toolchain]\nchannel = '1.95.0'\n",
            "lucida-core/Cargo.toml": "[package]\nname = 'lucida-core'\nversion = '0.1.0'\n",
            "lucida-protocol/Cargo.toml": "[package]\nname = 'lucida-protocol'\nversion = '0.1.0'\n",
            "lucida-core/src/lib.rs": "pub fn core() {}\n",
            "lucida-protocol/src/fetch.rs": "pub fn fetch() {}\n",
            "scripts/dev.sh": "wasm-pack build --target web --out-dir pkg -- --locked\n",
        }
        for relative, content in files.items():
            (self.repo / relative).write_text(content)
        shutil.copyfile(HELPER, self.repo / "scripts" / "wasm-dev-fingerprint.sh")

        artifacts = {
            "lucida_core_bg.wasm": b"wasm-v1",
            "lucida_core.js": b"javascript-v1",
            "lucida_core.d.ts": b"types-v1",
            "lucida_core_bg.wasm.d.ts": b"wasm-types-v1",
            "package.json": b'{"name":"lucida-core"}\n',
        }
        for name, content in artifacts.items():
            (self.repo / "lucida-core" / "pkg" / name).write_bytes(content)

    def tearDown(self) -> None:
        self._tempdir.cleanup()

    def fingerprint(self, mode: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["sh", str(HELPER), mode, str(self.repo)],
            check=check,
            capture_output=True,
            text=True,
        )

    def test_every_relevant_source_change_invalidates_the_fingerprint(self) -> None:
        initial = self.fingerprint("source").stdout.strip()
        self.assertEqual(len(initial), 64)

        protocol = self.repo / "lucida-protocol" / "src" / "fetch.rs"
        protocol.write_text("pub fn fetch_changed() {}\n")
        after_protocol_change = self.fingerprint("source").stdout.strip()
        self.assertNotEqual(after_protocol_change, initial)

        workspace_manifest = self.repo / "Cargo.toml"
        workspace_manifest.write_text(workspace_manifest.read_text() + "resolver = '2'\n")
        after_manifest_change = self.fingerprint("source").stdout.strip()
        self.assertNotEqual(after_manifest_change, after_protocol_change)

    def test_stale_or_partial_generated_package_never_matches(self) -> None:
        initial = self.fingerprint("artifacts").stdout.strip()
        wasm = self.repo / "lucida-core" / "pkg" / "lucida_core_bg.wasm"
        wasm.write_bytes(b"stale-wasm")
        self.assertNotEqual(self.fingerprint("artifacts").stdout.strip(), initial)

        wasm.unlink()
        missing = self.fingerprint("artifacts", check=False)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("required file is missing", missing.stderr)

    def test_input_enumeration_failure_is_terminal_not_an_empty_hash(self) -> None:
        (self.repo / "Cargo.lock").unlink()
        result = self.fingerprint("source", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Cargo.lock", result.stderr)


class DevLauncherContractTests(unittest.TestCase):
    def test_busy_ports_block_launch_only_after_fresh_builds(self) -> None:
        script = (ROOT / "scripts" / "dev.sh").read_text()
        self.assertIn("--replace", script)
        self.assertLess(
            script.index('cargo build -p lucida-server'),
            script.index('die "builds are fresh'),
        )
        self.assertIn("LUCIDA_DEV_BACKEND_PORT", script)
        self.assertIn("LUCIDA_DEV_WEB_PORT", script)
        self.assertIn('server.listen({ host: "127.0.0.1", port, exclusive: true }', script)
        self.assertIn('error.code === "EADDRINUSE"', script)

    def test_launcher_requires_source_and_artifact_fingerprints(self) -> None:
        script = (ROOT / "scripts" / "dev.sh").read_text()
        self.assertNotIn("| sort -z", script)
        self.assertIn("wasm-dev-fingerprint.sh source", script)
        self.assertIn("wasm-dev-fingerprint.sh artifacts", script)
        self.assertIn("source=%s\\nartifacts=%s", script)
        self.assertIn("generated package changed outside this build", script)


class DevLauncherExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self._tempdir.name)
        for directory in (
            "lucida-core/src",
            "lucida-web",
            "scripts",
            "fake-bin",
        ):
            (self.repo / directory).mkdir(parents=True, exist_ok=True)

        files = {
            ".node-version": "22.14.0\n",
            "Cargo.toml": "[workspace]\nmembers = ['lucida-core']\n",
            "Cargo.lock": "version = 4\n",
            "rust-toolchain.toml": "[toolchain]\nchannel = '1.95.0'\n",
            "lucida-core/Cargo.toml": "[package]\nname = 'lucida-core'\nversion = '0.1.0'\n",
            "lucida-core/src/lib.rs": "pub fn core() {}\n",
            "lucida-web/package.json": '{"packageManager":"pnpm@9.15.9"}\n',
        }
        for relative, content in files.items():
            (self.repo / relative).write_text(content)
        shutil.copyfile(ROOT / "scripts" / "dev.sh", self.repo / "scripts" / "dev.sh")
        shutil.copyfile(HELPER, self.repo / "scripts" / "wasm-dev-fingerprint.sh")

        self._write_tool(
            "node",
            """#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  printf 'v22.14.0\\n'
elif [ "${1:-}" = "-e" ]; then
  if [ -f .fake-listener-alive ]; then exit 10; fi
  exit 0
else
  printf '9.15.9\\n'
fi
""",
        )
        self._write_tool(
            "rustc",
            """#!/bin/sh
printf 'rustc 1.95.0 (fixture)\\n'
""",
        )
        self._write_tool(
            "corepack",
            """#!/bin/sh
if [ "${1:-}" = "pnpm" ] && [ "${2:-}" = "--version" ]; then
  printf '9.15.9\\n'
fi
exit 0
""",
        )
        self._write_tool(
            "cargo",
            """#!/bin/sh
mkdir -p target/debug
printf '#!/bin/sh\\nexit 0\\n' > target/debug/lucida-server
chmod +x target/debug/lucida-server
touch .fake-server-build-ran
""",
        )
        self._write_tool(
            "wasm-pack",
            """#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  printf 'wasm-pack 0.15.0\\n'
  exit 0
fi
mkdir -p pkg
printf 'wasm' > pkg/lucida_core_bg.wasm
printf 'js' > pkg/lucida_core.js
printf 'types' > pkg/lucida_core.d.ts
printf 'wasm-types' > pkg/lucida_core_bg.wasm.d.ts
printf '{"name":"lucida-core"}\\n' > pkg/package.json
""",
        )
        self._write_tool(
            "lsof",
            """#!/bin/sh
pid="${FAKE_LISTENER_PID:-}"
if [ -n "${pid}" ] && [ -f .fake-listener-alive ]; then
  case " $* " in
    *" -t "*) printf '%s\\n' "${pid}" ;;
    *) printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\nfixture %s user 1u IPv4 0 0t0 TCP *:fixture (LISTEN)\\n' "${pid}" ;;
  esac
  exit 0
fi
exit 1
""",
        )
        self._write_tool(
            "fake-listener",
            """#!/bin/sh
cleanup() { rm -f .fake-listener-alive; }
trap 'cleanup; exit 0' TERM INT
trap cleanup EXIT
: > .fake-listener-alive
while :; do sleep 0.1; done
""",
        )

    def tearDown(self) -> None:
        self._tempdir.cleanup()

    def _write_tool(self, name: str, body: str) -> None:
        path = self.repo / "fake-bin" / name
        path.write_text(body)
        path.chmod(0o755)

    def run_dev(
        self,
        *args: str,
        listener_pid: int | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PATH"] = f"{self.repo / 'fake-bin'}:{env['PATH']}"
        if listener_pid is None:
            env.pop("FAKE_LISTENER_PID", None)
        else:
            env["FAKE_LISTENER_PID"] = str(listener_pid)
        return subprocess.run(
            ["bash", "scripts/dev.sh", *args],
            cwd=self.repo,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )

    def start_listener(self) -> subprocess.Popen[str]:
        listener = subprocess.Popen(
            [str(self.repo / "fake-bin" / "fake-listener")],
            cwd=self.repo,
            text=True,
        )
        deadline = time.monotonic() + 5
        while not (self.repo / ".fake-listener-alive").is_file():
            if listener.poll() is not None:
                self.fail("fake listener exited before becoming ready")
            if time.monotonic() >= deadline:
                listener.terminate()
                self.fail("fake listener did not become ready")
            time.sleep(0.01)
        return listener

    def test_free_ports_reach_launch_under_strict_shell_mode(self) -> None:
        result = self.run_dev()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.repo / ".fake-server-build-ran").is_file())
        self.assertIn("lucida dev is up", result.stdout)

    def test_busy_port_refusal_happens_after_fresh_build(self) -> None:
        listener = self.start_listener()
        try:
            result = self.run_dev(listener_pid=listener.pid)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((self.repo / ".fake-server-build-ran").is_file())
            self.assertIn("builds are fresh", result.stderr)
            self.assertIsNone(listener.poll(), "default mode must not kill a listener")
        finally:
            listener.terminate()
            listener.wait(timeout=5)

    def test_replace_terminates_cooperative_listener_and_launches(self) -> None:
        listener = self.start_listener()
        try:
            result = self.run_dev("--replace", listener_pid=listener.pid)
            self.assertEqual(result.returncode, 0, result.stderr)
            listener.wait(timeout=5)
            self.assertIn("terminating existing dev listener", result.stderr)
            self.assertIn("lucida dev is up", result.stdout)
        finally:
            if listener.poll() is None:
                listener.terminate()
                listener.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
