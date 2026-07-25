"""The retina render gate's judging policy, tested without a browser.

The point of these tests is narrow and specific: prove the gate would have
FAILED against the defect it exists for, and would not fire on a healthy render.
The measurements in the fixtures below are the shape the Node driver emits, so
this exercises the real policy (:func:`judge_render_arm`, :func:`build_render_gate`)
rather than a restatement of it.

Run: ``python3 -m unittest discover -s extras/tryout/tests`` (stdlib only, no
browser, no server), or ``make -C extras/tryout test``.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tryout.surfaces.web_surface import (  # noqa: E402
    CONTENT_MAX_MODAL_FRACTION,
    GATING_SCALE_FACTOR,
    build_render_gate,
    judge_render_arm,
    require_dpr2_from_env,
    scale_factors_from_env,
)


def _region(*, distinct: int, modal: float, colour: list[int], samples: int = 36864) -> dict:
    return {
        "samples": samples,
        "distinct_colors": distinct,
        "modal_fraction": modal,
        "modal_color": colour,
        "nonblack_fraction": 0.0 if colour[:3] == [0, 0, 0] else 1.0,
        "mean_luma": 0.0 if colour[:3] == [0, 0, 0] else 128.0,
        "max_luma": 0.0 if colour[:3] == [0, 0, 0] else 255.0,
    }


def _arm_payload(
    *,
    dsf: int,
    observed_dpr: float | None = None,
    ready: bool = True,
    centre: dict | None = None,
    css_width: float = 1080.0,
    shot_width: float | None = None,
) -> dict:
    """One driver arm record. Defaults describe a HEALTHY retina render."""
    observed = dsf if observed_dpr is None else observed_dpr
    width = css_width * dsf if shot_width is None else shot_width
    return {
        "device_scale_factor": dsf,
        "ran": True,
        "ready": ready,
        "reason": "rendered" if ready else "not_ready: no_frames",
        # The product's own readiness contract — satisfied even by the defect,
        # because it is published from the JS side of a WebGPU submit.
        "render": {
            "ready": ready,
            "reason": "rendered" if ready else "no_frames",
            "frame_count": 148,
            "dataset_count": 1,
            "canvas_width": int(css_width * dsf),
            "canvas_height": int(720 * dsf),
        },
        "metrics": {
            "device_pixel_ratio": observed,
            "canvas_count": 3,
            "canvas_index": 0,
            "css_width": css_width,
            "css_height": 720.0,
            "backing_width": int(css_width * dsf),
            "backing_height": int(720 * dsf),
            "inner_width": 1400,
            "inner_height": 900,
        },
        "content": {
            "width": width,
            "height": 720.0 * dsf,
            "full": _region(distinct=41, modal=0.62, colour=[17, 17, 17, 255]),
            "centre": centre
            if centre is not None
            else _region(distinct=2871, modal=0.09, colour=[62, 71, 88, 255]),
        },
        # The SPA chrome renders fine even when the viewer is black — this is the
        # measurement that made the OLD "spa.png is non-blank" check useless.
        "full_page": {
            "width": 1400.0 * dsf,
            "height": 900.0 * dsf,
            "full": _region(distinct=4102, modal=0.44, colour=[246, 248, 250, 255]),
            "centre": _region(distinct=1200, modal=0.30, colour=[30, 30, 30, 255]),
        },
        "console_messages": 0,
        "duration_s": 11.4,
    }


# The defect: the canvas never presents, so its centre is one flat black. Note
# what is UNCHANGED from the healthy fixture — ready is true, frame_count is
# climbing, the dataset is loaded, there are zero console messages, and the full
# page is richly coloured.
_BLACK_CENTRE = _region(distinct=1, modal=1.0, colour=[0, 0, 0, 255])


class TestJudgeRenderArm(unittest.TestCase):
    def test_healthy_retina_arm_passes(self) -> None:
        arm = judge_render_arm(_arm_payload(dsf=2), device_scale_factor=2, gating=True)
        self.assertTrue(arm.ok, arm.failures)
        self.assertEqual(arm.checks, {"ready": True, "device_scale_factor": True, "content_frame": True})
        self.assertEqual(arm.failures, [])

    def test_black_canvas_fails_even_though_everything_else_looks_healthy(self) -> None:
        """The original defect, verbatim: this is the test that has to fail."""
        payload = _arm_payload(dsf=2, centre=_BLACK_CENTRE)
        arm = judge_render_arm(payload, device_scale_factor=2, gating=True)

        # Every signal the harness used to rely on says "fine":
        self.assertTrue(arm.ready)
        self.assertTrue(payload["render"]["frame_count"] > 0)
        self.assertEqual(payload["console_messages"], 0)
        self.assertTrue(arm.spa_png_nonblank, "the full page is non-blank on a black viewer")
        # ...and the gate still fails it, on the canvas pixels.
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["content_frame"])
        self.assertTrue(arm.checks["ready"])
        self.assertIn("no content frame presented", arm.reason)

    def test_nearly_flat_canvas_fails(self) -> None:
        """A canvas with a couple of stray overlay pixels is still not a render."""
        centre = _region(distinct=3, modal=0.995, colour=[0, 0, 0, 255])
        arm = judge_render_arm(
            _arm_payload(dsf=2, centre=centre), device_scale_factor=2, gating=True
        )
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["content_frame"])
        self.assertGreater(0.995, CONTENT_MAX_MODAL_FRACTION)

    def test_arm_that_silently_ran_at_dpr1_fails(self) -> None:
        """A retina arm that degraded to DPR 1 is not evidence about retina."""
        payload = _arm_payload(dsf=2, observed_dpr=1.0, shot_width=1080.0)
        arm = judge_render_arm(payload, device_scale_factor=2, gating=True)
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["device_scale_factor"])
        self.assertTrue(arm.checks["content_frame"], "the pixels were fine; the scale factor was not")
        self.assertIn("devicePixelRatio 1", arm.reason)

    def test_capture_scaled_wrong_fails_even_when_dpr_reports_right(self) -> None:
        payload = _arm_payload(dsf=2, shot_width=1080.0)
        arm = judge_render_arm(payload, device_scale_factor=2, gating=True)
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["device_scale_factor"])
        self.assertIn("CSS box", arm.reason)

    def test_never_ready_fails(self) -> None:
        payload = _arm_payload(dsf=2, ready=False, centre=_BLACK_CENTRE)
        arm = judge_render_arm(payload, device_scale_factor=2, gating=True)
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["ready"])

    def test_missing_canvas_measurement_fails_closed(self) -> None:
        """No pixels analysed is a failure, never a pass. A gate that cannot see
        must not report success."""
        payload = _arm_payload(dsf=2)
        payload["content"] = None
        arm = judge_render_arm(payload, device_scale_factor=2, gating=True)
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["content_frame"])

    def test_arm_that_did_not_run_is_not_ok_and_not_judged(self) -> None:
        arm = judge_render_arm(
            {"ran": False, "reason": "browser_launch_failed: no such file"},
            device_scale_factor=2,
            gating=True,
        )
        self.assertFalse(arm.ran)
        self.assertFalse(arm.ok)
        self.assertEqual(arm.checks, {})


class TestBuildRenderGate(unittest.TestCase):
    def _arms(self, *, retina_centre: dict | None = None):
        return [
            judge_render_arm(
                _arm_payload(dsf=2, centre=retina_centre), device_scale_factor=2, gating=True
            ),
            judge_render_arm(_arm_payload(dsf=1), device_scale_factor=1, gating=False),
        ]

    def test_retina_arm_decides_the_gate(self) -> None:
        arms = self._arms(retina_centre=_BLACK_CENTRE)
        self.assertFalse(arms[0].ok)
        self.assertTrue(arms[1].ok, "DPR 1 is fine — which is exactly why DPR 1 alone is not enough")
        gate = build_render_gate(arms)
        self.assertFalse(gate["ok"])
        self.assertTrue(gate["gated"])
        self.assertEqual(gate["device_scale_factor"], GATING_SCALE_FACTOR)
        self.assertTrue(gate["failures"])

    def test_healthy_matrix_passes(self) -> None:
        gate = build_render_gate(self._arms())
        self.assertTrue(gate["ok"], gate)
        self.assertTrue(gate["gated"])

    def test_no_browser_is_tolerated_but_reported_as_unenforced(self) -> None:
        gate = build_render_gate([], skip_reason="no Chrome/Chromium found")
        self.assertTrue(gate["ok"])
        self.assertFalse(gate["gated"])
        self.assertIn("NOT enforced", gate["reason"])

    def test_no_browser_fails_when_the_gate_is_required(self) -> None:
        gate = build_render_gate([], skip_reason="no Chrome/Chromium found", require=True)
        self.assertFalse(gate["ok"])
        self.assertFalse(gate["gated"])

    def test_a_dpr1_only_matrix_never_reports_an_enforced_gate(self) -> None:
        """Overriding the matrix to DPR 1 must not look like a passing gate."""
        arms = [judge_render_arm(_arm_payload(dsf=1), device_scale_factor=1, gating=False)]
        gate = build_render_gate(arms)
        self.assertFalse(gate["gated"])


class TestEnvOverrides(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {
            key: os.environ.pop(key, None)
            for key in ("LUCIDA_TRYOUT_SCALE_FACTORS", "LUCIDA_TRYOUT_REQUIRE_DPR2")
        }

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_default_matrix_leads_with_the_gating_factor(self) -> None:
        self.assertEqual(scale_factors_from_env(), [2, 1])

    def test_explicit_override(self) -> None:
        os.environ["LUCIDA_TRYOUT_SCALE_FACTORS"] = "1, 2 ,2"
        self.assertEqual(scale_factors_from_env(), [1, 2])

    def test_a_typo_falls_back_to_the_default_rather_than_dropping_the_gate(self) -> None:
        os.environ["LUCIDA_TRYOUT_SCALE_FACTORS"] = "2,x"
        self.assertEqual(scale_factors_from_env(), [2, 1])

    def test_require_flag(self) -> None:
        self.assertFalse(require_dpr2_from_env())
        os.environ["LUCIDA_TRYOUT_REQUIRE_DPR2"] = "1"
        self.assertTrue(require_dpr2_from_env())


if __name__ == "__main__":
    unittest.main()
