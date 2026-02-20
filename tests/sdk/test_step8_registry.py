from __future__ import annotations

from pathlib import Path
import sys
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_daemon import default_local_ipc_uri
from lucida_sdk import NotFound, connect, launch_or_connect, shutdown_local_daemon
from lucida_sdk.registry import clear_local_daemon_registry, local_daemon_count


class Step8RegistryTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_local_daemon_registry()

    def _unique_ipc_uri(self) -> str:
        app_name = f"lucida-step8-reg-{uuid.uuid4().hex[:8]}"
        return default_local_ipc_uri(app_name=app_name)

    def test_launch_or_connect_reuses_daemon_for_same_uri(self) -> None:
        local_ipc_uri = self._unique_ipc_uri()
        self.assertEqual(local_daemon_count(), 0)

        first = launch_or_connect(local_ipc_uri=local_ipc_uri)
        second = launch_or_connect(local_ipc_uri=local_ipc_uri)
        self.assertEqual(local_daemon_count(), 1)

        first.close()
        second.close()

        reconnect = connect(local_ipc_uri=local_ipc_uri)
        session = reconnect.session_create(label="reg-reconnect")
        self.assertIn("session_id", session)
        reconnect.close()

    def test_connect_requires_existing_registry_entry(self) -> None:
        with self.assertRaises(NotFound):
            connect(local_ipc_uri=self._unique_ipc_uri())

    def test_shutdown_local_daemon_is_explicit(self) -> None:
        local_ipc_uri = self._unique_ipc_uri()
        client = launch_or_connect(local_ipc_uri=local_ipc_uri)
        client.close()
        self.assertEqual(local_daemon_count(), 1)
        self.assertTrue(shutdown_local_daemon(local_ipc_uri=local_ipc_uri))
        self.assertFalse(shutdown_local_daemon(local_ipc_uri=local_ipc_uri))
        self.assertEqual(local_daemon_count(), 0)


if __name__ == "__main__":
    unittest.main()

