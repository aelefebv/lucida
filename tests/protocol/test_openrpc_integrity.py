from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


def _ref_def_name(ref: str) -> str:
    if "#/$defs/" not in ref:
        raise AssertionError(f"expected $defs ref: {ref}")
    return ref.split("#/$defs/")[-1]


class OpenRpcIntegrityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.openrpc_path = ROOT / "protocol/openrpc/lucida.v1.openrpc.json"
        self.requests_path = ROOT / "protocol/schemas/requests/methods.request.schema.json"
        self.responses_path = ROOT / "protocol/schemas/responses/methods.response.schema.json"
        self.golden_methods_path = ROOT / "tests/protocol/golden/openrpc_methods_v1.json"

        self.openrpc = json.loads(self.openrpc_path.read_text(encoding="utf-8"))
        self.requests = json.loads(self.requests_path.read_text(encoding="utf-8"))
        self.responses = json.loads(self.responses_path.read_text(encoding="utf-8"))
        self.golden_methods = json.loads(self.golden_methods_path.read_text(encoding="utf-8"))

    def test_method_names_match_golden_set(self) -> None:
        actual = [method["name"] for method in self.openrpc["methods"]]
        self.assertEqual(actual, self.golden_methods)
        self.assertEqual(len(actual), len(set(actual)))

    def test_every_method_has_request_and_response_refs(self) -> None:
        for method in self.openrpc["methods"]:
            with self.subTest(method=method["name"]):
                params = method.get("params", [])
                self.assertEqual(len(params), 1)
                param_ref = params[0]["schema"]["$ref"]
                result_ref = method["result"]["schema"]["$ref"]
                req_def = _ref_def_name(param_ref)
                res_def = _ref_def_name(result_ref)
                self.assertIn(req_def, self.requests["$defs"])
                self.assertIn(res_def, self.responses["$defs"])

    def test_all_request_and_response_defs_are_referenced(self) -> None:
        referenced_req_defs: set[str] = set()
        referenced_res_defs: set[str] = set()

        for method in self.openrpc["methods"]:
            params = method["params"][0]
            referenced_req_defs.add(_ref_def_name(params["schema"]["$ref"]))
            referenced_res_defs.add(_ref_def_name(method["result"]["schema"]["$ref"]))

        self.assertEqual(referenced_req_defs, set(self.requests["$defs"].keys()))
        self.assertEqual(referenced_res_defs, set(self.responses["$defs"].keys()))

    def test_openrpc_contract_version(self) -> None:
        self.assertEqual(self.openrpc["openrpc"], "1.2.6")
        self.assertEqual(self.openrpc["info"]["version"], "1.0.0")


if __name__ == "__main__":
    unittest.main()
