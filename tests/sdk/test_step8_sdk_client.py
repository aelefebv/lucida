from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from lucida_daemon import default_local_ipc_uri
from lucida_sdk import connect, launch_or_connect
from lucida_sdk.client import DEFAULT_PROTOCOL_VERSION, LucidaClient, RPC_METHODS
from lucida_sdk.registry import clear_local_daemon_registry


class Step8SdkClientTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_local_daemon_registry()

    def _unique_ipc_uri(self) -> str:
        app_name = f"lucida-step8-sdk-{uuid.uuid4().hex[:8]}"
        return default_local_ipc_uri(app_name=app_name)

    def test_launch_or_connect_auto_hello_and_persistent_daemon(self) -> None:
        local_ipc_uri = self._unique_ipc_uri()
        first = launch_or_connect(local_ipc_uri=local_ipc_uri)
        self.assertEqual(first.protocol_version, DEFAULT_PROTOCOL_VERSION)
        self.assertIsNotNone(first.hello_response)
        assert first.hello_response is not None
        self.assertEqual(first.hello_response["selected_version"], DEFAULT_PROTOCOL_VERSION)

        first_session = first.session_create()
        self.assertIn("session_id", first_session)
        first.close()

        second = connect(local_ipc_uri=local_ipc_uri)
        second_session = second.session_create()
        self.assertIn("session_id", second_session)
        self.assertNotEqual(first_session["session_id"], second_session["session_id"])
        second.close()

    def test_rpc_method_mapping_covers_openrpc(self) -> None:
        openrpc_path = ROOT / "protocol/openrpc/lucida.v1.openrpc.json"
        openrpc = json.loads(openrpc_path.read_text(encoding="utf-8"))
        expected_methods = [method["name"] for method in openrpc["methods"]]
        self.assertEqual(list(RPC_METHODS), expected_methods)
        for method in expected_methods:
            method_attr = method.replace(".", "_")
            with self.subTest(method=method):
                self.assertTrue(hasattr(LucidaClient, method_attr))
                self.assertTrue(callable(getattr(LucidaClient, method_attr)))

    def test_idempotency_auto_generation_and_override(self) -> None:
        client = launch_or_connect(local_ipc_uri=self._unique_ipc_uri())

        fixed_first = client.session_create(idempotency_key="idem-step8-fixed-0001")
        fixed_second = client.session_create(idempotency_key="idem-step8-fixed-0001")
        self.assertEqual(fixed_first["session_id"], fixed_second["session_id"])

        auto_session = client.session_create()
        self.assertNotEqual(fixed_first["session_id"], auto_session["session_id"])

        created_view = client.view_create(session_id=str(auto_session["session_id"]), label="auto-view")
        self.assertIn("view_id", created_view)
        client.close()

    def test_session_scope_wait_for_job_and_aliases(self) -> None:
        client = launch_or_connect(local_ipc_uri=self._unique_ipc_uri())

        with client.session_scope(label="step8-scope") as session_id:
            opened = client.open_dataset(session_id=session_id, uri="synthetic://image", read_only=True)
            job_id = str(opened["job"]["job_id"])
            terminal = client.wait_for_job(
                session_id=session_id,
                job_id=job_id,
                timeout_s=5.0,
                poll_interval_s=0.01,
            )
            self.assertEqual(terminal["state"], "completed")
            view = client.create_view(session_id=session_id, label="scope-view")
            self.assertIn("view_id", view)

        session_state = client.session_get(session_id=session_id)
        self.assertEqual(session_state["state"], "closed")
        client.close()

    def test_command_log_methods_are_exposed_and_executable(self) -> None:
        client = launch_or_connect(local_ipc_uri=self._unique_ipc_uri())
        with client.session_scope(label="step8-command-log") as session_id:
            exported = client.export_command_log(session_id=session_id, destination_uri="memory://sdk-step9-empty.jsonl")
            self.assertEqual(exported["record_count"], 0)

            imported = client.import_command_log(session_id=session_id, source_uri="memory://sdk-step9-empty.jsonl")
            imported_terminal = client.wait_for_job(
                session_id=session_id,
                job_id=str(imported["job"]["job_id"]),
                timeout_s=5.0,
                poll_interval_s=0.01,
            )
            self.assertEqual(imported_terminal["state"], "completed")

            replayed = client.replay_command_log(
                session_id=session_id,
                source_uri="memory://sdk-step9-empty.jsonl",
                dry_run=True,
            )
            replay_terminal = client.wait_for_job(
                session_id=session_id,
                job_id=str(replayed["job"]["job_id"]),
                timeout_s=5.0,
                poll_interval_s=0.01,
            )
            self.assertEqual(replay_terminal["state"], "completed")
        client.close()


if __name__ == "__main__":
    unittest.main()
