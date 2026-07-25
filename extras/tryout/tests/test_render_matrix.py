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

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tryout.cli import (  # noqa: E402
    _emit_drive_human,
    _emit_report_human,
    _web_summary_detail,
)
from tryout.drive import surface_render_gate_failed  # noqa: E402
from tryout.report import _web_display_ok, render_html, render_markdown  # noqa: E402
from tryout.surfaces import web_surface  # noqa: E402
from tryout.surfaces.web_surface import (  # noqa: E402
    CONTENT_MAX_MODAL_FRACTION,
    GATING_SCALE_FACTOR,
    RealSpaResult,
    WebSurfaceResult,
    build_render_gate,
    capture_real_spa,
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
        "completed": True,
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
        self.assertEqual(
            arm.checks,
            {
                "attempt_completed": True,
                "ready": True,
                "device_scale_factor": True,
                "content_frame": True,
            },
        )
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

    def test_an_arm_that_errored_mid_flight_is_judged_and_fails(self) -> None:
        """A renderer/GPU death at 4x backing store must not read as "no browser".

        The arm was attempted against a live browser and threw, so it carries
        ``ran`` (attempted) but not ``completed`` (measured). It has no metrics
        and no pixels, and every check fails closed.
        """
        arm = judge_render_arm(
            {
                "device_scale_factor": 2,
                "ran": True,
                "completed": False,
                "reason": "arm_failed: page.goto: Timeout 120000ms exceeded",
                "console_messages": 0,
            },
            device_scale_factor=2,
            gating=True,
        )
        self.assertTrue(arm.ran)
        self.assertFalse(arm.completed)
        self.assertFalse(arm.ok)
        self.assertFalse(arm.checks["attempt_completed"])
        self.assertFalse(arm.checks["content_frame"])
        self.assertIn("errored before it could be measured", arm.reason)


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

    # --- the two ways a gate can decline to answer ------------------------- #
    # Only one of them is allowed to resolve to "pass".

    def test_an_errored_retina_arm_fails_the_gate_rather_than_skipping_it(self) -> None:
        """The reachable fail-open: a retina-only wedge (goto timeout, renderer
        crash under the 4x backing store) while DPR 1 stays healthy."""
        errored = judge_render_arm(
            {
                "device_scale_factor": 2,
                "ran": True,
                "completed": False,
                "reason": "arm_failed: page.goto: Timeout 120000ms exceeded",
            },
            device_scale_factor=2,
            gating=True,
        )
        healthy = judge_render_arm(_arm_payload(dsf=1), device_scale_factor=1, gating=False)
        self.assertTrue(healthy.ok, "DPR 1 is fine — the wedge is retina-only")
        gate = build_render_gate([errored, healthy])
        self.assertFalse(gate["ok"])
        self.assertTrue(gate["gated"], "a browser was there; the gate is owed an answer")

    def test_a_retina_arm_that_never_started_still_fails_if_a_browser_launched(self) -> None:
        """``ran`` is the signal, and only ``ran``.

        The driver cannot emit ``ran: false`` — it sets ``ran`` *before* an arm's
        work, so every record it returns is an attempt. An unrun arm therefore
        only ever comes from ``capture_real_spa``, which synthesises a placeholder
        (no ``ran`` key, carrying the driver's own reason) for a requested factor
        the driver returned no record for. That is the payload used here; see
        ``test_a_driver_that_returns_no_retina_record_fails_closed`` for the same
        case driven through the real pairing code.
        """
        driver_reason = "drove the SPA at deviceScaleFactor 1"
        placeholder = judge_render_arm(
            {"reason": driver_reason}, device_scale_factor=2, gating=True
        )
        healthy = judge_render_arm(_arm_payload(dsf=1), device_scale_factor=1, gating=False)
        self.assertFalse(placeholder.ran)
        self.assertTrue(healthy.ran, "the browser was up — the gate is owed an answer")
        gate = build_render_gate([placeholder, healthy], skip_reason=driver_reason)
        self.assertFalse(gate["ok"])
        self.assertTrue(gate["gated"])
        self.assertIn("produced no verdict", gate["reason"])
        self.assertIn(driver_reason, gate["reason"], "the driver's own explanation survives")
        self.assertNotIn("NOT enforced", gate["reason"])

    def test_a_full_length_matrix_where_nothing_ran_is_still_a_tolerated_skip(self) -> None:
        """The length of ``arms`` is not evidence that a browser started.

        A host whose browser will not launch (Chrome on disk, system libraries
        missing; a sandbox it cannot enter) gets a placeholder for *every*
        requested factor, so the matrix is full length and nothing in it ran.
        That is the environment fact the skip exists for, and reading it as "a
        browser was live" fails every such host on a condition it cannot fix.
        """
        reason = "browser_launch_failed: libnss3.so: cannot open shared object file"
        arms = [
            judge_render_arm({"reason": reason}, device_scale_factor=dsf, gating=(dsf == 2))
            for dsf in (2, 1)
        ]
        self.assertEqual(len(arms), 2)
        self.assertFalse(any(arm.ran for arm in arms))
        gate = build_render_gate(arms, skip_reason=reason)
        self.assertTrue(gate["ok"])
        self.assertFalse(gate["gated"])
        self.assertIn("NOT enforced", gate["reason"])
        self.assertIn("libnss3", gate["reason"])
        self.assertFalse(surface_render_gate_failed({"render_gate": gate}))
        # ...and the opt-in still makes that host fail, without ever claiming a
        # browser was there.
        required = build_render_gate(arms, skip_reason=reason, require=True)
        self.assertFalse(required["ok"])
        self.assertFalse(required["gated"])

    def test_the_browser_fact_may_be_supplied_instead_of_inferred(self) -> None:
        """Both directions of ``browser_drove_an_arm``, from one matrix.

        The arms are identical placeholders. Inferring from them says no browser
        was up, and skipping is right. Told by the caller that the driver did
        drive an arm — the raw records say so even though none of them paired —
        the same matrix owes a verdict and fails.
        """
        arms = [
            judge_render_arm({"reason": "no record"}, device_scale_factor=dsf, gating=(dsf == 2))
            for dsf in (2, 1)
        ]
        inferred = build_render_gate(arms, skip_reason="no arm ran")
        self.assertTrue(inferred["ok"])
        self.assertFalse(inferred["gated"])
        told = build_render_gate(arms, skip_reason="no arm ran", browser_drove_an_arm=True)
        self.assertFalse(told["ok"])
        self.assertTrue(told["gated"])


class TestCaptureFailsClosed(unittest.TestCase):
    """The other fail-open: ``capture_real_spa``'s own no-answer branches.

    By the time these fire, node was found, Playwright resolved and a browser
    path resolved — so a driver that dies without printing a result is not an
    environment fact, and must not be treated like one.
    """

    def _capture(self, run_group):
        # Pin the matrix to the default (2, 1) regardless of the caller's shell.
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(
                    os.environ,
                    {"LUCIDA_TRYOUT_SCALE_FACTORS": "", "LUCIDA_TRYOUT_REQUIRE_DPR2": ""}), \
                mock.patch.object(web_surface.shutil, "which", return_value="/usr/bin/node"), \
                mock.patch.object(web_surface, "_ensure_playwright", return_value=Path(tmp)), \
                mock.patch.object(
                    web_surface, "_system_browser_path", return_value="/usr/bin/chromium"), \
                mock.patch.object(web_surface, "run_group", run_group):
            return capture_real_spa(
                url="http://127.0.0.1:1/", web_out=Path(tmp), log=lambda *a, **k: None
            )

    @staticmethod
    def _driver_says(payload: dict) -> subprocess.CompletedProcess:
        """One driver run, printing the result line the shipped driver prints."""
        return subprocess.CompletedProcess(
            args=["node"], returncode=0, stdout=json.dumps(payload) + "\n", stderr=""
        )

    def test_a_browser_that_cannot_launch_is_a_tolerated_skip(self) -> None:
        """Chrome on disk, but it never starts — an environment fact, not a defect.

        The driver exits 0 having printed an empty ``arms`` list, and capture
        still builds a placeholder per requested factor. The matrix is therefore
        full length with nothing in it run, and this host must read
        "NOT enforced" and leave the run's exit code alone.
        """
        payload = {
            "captured": False,
            "reason": "browser_launch_failed: Target page, context or browser has been closed",
            "arms": [],
        }
        result = self._capture(mock.Mock(return_value=self._driver_says(payload)))
        self.assertEqual([arm.device_scale_factor for arm in result.arms], [2, 1])
        self.assertFalse(any(arm.ran for arm in result.arms))
        self.assertTrue(result.gate["ok"])
        self.assertFalse(result.gate["gated"])
        self.assertIn("NOT enforced", result.gate["reason"])
        self.assertIn("browser_launch_failed", result.gate["reason"])
        self.assertFalse(surface_render_gate_failed({"render_gate": result.gate}))

    def test_a_driver_that_returns_no_retina_record_fails_closed(self) -> None:
        """A browser that drove DPR 1 and returned nothing for DPR 2 owes an answer."""
        payload = {
            "captured": True,
            "reason": "drove the SPA at deviceScaleFactor 1",
            "arms": [_arm_payload(dsf=1)],
        }
        result = self._capture(mock.Mock(return_value=self._driver_says(payload)))
        retina = next(arm for arm in result.arms if arm.gating)
        self.assertFalse(retina.ran)
        self.assertTrue(any(arm.ran for arm in result.arms))
        self.assertFalse(result.gate["ok"])
        self.assertTrue(result.gate["gated"])
        self.assertIn("produced no verdict", result.gate["reason"])
        self.assertTrue(surface_render_gate_failed({"render_gate": result.gate}))

    def test_arms_are_paired_by_the_scale_factor_they_name(self) -> None:
        """Never by list position: a reordered list must not relabel the pixels.

        Here the black canvas belongs to DPR 2 but arrives at index 1. Pairing by
        position would hand the retina arm DPR 1's healthy pixels and pass.
        """
        payload = {
            "captured": True,
            "reason": "drove the SPA at deviceScaleFactor 1 and 2",
            "arms": [_arm_payload(dsf=1), _arm_payload(dsf=2, centre=_BLACK_CENTRE)],
        }
        result = self._capture(mock.Mock(return_value=self._driver_says(payload)))
        retina = next(arm for arm in result.arms if arm.gating)
        self.assertEqual(retina.device_scale_factor, 2)
        self.assertTrue(retina.ran)
        self.assertFalse(retina.checks["content_frame"])
        self.assertFalse(result.gate["ok"])
        self.assertTrue(result.gate["gated"])

    def test_pairing_that_matches_nothing_fails_closed(self) -> None:
        """The pairing defence must not fail quiet where it aims.

        A driver/Python contract mismatch — records naming factors nobody asked
        for — leaves every paired arm a placeholder. Inferring "was a browser
        up?" from those placeholders would answer "no" over a payload that says
        two arms were driven, and report NOT ENFORCED on a live browser. The
        answer is taken from the raw records instead.
        """
        payload = {
            "captured": True,
            "reason": "drove the SPA at deviceScaleFactor 3 and 4",
            "arms": [_arm_payload(dsf=3), _arm_payload(dsf=4)],
        }
        result = self._capture(mock.Mock(return_value=self._driver_says(payload)))
        self.assertFalse(any(arm.ran for arm in result.arms), "nothing paired")
        self.assertFalse(result.gate["ok"])
        self.assertTrue(result.gate["gated"])
        self.assertNotIn("NOT enforced", result.gate["reason"])
        self.assertIn("it named 3, 4", result.gate["reason"], "the mismatch is named")
        self.assertTrue(surface_render_gate_failed({"render_gate": result.gate}))

    def test_two_records_claiming_the_same_scale_factor_fail_closed(self) -> None:
        """A conflicting duplicate is a contract violation, and one may be black.

        Keeping the first and dropping the second would pass this matrix on a
        black retina canvas. The factor goes unanswered instead, which the gate
        treats as the failure it is.
        """
        payload = {
            "captured": True,
            "reason": "drove the SPA at deviceScaleFactor 2 and 2",
            "arms": [_arm_payload(dsf=2), _arm_payload(dsf=2, centre=_BLACK_CENTRE)],
        }
        result = self._capture(mock.Mock(return_value=self._driver_says(payload)))
        retina = next(arm for arm in result.arms if arm.gating)
        self.assertFalse(retina.ran)
        self.assertFalse(result.gate["ok"])
        self.assertTrue(result.gate["gated"])
        self.assertIn("more than one record", result.gate["reason"])

    def test_a_driver_that_prints_no_result_fails_closed(self) -> None:
        completed = subprocess.CompletedProcess(args=["node"], returncode=1, stdout="", stderr="")
        result = self._capture(mock.Mock(return_value=completed))
        self.assertFalse(result.gate["ok"])
        self.assertTrue(result.gate["gated"])
        self.assertIn("produced no result", result.gate["reason"])

    def test_a_timed_out_matrix_fails_closed(self) -> None:
        error = subprocess.TimeoutExpired(cmd=["node"], timeout=360.0, output=b"", stderr=b"")
        result = self._capture(mock.Mock(side_effect=error))
        self.assertFalse(result.gate["ok"])
        self.assertTrue(result.gate["gated"])

    def test_no_browser_is_still_a_tolerated_skip(self) -> None:
        """The one state that may resolve to pass, and it still says so out loud."""
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(web_surface.shutil, "which", return_value="/usr/bin/node"), \
                mock.patch.object(web_surface, "_ensure_playwright", return_value=Path(tmp)), \
                mock.patch.object(web_surface, "_system_browser_path", return_value=None):
            result = capture_real_spa(
                url="http://127.0.0.1:1/", web_out=Path(tmp), log=lambda *a, **k: None
            )
        self.assertTrue(result.gate["ok"])
        self.assertFalse(result.gate["gated"])
        self.assertIn("NOT enforced", result.gate["reason"])


class TestGateReachesTheRunVerdict(unittest.TestCase):
    """A gate that prints FAIL under an OK headline and exits 0 is a suggestion.

    These cover the two places the verdict has to travel: the run's exit code
    (:func:`surface_render_gate_failed`) and the one-line human summary.
    """

    def test_a_failed_gate_fails_the_run(self) -> None:
        self.assertTrue(
            surface_render_gate_failed({"ok": True, "render_gate": {"ok": False, "gated": True}})
        )

    def test_a_passing_or_unenforced_gate_does_not(self) -> None:
        self.assertFalse(
            surface_render_gate_failed({"render_gate": {"ok": True, "gated": True}})
        )
        self.assertFalse(
            surface_render_gate_failed({"render_gate": {"ok": True, "gated": False}}),
            "an unenforced gate is reported loudly, but it is not a failure",
        )

    def test_surfaces_without_a_gate_are_untouched(self) -> None:
        """No broadening of failure semantics for unrelated surface conditions."""
        self.assertFalse(surface_render_gate_failed({"ok": False, "passed": 3, "total": 7}))
        self.assertFalse(surface_render_gate_failed({"render_gate": None}))

    def test_the_human_summary_leads_with_the_gate_not_the_floor(self) -> None:
        """`viewer non-blank` next to FAIL is the exact signal this gate exists
        to stop showing — the floor's check is what passes a black viewer."""
        surf = {
            "viewer_png_nonblank": True,
            "render_gate": {
                "ok": False,
                "gated": True,
                "reason": "the canvas centre is one flat colour rgba(0, 0, 0, 255)",
            },
        }
        detail = _web_summary_detail(surf)
        self.assertIn("retina render gate FAILED", detail)
        self.assertNotIn("viewer non-blank", detail)

    def test_the_human_summary_still_names_the_floor_when_the_gate_holds(self) -> None:
        detail = _web_summary_detail(
            {"viewer_png_nonblank": True, "render_gate": {"ok": True, "gated": True}}
        )
        self.assertIn("viewer non-blank", detail)
        self.assertIn("held", detail)

    def _web_line(self, emit, surf: dict) -> str:
        record = {"ok": False, "surfaces": {"web": surf}}
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            emit(record) if emit is _emit_report_human else emit(record, lambda *a, **k: None)
        return next(
            line for line in buffer.getvalue().splitlines() if line.strip().startswith("web")
        )

    def _web_verdict(self, emit, surf: dict) -> str:
        """Just the verdict WORD, so a reassuring token can't hide behind a
        failure printed later in the same line."""
        return self._web_line(emit, surf).split(":", 1)[1].strip().split(" (")[0]

    @staticmethod
    def _web_record(*, retina_centre: dict | None = None, captured: bool = True) -> dict:
        """A web surface record assembled the way the surface assembles one.

        ``ok`` is the floor and only the floor (a non-blank ``viewer.png``); the
        gate travels beside it in ``render_gate``. Built through the real
        dataclasses so this stays a record the shipped code can produce.
        """
        arms = [
            judge_render_arm(
                _arm_payload(dsf=2, centre=retina_centre), device_scale_factor=2, gating=True
            ),
            judge_render_arm(_arm_payload(dsf=1), device_scale_factor=1, gating=False),
        ]
        real_spa = RealSpaResult(
            captured=captured,
            reason="drove the SPA at deviceScaleFactor 2 and 1",
            arms=arms if captured else [],
            gate=(
                build_render_gate(arms, browser_drove_an_arm=True)
                if captured
                else build_render_gate([], skip_reason="no Chrome/Chromium found")
            ),
        )
        web = WebSurfaceResult(
            ran=True,
            ok=True,  # the FLOOR held — which is exactly what a black viewer does
            out_dir="/tmp/out",
            viewer_png="/tmp/out/web/viewer.png",
            viewer_png_nonblank=True,
            viewer_url="http://127.0.0.1:1/w/1",
            captures=[],
            real_spa=real_spa,
        )
        return web.to_dict()

    def test_the_verdict_word_never_says_pass_beside_a_failed_gate(self) -> None:
        """The floor's ``ok`` is not the whole verdict, and the word must not say so.

        The web surface's ``ok`` means the floor held — and the floor is exactly
        what passes a black viewer. Printing PASS from it, beside a failed gate,
        in a run that exits non-zero, is the reassuring word this whole change is
        about not printing.
        """
        surf = self._web_record(retina_centre=_BLACK_CENTRE)
        self.assertTrue(surf["ok"], "the floor held: that is the trap")
        self.assertFalse(surf["render_gate"]["ok"])
        for emit in (_emit_report_human, _emit_drive_human):
            with self.subTest(emit=emit.__name__):
                self.assertEqual(self._web_verdict(emit, surf), "FAIL")
                self.assertNotIn("viewer non-blank", self._web_line(emit, surf))

    def test_the_verdict_word_still_says_pass_when_everything_held(self) -> None:
        surf = self._web_record()
        self.assertTrue(surf["render_gate"]["ok"])
        self.assertEqual(self._web_verdict(_emit_report_human, surf), "PASS")
        self.assertEqual(self._web_verdict(_emit_drive_human, surf), "ok")
        self.assertIn("held", self._web_line(_emit_drive_human, surf))

    def test_an_unenforced_gate_does_not_turn_the_verdict_word_into_a_failure(self) -> None:
        """A host with no browser is not a failing host."""
        surf = self._web_record(captured=False)
        self.assertFalse(surf["render_gate"]["gated"])
        self.assertEqual(self._web_verdict(_emit_report_human, surf), "PASS")
        self.assertIn("NOT ENFORCED", self._web_line(_emit_report_human, surf))

    def test_the_report_web_heading_reflects_the_gate_too(self) -> None:
        """Same rule in `report.html` / `report.md`: no PASS above a failed gate."""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for centre, expected in ((_BLACK_CENTRE, "FAIL"), (None, "PASS")):
                surf = self._web_record(retina_centre=centre)
                record = {"ok": expected == "PASS", "surfaces": {"web": surf}}
                markdown = render_markdown(record, summary={}, versions={}, out_dir=out)
                heading = next(
                    line for line in markdown.splitlines() if line.startswith("## Web surface")
                )
                html = render_html(record, summary={}, versions={}, out_dir=out)
                web_header = html.split("Web surface (rendered viewer)", 1)[1][:120]
                with self.subTest(gate=expected):
                    self.assertTrue(surf["ok"], "the floor held in both cases")
                    self.assertIn(expected, heading)
                    self.assertIn(expected, web_header)

    def test_the_report_heading_and_the_exit_code_read_one_rule(self) -> None:
        """Whatever shape the gate arrives in, the heading and the run agree.

        "Did the gate fail?" is one rule, and this pins that the report asks it
        rather than keeping a private copy — a copy is free to drift, and the
        one that existed already had: it also honoured a gate found under
        ``real_spa.gate``, which the run verdict does not read, so a record of
        that shape printed FAIL headings over a run that exited 0.
        """
        shapes = {
            "failed": {"ok": False, "gated": True, "reason": "black at retina"},
            "held": {"ok": True, "gated": True, "reason": "held"},
            "unenforced": {"ok": True, "gated": False, "reason": "no browser here"},
            "absent": None,
        }
        for top_name, top in shapes.items():
            for nested_name, nested in shapes.items():
                web: dict = {
                    "ran": True,
                    "ok": True,
                    "real_spa": {"gate": nested} if nested is not None else {},
                }
                if top is not None:
                    web["render_gate"] = top
                with self.subTest(render_gate=top_name, real_spa_gate=nested_name):
                    self.assertEqual(
                        _web_display_ok(web) is False,
                        surface_render_gate_failed(web),
                        "the report's verdict word and the run verdict disagree",
                    )

    def test_the_surface_always_declares_a_render_gate(self) -> None:
        """Why one rule is enough: ``render_gate`` is never the missing key.

        The report used to fall back to ``real_spa.gate``. That fallback is only
        safe to drop because the surface emits ``render_gate`` on every record it
        can produce — with a real gate when the ceiling ran, and a "not attempted"
        stub when it did not. If that ever stops being true, the tolerance belongs
        in ``surface_render_gate_failed``, where all three callers get it.
        """
        ceiling = RealSpaResult(
            captured=True,
            reason="drove the SPA",
            arms=[],
            gate=build_render_gate([], skip_reason="no browser"),
        )
        for label, real_spa in (("ceiling ran", ceiling), ("ceiling did not", None)):
            with self.subTest(case=label):
                record = WebSurfaceResult(ran=True, ok=True, real_spa=real_spa).to_dict()
                self.assertIn("render_gate", record)
                self.assertIsInstance(record["render_gate"], dict)

    def test_the_human_summary_clips_a_long_reason(self) -> None:
        """The headline stays one line; the full text is printed just below it."""
        reason = (
            "the deviceScaleFactor 2 arm produced no verdict while the browser was driving "
            "other arms: drove the SPA at deviceScaleFactor 1; failed at 2 (arm_failed: "
            "page.goto: Timeout 120000ms exceeded)"
        )
        detail = _web_summary_detail(
            {
                "viewer_png_nonblank": True,
                "render_gate": {"ok": False, "gated": True, "reason": reason},
            }
        )
        self.assertIn("retina render gate FAILED", detail)
        self.assertIn("produced no verdict", detail)
        self.assertTrue(detail.endswith("…"))
        self.assertLess(len(detail), 140)

    def test_the_human_summary_says_unenforced_out_loud(self) -> None:
        detail = _web_summary_detail(
            {"viewer_png_nonblank": True, "render_gate": {"ok": True, "gated": False}}
        )
        self.assertIn("NOT ENFORCED", detail)


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
