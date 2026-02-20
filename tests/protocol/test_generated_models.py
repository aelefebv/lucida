from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]


class GeneratedModelsTests(unittest.TestCase):
    def test_generated_models_are_fresh(self) -> None:
        script = ROOT / "python/lucida_sdk/protocol/generate_models.py"
        result = subprocess.run(
            [sys.executable, str(script), "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_generated_module_imports(self) -> None:
        module_path = ROOT / "python/lucida_sdk/protocol/generated/models.py"
        spec = importlib.util.spec_from_file_location("lucida_generated_models", module_path)
        self.assertIsNotNone(spec)
        assert spec is not None
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        self.assertTrue(hasattr(module, "SCHEMA_DIGEST"))
        digest = getattr(module, "SCHEMA_DIGEST")
        self.assertIsInstance(digest, str)
        self.assertEqual(len(digest), 64)

    def test_sdk_rpc_method_coverage_matches_openrpc(self) -> None:
        sys.path.insert(0, str(ROOT / "python"))
        from lucida_sdk.client import LucidaClient, RPC_METHODS

        openrpc = json.loads((ROOT / "protocol/openrpc/lucida.v1.openrpc.json").read_text(encoding="utf-8"))
        expected_methods = [method["name"] for method in openrpc["methods"]]
        self.assertEqual(list(RPC_METHODS), expected_methods)

        for method_name in expected_methods:
            with self.subTest(method=method_name):
                method_attr = method_name.replace(".", "_")
                self.assertTrue(hasattr(LucidaClient, method_attr))
                self.assertTrue(callable(getattr(LucidaClient, method_attr)))


if __name__ == "__main__":
    unittest.main()
