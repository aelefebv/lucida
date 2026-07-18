from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


TRYOUT_ROOT = Path(__file__).resolve().parents[1]
if str(TRYOUT_ROOT) not in sys.path:
    sys.path.insert(0, str(TRYOUT_ROOT))

from tryout.surfaces import cli_surface  # noqa: E402


class CliExpectedFailureTests(unittest.TestCase):
    def test_saved_view_self_approval_is_an_exact_denial_assertion(self) -> None:
        steps = cli_surface.plan_saved_view_sharing_steps()
        denial = next(
            step for step in steps if step.name == "saved-view-self-approve-denied"
        )

        self.assertEqual(denial.expected_error_kind, "unauthorized")
        self.assertEqual(denial.expected_exit_code, 3)
        self.assertFalse(denial.allow_failure)

    def test_run_one_accepts_only_the_expected_structured_error(self) -> None:
        step = cli_surface.CliStep(
            "expected-denial",
            ("saved-view", "approve", "proposal"),
            as_json=True,
            expected_error_kind="unauthorized",
            expected_exit_code=3,
        )

        def completed(exit_code: int, kind: str):
            return SimpleNamespace(
                returncode=exit_code,
                stdout="",
                stderr='{"error":{"kind":"' + kind + '","message":"denied"}}',
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(
                cli_surface, "run_group", return_value=completed(3, "unauthorized")
            ):
                result = cli_surface._run_one(
                    index=1,
                    step=step,
                    prefix=["lucida"],
                    base_url="http://127.0.0.1:1",
                    workspace_id="ws",
                    env={},
                    log_dir=root,
                    cwd=root,
                    command_timeout_s=1,
                    log=lambda _message: None,
                )
            self.assertTrue(result.ok)
            self.assertEqual(result.observed_error_kind, "unauthorized")

            with patch.object(
                cli_surface, "run_group", return_value=completed(3, "conflict")
            ):
                wrong_kind = cli_surface._run_one(
                    index=2,
                    step=step,
                    prefix=["lucida"],
                    base_url="http://127.0.0.1:1",
                    workspace_id="ws",
                    env={},
                    log_dir=root,
                    cwd=root,
                    command_timeout_s=1,
                    log=lambda _message: None,
                )
            self.assertFalse(wrong_kind.ok)

            with patch.object(
                cli_surface, "run_group", return_value=completed(0, "unauthorized")
            ):
                unexpected_success = cli_surface._run_one(
                    index=3,
                    step=step,
                    prefix=["lucida"],
                    base_url="http://127.0.0.1:1",
                    workspace_id="ws",
                    env={},
                    log_dir=root,
                    cwd=root,
                    command_timeout_s=1,
                    log=lambda _message: None,
                )
            self.assertFalse(unexpected_success.ok)

    def test_dataset_tour_sets_the_channel_window_before_capture(self) -> None:
        steps = cli_surface.plan_cli_tour(
            workspace_id="ws",
            dataset_id="dataset",
            dataset_name=None,
        )
        contrast = next(step for step in steps if step.name == "channel-contrast")
        first_capture = next(
            index
            for index, step in enumerate(steps)
            if step.name.startswith("saved-view-capture")
        )

        self.assertEqual(
            contrast.args,
            ("channel", "contrast", "dataset", "0", "--min", "0", "--max", "255"),
        )
        self.assertLess(steps.index(contrast), first_capture)


if __name__ == "__main__":
    unittest.main()
