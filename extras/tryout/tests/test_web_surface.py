from __future__ import annotations

import json
import subprocess
import sys
import struct
import tempfile
import unittest
import zlib
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch


TRYOUT_ROOT = Path(__file__).resolve().parents[1]
if str(TRYOUT_ROOT) not in sys.path:
    sys.path.insert(0, str(TRYOUT_ROOT))

from tryout.surfaces import web_surface  # noqa: E402
from tryout.scenarios import _browser  # noqa: E402
from tryout.browser_launch import headless_webgpu_browser_args  # noqa: E402


def write_rgba_png(path: Path, width: int, height: int, pixel) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind)
        checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    rows = b"".join(
        b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(width))
        for y in range(height)
    )
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(data)


def runtime_snapshot(
    *,
    posted: int = 5,
    presented: int = 5,
    pending: int = 0,
    worker_messages: int = 10,
    long_task_count: int = 0,
    long_task_duration_ms: int = 0,
    mode: str = "slice",
) -> dict:
    return {
        "version": 1,
        "mode": mode,
        "loop": {
            "animationFramePending": False,
            "interactiveDirty": False,
            "residencyDirty": False,
        },
        "client": {
            "frames": {
                "posted": posted,
                "presented": presented,
                "pending": pending,
            },
            "worker": {"messages": worker_messages},
            "surface": {
                "byMode": {
                    "slice": {"attempts": 0, "forwarded": 0, "suppressed": 0},
                    "volume": {"attempts": 0, "forwarded": 0, "suppressed": 0},
                    "unspecified": {"attempts": 0, "forwarded": 0, "suppressed": 0},
                },
                "lastSuppressed": None,
                "lastForwarded": None,
            },
        },
        "mainThread": {
            "longTaskObserverSupported": True,
            "longTaskCount": long_task_count,
            "longTaskDurationMs": long_task_duration_ms,
        },
    }


def initial_zero_recovery(target: str) -> dict:
    render_mode = "volume" if target == "3d" else "slice"
    initial = runtime_snapshot(
        posted=0,
        presented=0,
        worker_messages=0,
        mode=render_mode,
    )
    initial["client"]["surface"]["byMode"][render_mode] = {
        "attempts": 1,
        "forwarded": 0,
        "suppressed": 1,
    }
    initial["client"]["surface"]["lastSuppressed"] = {
        "mode": render_mode,
        "width": 0,
        "height": 0,
        "rejection": "non-positive",
    }
    restored = runtime_snapshot(
        posted=1,
        presented=1,
        worker_messages=1,
        mode=render_mode,
    )
    restored["client"]["surface"]["byMode"][render_mode] = {
        "attempts": 2,
        "forwarded": 1,
        "suppressed": 1,
    }
    restored["client"]["surface"]["lastForwarded"] = {
        "mode": render_mode,
        "width": 800,
        "height": 600,
    }
    return {
        "mode": target,
        "contract_version": 1,
        "initial_suppressed": True,
        "initial_invalid_not_forwarded": True,
        "restored_finite_positive": True,
        "restored_forwarded_positive": True,
        "frame_advanced": True,
        "initial": initial,
        "restored": restored,
    }


def later_zero_recovery(target: str) -> dict:
    render_mode = "volume" if target == "3d" else "slice"
    initial = runtime_snapshot(posted=5, presented=5, mode=render_mode)
    initial["client"]["surface"]["byMode"][render_mode] = {
        "attempts": 4,
        "forwarded": 4,
        "suppressed": 0,
    }
    collapsed = deepcopy(initial)
    collapsed["client"]["surface"]["byMode"][render_mode] = {
        "attempts": 5,
        "forwarded": 4,
        "suppressed": 1,
    }
    collapsed["client"]["surface"]["lastSuppressed"] = {
        "mode": render_mode,
        "width": 0,
        "height": 0,
        "rejection": "non-positive",
    }
    restored = runtime_snapshot(posted=6, presented=6, worker_messages=11, mode=render_mode)
    restored["client"]["surface"]["byMode"][render_mode] = {
        "attempts": 6,
        "forwarded": 5,
        "suppressed": 1,
    }
    restored["client"]["surface"]["lastForwarded"] = {
        "mode": render_mode,
        "width": 800,
        "height": 600,
    }
    return {
        "mode": target,
        "contract_version": 1,
        "settled_before": True,
        "collapsed_to_zero": True,
        "collapsed_suppressed": True,
        "collapsed_invalid_not_forwarded": True,
        "restored_finite_positive": True,
        "restored_forwarded_positive": True,
        "frame_advanced": True,
        "initial": initial,
        "collapsed_runtime": collapsed,
        "restored_runtime": restored,
    }


def passing_browser_contract(
    dpr: int,
    *,
    first_run: bool = False,
    collection_required: bool = False,
) -> dict:
    empty_audit = lambda label: {"label": label, "violations": []}
    def dashboard_layout(label: str, viewport: list[int]) -> dict:
        return {
            "label": label,
            "viewport": viewport,
            "horizontal_overflow": False,
            "layout_settlement": {"settled": True, "samples": 3},
            "controls": {
                name: {"found": True, "reachable": True}
                for name in (
                    "create_input", "create_from_url", "browse", "new_workspace", "search",
                )
            },
        }

    def viewer_layout(label: str, viewport: list[int], mobile: bool) -> dict:
        names = ["workspaces", "share", "dataset_url", "open", "browse", "explore", "mentions"]
        if mobile:
            names.append("layers")
        return {
            "label": label,
            "viewport": viewport,
            "horizontal_overflow": False,
            "finite_positive_canvas": True,
            "layout_settlement": {"settled": True, "samples": 3},
            "reachable_controls": {
                name: {
                    "found": True,
                    "reachable": True,
                    "rect": {"width": 48, "height": 48},
                }
                for name in names
            },
        }
    def overlay_probe(label: str) -> dict:
        return {
            "label": label,
            "layout_settlement": {"settled": True, "samples": 3},
            "viewport_triggers": {
                "explore": {"found": True, "in_viewport": True, "hit_testable": True},
                "mentions": {"found": True, "in_viewport": True, "hit_testable": True},
            },
            "surfaces": {
                "mentions": {"within_viewport": True},
                "explore": {
                    "horizontally_bounded": True,
                    "intersects_visual_viewport": True,
                    "vertically_reachable": True,
                },
            },
            "pairwise_overlap": False,
            "horizontal_overflow": False,
            "primary_controls_unoccluded": True,
            "occluded_safe_regions": [],
            "trigger_panel_linked": True,
            "trigger_kept_focus": True,
            "flipped_from_bottom_right": True,
            "named_surfaces": {
                "minimap": {
                    "present": True,
                    "within_viewport": True,
                    "registered_safe_region": True,
                },
                "thread_popover": {
                    "present": True,
                    "within_viewport": True,
                    "registered_safe_region": True,
                },
                "collection_selector": {
                    "present": True,
                    "within_viewport": True,
                    "registered_safe_region": True,
                    "accessible_name": "Wide collection navigation",
                },
                "notice": {
                    "present": False,
                    "absent_reason": "transient notice is exercised by its owning recovery contract",
                },
            },
            "named_surface_collisions": [],
            "surface_safe_region_pairs_checked": 18,
            "surface_safe_region_collisions": [],
            "collection_interaction": {
                "applicable": True,
                "present": True,
                "populated_cell_count": 12,
                "required_cell_count": 12,
                "edge_cell_label": "Go to A12",
                "selector_minimap_overlap": False,
                "edge_cell_inside_selector": True,
                "edge_cell_hit_testable": True,
                "edge_cell_focused": True,
                "edge_cell_focus_visible": True,
                "edge_cell_focus_ring_inset": True,
                "edge_cell_keyboard_returned": True,
                "edge_cell_click_completed": True,
                "edge_cell_click_received": True,
                "owner_present": True,
                "owner_layout": "stacked" if label == "mobile" else "inline",
            },
        }

    def mobile_persistent_profile() -> dict:
        probe = overlay_probe("mobile")
        return {
            "label": "mobile-persistent",
            "viewport": [390, 844],
            "layout_settlement": {"settled": True, "samples": 3},
            "owner_present": True,
            "owner_layout": "stacked",
            "overlap": False,
            "collection": probe["named_surfaces"]["collection_selector"],
            "minimap": probe["named_surfaces"]["minimap"],
            "collection_interaction": probe["collection_interaction"],
        }

    idle_before = runtime_snapshot(posted=8, presented=8, worker_messages=12)
    idle_after = runtime_snapshot(posted=8, presented=8, worker_messages=12)
    idle_resumed = runtime_snapshot(posted=9, presented=9, worker_messages=13)
    idle_samples = [
        {
            "index": index,
            "duration_ms": 1000,
            "cpu_task_duration_delta_ms": 1 + index,
            "cpu_script_duration_delta_ms": 0.5,
            "requested_delta": 0,
            "fired_delta": 0,
            "frame_delta": 0,
            "pending_after": 0,
            "posted_delta": 0,
            "presented_delta": 0,
            "worker_message_delta": 0,
            "runtime_pending_after": 0,
            "loop_pending_after": False,
            "loop_dirty_after": False,
            "long_task_observer_supported": True,
            "long_task_count_delta": 0,
            "long_task_duration_delta_ms": 0,
            "product_activity_zero": True,
            "strict_zero_activity": True,
            "quiet_window_passed": True,
            "before": idle_before,
            "after": idle_after,
        }
        for index in range(3)
    ]
    contract = {
        "runtime": runtime_snapshot(),
        "canvas_isolation": {
            "executed": True,
            "contaminated_differs_from_black": True,
            "isolated_matches_black": True,
        },
        "final_canvas_settlement": {
            "executed": True,
            "passed": True,
            "reason": "canvas and renderer remained stable",
            "samples": 10,
            "stable_samples": 7,
            "observed_ms": 5200,
            "quiet_ms": 3600,
            "min_observation_ms": 5000,
            "required_quiet_ms": 3000,
            "final_digest": "a" * 64,
            "final_frame_count": 12,
            "final_runtime_key": "12:12:0:16",
            "observations": [],
        },
        "fixture_capabilities": {
            "collection_1x12_required": collection_required,
        },
        "dashboard": {
            "ok": True,
            "layouts": [
                dashboard_layout("dashboard-desktop-1280x720", [1280, 720]),
                dashboard_layout("dashboard-mobile-390x844", [390, 844]),
            ],
            "axe": [
                empty_audit("dashboard-desktop-1280x720"),
                empty_audit("dashboard-mobile-390x844"),
            ],
        },
        "layouts": [
            viewer_layout("desktop-1280x720", [1280, 720], False),
            viewer_layout("mobile-390x844", [390, 844], True),
        ],
        "initial_zero_size_recovery": [
            initial_zero_recovery("2d"),
            initial_zero_recovery("3d"),
        ],
        "zero_size_recovery": [
            later_zero_recovery("2d"),
            later_zero_recovery("3d"),
        ],
        "overlays": {
            "trigger_receipts": {
                name: {"found": True, "in_viewport": True, "hit_testable": True}
                for name in (
                    "desktop_explore",
                    "desktop_mentions",
                    "notice_mentions",
                    "edge_mentions",
                    "mobile_mentions",
                )
            },
            "logical_focus": {"reached_panel": True, "panel_focus_visible": True},
            "mentions_focus_after_click": {
                "captured_before_focus_mutation": True,
                "trigger_focused": True,
                "active_element": {"tag": "BUTTON", "testid": "mentions-of-me-badge"},
            },
            "thread": {
                "trigger_panel_linked": True,
                "trigger_kept_focus": True,
                "logical_focus": {"reached_panel": True, "panel_focus_visible": True},
                "escape_restored_trigger": True,
                "close_restored_trigger": True,
            },
            "saved_view_actions": {
                "applicable": True,
                "created_saved_view": dpr == 1,
                "row_count": 1,
                "item_count": 6,
                "initial_focus_first_item": True,
                "arrow_navigation_passed": True,
                "escape_restored_trigger": True,
                "geometry": {
                    "within_viewport": True,
                    "registered_surface": True,
                    "safe_control_collisions": [],
                },
                "clipped_anchor": {
                    "trigger_connected": True,
                    "trigger_fully_clipped": True,
                    "aria_expanded_cleared": True,
                    "fallback_focused": True,
                    "fallback_label": "Search saved views",
                },
            },
            "probes": {
                "desktop": overlay_probe("desktop"),
                "notice": {
                    **overlay_probe("notice-active"),
                    "named_surfaces": {
                        **overlay_probe("notice-active")["named_surfaces"],
                        "notice": {
                            "present": True,
                            "within_viewport": True,
                            "registered_safe_region": True,
                            "role": "alert",
                        },
                    },
                },
                "zoomed": {
                    **overlay_probe("zoom-125-page-scale"),
                    "zoom_profile": "browser-page-scale-1.25",
                    "page_scale": 1.25,
                    "device_pixel_ratio": dpr,
                    "layout_viewport": [1024, 576],
                    "opening_trigger_receipts": {
                        "post_zoom_mentions": {
                            "found": True,
                            "in_viewport": True,
                            "hit_testable": True,
                        },
                    },
                },
                "edge": overlay_probe("edge-bottom-right"),
                "narrow": {
                    **overlay_probe("mobile"),
                    "safe_regions": [{
                        "label": "Open",
                        "intersects_visible_clip": False,
                        "hit": False,
                    }],
                },
            },
            "persistent_profiles": {"mobile": mobile_persistent_profile()},
            "axe": [
                empty_audit("overlays-open-desktop"),
                empty_audit("overlays-open-with-notice"),
                empty_audit("overlays-open-mobile"),
            ],
        },
        "error_placement": {
            "desktop": {
                "rect": {"top": 80, "bottom": 140},
                "immediately_after_chrome": True,
                "has_retry": True,
                "has_dismiss": True,
            },
            "mobile": {
                "rect": {"top": 80, "bottom": 175},
                "immediately_after_chrome": True,
                "has_retry": True,
                "has_dismiss": True,
            },
            "scroll_resets": {
                "desktop": {
                    "window_x": 0,
                    "window_y": 0,
                    "main_content_found": True,
                    "main_content_left": 0,
                    "main_content_top": 0,
                },
                "mobile": {
                    "window_x": 0,
                    "window_y": 0,
                    "main_content_found": True,
                    "main_content_left": 0,
                    "main_content_top": 0,
                },
            },
            "axe": [
                empty_audit("dataset-error-desktop"),
                empty_audit("dataset-error-mobile"),
            ],
            "retry_action": {
                "clicked": True,
                "failure_reappeared": True,
                "dismiss_cleared": True,
            },
        },
        "async_failures": {
            "executed": dpr == 2,
            "reason": None if dpr == 2 else "DPR2-only acceptance",
            "receipts": {
                "dashboard_load": {
                    "failure_visible": True, "retry_visible": True,
                    "request_count": 2, "recovered": True,
                },
                "workspace_open": {
                    "failure_visible": True, "retry_visible": True,
                    "request_count": 2, "recovered": True,
                    "failure_request_count": 1,
                    "retry_request_delta": 1,
                    "stale_failure_cleared": True,
                },
                "sharing_load": {
                    "failure_visible": True, "retry_visible": True,
                    "request_count": 2, "recovered": True,
                    "failure_request_count": 1,
                    "retry_request_count": 1,
                },
                "dashboard_create": {
                    "failure_visible": True, "retry_visible": True,
                    "request_count": 2, "disabled_while_pending": True,
                    "duplicate_submit_blocked": True,
                    "recovered_navigation": True,
                },
                "sharing_mutation": {
                    "failure_visible": True, "retry_visible": True,
                    "request_count": 2, "disabled_while_pending": True,
                    "duplicate_submit_blocked": True, "recovered": True,
                },
                "rename": {
                    "failure_visible": True, "retry_visible": True,
                    "request_count": 2, "disabled_while_pending": True,
                    "duplicate_submit_blocked": True, "recovered": True,
                    "success_announced": True,
                },
                "sharing_cancel": {
                    "request_count": 1, "dialog_closed": True,
                    "stale_status_suppressed": True,
                },
                "transport": {
                    "injected": True, "failure_visible": True,
                    "retry_visible": True, "rejected_send_frame_delta": 0,
                    "retry_send_frame_delta": 1,
                    "reconnect_created_socket": True,
                    "recovery_attempt_reached_server": True,
                    "dismissed": True,
                },
            } if dpr == 2 else {},
        },
        "terminal_paths": {
            "executed": dpr == 2,
            "reason": None if dpr == 2 else "DPR2-only acceptance",
            "receipts": [
                {
                    "mode": "gpu-worker-crash", "injected": True,
                    "ready_before": True, "recovered": True,
                    "worker_recreated": True,
                    "construction_failures_injected": 1,
                    "construction_failure_surfaced": {
                        "text": "GPU worker construction failure",
                        "recovery_action_visible": True,
                    },
                    "recovery_action": "Restart renderer",
                    "alert_cleared": True,
                    "workers_before": {"gpu_created": 1, "gpu_active": 1},
                    "workers_after": {"gpu_created": 2, "gpu_active": 1},
                    "recovery_proof": {
                        "runtime_replaced": True,
                        "capture_frame_count": 1,
                        "presented_frame_count": 1,
                        "pending_frame_count": 0,
                    },
                    "surfaced": {"render_error_code": None, "text": "GPU worker crash"},
                },
                {
                    "mode": "gpu-device-loss", "injected": True,
                    "ready_before": True, "recovered": True,
                    "worker_recreated": True,
                    "recovery_action": "Restart renderer",
                    "alert_cleared": True,
                    "workers_before": {"gpu_created": 1, "gpu_active": 1},
                    "workers_after": {"gpu_created": 2, "gpu_active": 1},
                    "recovery_proof": {
                        "runtime_replaced": True,
                        "capture_frame_count": 1,
                        "presented_frame_count": 1,
                        "pending_frame_count": 0,
                    },
                    "surfaced": {"render_error_code": "gpu-device-lost", "text": "GPU device loss"},
                },
                {
                    "mode": "decode-terminal", "injected": True,
                    "injected_worker_count": 2,
                    "construction_failures_injected": 2,
                    "ready_before": True, "recovered": True,
                    "worker_recreated": True,
                    "recovery_action": "Reload viewer",
                    "alert_cleared": True,
                    "workers_before": {"decode_active": 2},
                    "workers_after": {"decode_active": 2},
                    "recovery_proof": {
                        "runtime_replaced": True,
                        "capture_frame_count": 1,
                        "presented_frame_count": 1,
                        "pending_frame_count": 0,
                    },
                    "surfaced": {
                        "dataset_error_kind": "data",
                        "text": "Data decoding stopped: replacement could not start",
                    },
                },
            ] if dpr == 2 else [],
        },
        "keyboard": {
            "canvas_name": "2D slice viewer",
            "canvas_instructions": "Use keyboard viewer controls.",
            "sidebar_resizer_changed": True,
            "viewer_resizer_changed": True,
            "sidebar_focus_visible": True,
            "viewer_focus_visible": True,
            "sidebar_focus": {"focused": True, "visible": True},
            "viewer_focus": {"focused": True, "visible": True},
            "drawer_focus_wait": {
                "state": "keyboard.layers-dialog-initial-focus",
                "selector": '#layers-panel[role="dialog"]',
                "wait_passed": True,
                "target_found": True,
                "focus_inside": True,
                "expected_focus_found": True,
                "expected_focus_matched": True,
                "active_element": {
                    "tag": "button",
                    "aria_label": "Close layers panel",
                },
            },
            "drawer_close_focus_visible": True,
            "drawer_close_focus": {"focused": True, "visible": True},
            "drawer_trigger_viewport": {
                "found": True, "in_viewport": True, "hit_testable": True,
            },
            "drawer_initial_focus_inside": True,
            "drawer_escape_restored_focus": True,
            "drawer_focus_cycle": {
                "focusable_count": 3,
                "initial_inside": True,
                "initial_index": 0,
                "initial_state": {"inside": True, "index": 0},
                "cycle_start_inside": True,
                "cycle_start_index": 0,
                "cycle_start_state": {"inside": True, "index": 0},
                "forward_states": [
                    {"inside": True, "index": 1},
                    {"inside": True, "index": 2},
                    {"inside": True, "index": 0},
                ],
                "backward_states": [
                    {"inside": True, "index": 2},
                    {"inside": True, "index": 1},
                    {"inside": True, "index": 0},
                ],
                "forward_unique_count": 3,
                "backward_unique_count": 3,
                "forward_wrapped_to_start": True,
                "backward_wrapped_to_start": True,
                "forward_full_cycle_inside": True,
                "backward_full_cycle_inside": True,
            },
            "reduced_motion": {"respected": True},
        },
        "idle": {
            "contract_version": 1,
            "settled_before": True,
            "sample_count": 3,
            "required_passing_sample_count": 2,
            "passing_sample_count": 3,
            "samples": idle_samples,
            "duration_ms": 3000,
            "sample_duration_ms": 1000,
            "cpu_task_budget_ms": 25,
            "cpu_task_duration_delta_ms": 2,
            "cpu_script_duration_delta_ms": 0.5,
            "requested_delta": 0,
            "fired_delta": 0,
            "frame_delta": 0,
            "pending_after": 0,
            "posted_delta": 0,
            "presented_delta": 0,
            "worker_message_delta": 0,
            "runtime_pending_after": 0,
            "loop_pending_after": False,
            "loop_dirty_after": False,
            "product_activity_zero": True,
            "strict_zero_activity": True,
            "long_task_observer_supported": True,
            "long_task_count_delta": 0,
            "long_task_duration_delta_ms": 0,
            "interaction": {
                "kind": "keyboard-resize-viewer",
                "settled_after": True,
                "posted_advanced": True,
                "presented_advanced": True,
                "worker_messages_advanced": True,
                "pending_after": 0,
            },
            "before": idle_before,
            "after": idle_after,
            "resumed": idle_resumed,
        },
        "axe": [
            empty_audit("desktop-1280x720"),
            empty_audit("mobile-390x844"),
        ],
        "first_run": {"requested": False, "ok": True, "reason": "DPR2-only acceptance"},
    }
    if dpr == 2 and first_run:
        contract["first_run"] = {
            "requested": True,
            "ok": True,
            "stage": "complete",
            "required_channel_count": 3,
            "channel_navigation_required": True,
            "fixture_channel_count": 3,
            "dashboard_responsive": True,
            "workspace_created": True,
            "dataset_opened": True,
            "sharing_dialog_opened": True,
            "next_channel_enabled": True,
            "channel_before": 0,
            "expected_channel_after": 1,
            "channel_after": 1,
            "navigation_baseline_frame": 10,
            "rendered_frame_after": 11,
            "rendered_channel_wait_matched": True,
            "rendered_channel_after": 1,
            "rendered_layer_channel_after": 1,
            "navigation_changed_channel_exactly": True,
            "canvas_digest_before": "a" * 64,
            "canvas_digest_after": "b" * 64,
            "canvas_pixels_changed": True,
            "sharing_focus_wait": {
                "state": "first-run.sharing-dialog-initial-focus",
                "selector": '[role="dialog"][aria-labelledby="workspace-share-title"]',
                "wait_passed": True,
                "target_found": True,
                "focus_inside": True,
                "expected_focus_found": True,
                "expected_focus_matched": True,
                "active_element": {"tag": "button", "text": "Close"},
            },
            "sharing_initial_focus_on_close": True,
            "sharing_initial_focus_visible": True,
            "sharing_focus_appearance": {"focused": True, "visible": True},
            "sharing_focus_restore_wait": {
                "state": "first-run.sharing-dialog-focus-restored",
                "wait_passed": True,
                "active_element": {"tag": "button", "text": "Share Workspace"},
            },
            "sharing_focus_restored": True,
            "sharing_focus_contract": True,
            "sharing_focus_cycle": {
                "focusable_count": 3,
                "initial_inside": True,
                "initial_index": 1,
                "initial_state": {"inside": True, "index": 1},
                "cycle_start_inside": True,
                "cycle_start_index": 0,
                "cycle_start_state": {"inside": True, "index": 0},
                "forward_states": [
                    {"inside": True, "index": 1},
                    {"inside": True, "index": 2},
                    {"inside": True, "index": 0},
                ],
                "backward_states": [
                    {"inside": True, "index": 2},
                    {"inside": True, "index": 1},
                    {"inside": True, "index": 0},
                ],
                "forward_unique_count": 3,
                "backward_unique_count": 3,
                "forward_wrapped_to_start": True,
                "backward_wrapped_to_start": True,
                "forward_full_cycle_inside": True,
                "backward_full_cycle_inside": True,
            },
            "sharing_link_action": {
                "before": "restricted",
                "after": "anyone_with_link",
                "updated": True,
                "status": "Link access updated.",
            },
            "seed_open_transport": {
                "matched": True,
                "socket_id": 1,
                "request_id": "seed-1",
                "sent_event_index": 2,
                "success_event_index": 3,
                "success_sequence": 1,
                "opened_dataset_id": "wds-seed",
            },
            "browser_events": [
                {"event_index": 0, "kind": "websocket-open", "socket_id": 1},
                {
                    "event_index": 1,
                    "kind": "websocket-frame-received",
                    "socket_id": 1,
                    "message_type": "snapshot",
                },
                {
                    "event_index": 2,
                    "kind": "websocket-frame-sent",
                    "socket_id": 1,
                    "message_type": "open_remote_dataset",
                    "request_id": "seed-1",
                },
                {
                    "event_index": 3,
                    "kind": "websocket-frame-received",
                    "socket_id": 1,
                    "message_type": "open_dataset_succeeded",
                    "request_id": "seed-1",
                    "sequence": 1,
                    "opened_dataset_id": "wds-seed",
                    "summary_dataset_id": "wds-seed",
                },
            ],
            "axe": [empty_audit("sharing-dialog-open")],
        }
    return contract


def passing_arm(dpr: int) -> web_surface.RealSpaArmResult:
    grid_w, grid_h = web_surface._CSS_EQUIVALENCE_GRID
    canvas_sample = {
        "grid_width": grid_w,
        "grid_height": grid_h,
        "source_width": 800 * dpr,
        "source_height": 600 * dpr,
        "pixels": [
            (
                20 + (x * 180 / (grid_w - 1)),
                10 + (y * 200 / (grid_h - 1)),
                40 + ((x + y) * 140 / (grid_w + grid_h - 2)),
            )
            for y in range(grid_h)
            for x in range(grid_w)
        ],
    }
    return web_surface.RealSpaArmResult(
        device_scale_factor=dpr,
        captured=True,
        rendered=True,
        frame_advanced=True,
        reason="rendered",
        spa_png=f"/tmp/spa-dpr{dpr}.png",
        spa_png_nonblank=True,
        canvas_png=f"/tmp/canvas-dpr{dpr}.png",
        canvas_png_nonblank=True,
        console_messages=dpr,
        browser_contract=passing_browser_contract(dpr),
        canvas_css_sample=canvas_sample,
        render={
            "device_pixel_ratio": dpr,
            "canvas_width": 800 * dpr,
            "canvas_height": 600 * dpr,
            "canvas_backing_width": 800 * dpr,
            "canvas_backing_height": 600 * dpr,
            "canvas_client_width": 800,
            "canvas_client_height": 600,
            "canvas_css_width": 800,
            "canvas_css_height": 600,
            "backing_to_client_x": dpr,
            "backing_to_client_y": dpr,
            "frame_count": 2,
            "camera": {
                "mode": "slice",
                "center": [50.0, 20.0],
                "zoom": 0.5,
                "viewport": [800, 600],
                "viewportUnits": "css-pixels",
                "projectionProbe": {
                    "world": [66.0, 11.0],
                    "screen": [408.0, 295.5],
                },
            },
            "datasets": [{"dataTypes": ["Uint8"], "channelCounts": [3]}],
            "view": {
                "c": 1,
                "contrastMin": 10.0,
                "contrastMax": 200.0,
                "layers": [{
                    "datasetId": "fixture",
                    "channel": 1,
                    "contrastMin": 10.0,
                    "contrastMax": 200.0,
                    "gamma": 1.0,
                    "contrastSource": "channel",
                }],
            },
        },
    )


class RealSpaMatrixTests(unittest.TestCase):
    def test_matrix_always_runs_dpr1_then_dpr2_and_uses_dpr2_as_primary(self) -> None:
        seen: list[int] = []

        def fake_arm(**kwargs):
            dpr = kwargs["device_scale_factor"]
            seen.append(dpr)
            return passing_arm(dpr)

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(web_surface, "_capture_real_spa_arm", side_effect=fake_arm):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    log=lambda _message: None,
                )

        self.assertEqual(seen, [1, 2])
        self.assertTrue(result.ok)
        self.assertTrue(result.captured)
        self.assertEqual(result.spa_png, "/tmp/spa-dpr2.png")
        self.assertEqual(result.to_dict()["required_device_scale_factors"], [1, 2])
        self.assertEqual(
            [arm["device_scale_factor"] for arm in result.to_dict()["arms"]],
            [1, 2],
        )
        self.assertEqual(result.to_dict()["dpr_matrix"]["backing_area_ratio"], 4.0)
        self.assertTrue(result.to_dict()["dpr_matrix"]["passed"])

    def test_matrix_rejects_a_false_dpr2_backing_area(self) -> None:
        dpr1 = passing_arm(1)
        dpr2 = passing_arm(2)
        dpr2.render["canvas_backing_width"] = 800
        dpr2.render["canvas_width"] = 800
        dpr2.render["backing_to_client_x"] = 1

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                web_surface,
                "_capture_real_spa_arm",
                side_effect=[dpr1, dpr2],
            ):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    log=lambda _message: None,
                )

        self.assertFalse(result.ok)
        self.assertEqual(result.dpr_matrix["backing_area_ratio"], 2.0)
        self.assertFalse(result.dpr_matrix["passed"])
        self.assertIn("backing-area ratio", result.reason)

    def test_one_bad_arm_fails_the_whole_matrix_with_dpr_specific_reason(self) -> None:
        dpr1 = passing_arm(1)
        dpr2 = passing_arm(2)
        dpr2.frame_advanced = False
        dpr2.reason = "presented_frame_did_not_advance"

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                web_surface,
                "_capture_real_spa_arm",
                side_effect=[dpr1, dpr2],
            ):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    log=lambda _message: None,
                )

        self.assertFalse(result.ok)
        self.assertIn("DPR2: presented_frame_did_not_advance", result.reason)
        self.assertIn("presented frame did not advance", result.reason)

    def test_contract_failure_is_visible_in_the_matrix_reason(self) -> None:
        dpr1 = passing_arm(1)
        dpr2 = passing_arm(2)
        dpr2.render["view"]["layers"][0]["contrastMax"] = 201.0

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                web_surface,
                "_capture_real_spa_arm",
                side_effect=[dpr1, dpr2],
            ):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    expectation=web_surface.RealContentExpectation(
                        expected_channel=1,
                        expected_contrast=(10.0, 200.0),
                    ),
                    log=lambda _message: None,
                )

        self.assertFalse(result.ok)
        self.assertIn("DPR2: rendered; rendered contrast", result.reason)

    def test_arm_requires_canvas_pixels_frame_advance_and_clean_gpu_log(self) -> None:
        arm = passing_arm(2)
        self.assertTrue(arm.ok)

        arm.canvas_png_nonblank = False
        self.assertFalse(arm.ok)
        arm.canvas_png_nonblank = True

        arm.frame_advanced = False
        self.assertFalse(arm.ok)
        arm.frame_advanced = True

        arm.gpu_failures.append("[pageerror] GPU device lost")
        self.assertFalse(arm.ok)

    def test_dpr2_rounded_black_canvas_fails_interior_content_proof(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            blank = root / "canvas-dpr2-rounded-black.png"
            rendered = root / "canvas-dpr2-rendered.png"
            width, height, radius = 320, 240, 20

            def rounded_black(x: int, y: int) -> tuple[int, int, int, int]:
                in_corner = (
                    (x < radius and y < radius and (x - radius) ** 2 + (y - radius) ** 2 > radius ** 2)
                    or (x >= width - radius and y < radius
                        and (x - (width - radius - 1)) ** 2 + (y - radius) ** 2 > radius ** 2)
                    or (x < radius and y >= height - radius
                        and (x - radius) ** 2 + (y - (height - radius - 1)) ** 2 > radius ** 2)
                    or (x >= width - radius and y >= height - radius
                        and (x - (width - radius - 1)) ** 2
                        + (y - (height - radius - 1)) ** 2 > radius ** 2)
                )
                return (240, 240, 240, 255) if in_corner else (0, 0, 0, 255)

            write_rgba_png(blank, width, height, rounded_black)
            write_rgba_png(
                rendered,
                width,
                height,
                lambda x, y: (x * 255 // (width - 1), y * 255 // (height - 1), 96, 255),
            )

            # The legacy whole-image check is fooled by rounded page-background
            # corners; the canvas-specific interior receipt must reject it.
            self.assertTrue(web_surface.png_is_nonblank(blank))
            blank_receipt = web_surface.canvas_png_content_receipt(blank)
            self.assertFalse(blank_receipt["passed"])
            self.assertEqual(blank_receipt["luminance_range"], 0.0)
            rendered_receipt = web_surface.canvas_png_content_receipt(rendered)
            self.assertTrue(rendered_receipt["passed"])
            self.assertGreater(rendered_receipt["color_entropy_bits"], 0.1)

    def test_normalized_canvas_equivalence_tolerates_dpr_antialiasing_but_rejects_3_vs_11_members(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            def write_members(path: Path, dpr: int, member_count: int, color_bias: int = 0) -> None:
                css_w, css_h = 330, 150
                width, height = css_w * dpr, css_h * dpr

                def pixel(x: int, y: int) -> tuple[int, int, int, int]:
                    css_x = x / dpr
                    css_y = y / dpr
                    for member in range(member_count):
                        left = 5 + member * 29
                        if left <= css_x < left + 20 and 25 <= css_y < 125:
                            edge = min(css_x - left, left + 20 - css_x, css_y - 25, 125 - css_y)
                            antialias = 0.72 if edge < 0.6 else 1.0
                            return (
                                min(255, round((70 + member * 12 + color_bias) * antialias)),
                                min(255, round((110 + member * 7 + color_bias) * antialias)),
                                min(255, round((160 + member * 5 + color_bias) * antialias)),
                                255,
                            )
                    return (0, 0, 0, 255)

                write_rgba_png(path, width, height, pixel)

            dpr1 = root / "members-dpr1.png"
            dpr2_same = root / "members-dpr2-same.png"
            dpr2_divergent = root / "members-dpr2-only-3.png"
            write_members(dpr1, 1, 11)
            write_members(dpr2_same, 2, 11, color_bias=2)
            write_members(dpr2_divergent, 2, 3, color_bias=2)

            same = web_surface.canvas_css_equivalence_receipt(dpr1, dpr2_same)
            divergent = web_surface.canvas_css_equivalence_receipt(dpr1, dpr2_divergent)
            self.assertTrue(same["passed"], same)
            self.assertFalse(divergent["passed"], divergent)
            self.assertLess(divergent["bidirectional_signal_overlap"], 0.55)

    def test_matrix_ok_depends_on_normalized_canvas_equivalence(self) -> None:
        dpr1 = passing_arm(1)
        dpr2 = passing_arm(2)
        pixels = dpr2.canvas_css_sample["pixels"]
        width = dpr2.canvas_css_sample["grid_width"]
        # Retain signal only in the left 3/11 of the synthetic view: dimensions,
        # frame evidence, and content flags still pass, but CSS content diverges.
        dpr2.canvas_css_sample["pixels"] = [
            pixel if (index % width) < round(width * 3 / 11) else (0.0, 0.0, 0.0)
            for index, pixel in enumerate(pixels)
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                web_surface,
                "_capture_real_spa_arm",
                side_effect=[dpr1, dpr2],
            ):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    log=lambda _message: None,
                )

        self.assertFalse(result.ok)
        self.assertFalse(result.dpr_matrix["css_canvas_equivalence"]["passed"])
        self.assertIn("not equivalent in normalized CSS space", result.reason)

    def test_canvas_only_capture_rejects_black_under_colorful_dom_overlays(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolated_black = root / "isolated-black.png"
            legacy_composited = root / "black-with-collection-minimap-dom.png"
            real_canvas = root / "real-canvas.png"
            width, height = 320, 240

            write_rgba_png(
                isolated_black,
                width,
                height,
                lambda _x, _y: (0, 0, 0, 255),
            )

            def black_with_dom_overlay(x: int, y: int) -> tuple[int, int, int, int]:
                # Synthetic collection strip across the bottom plus a colorful
                # minimap in the top-right — both are DOM siblings painted over
                # an otherwise black viewer canvas.
                if 12 <= x < 308 and 178 <= y < 226:
                    return ((x * 7) % 256, (x * 13) % 256, (x * 19) % 256, 255)
                if 210 <= x < 306 and 14 <= y < 110:
                    return ((x + y) % 256, (x * 3) % 256, (y * 5) % 256, 255)
                return (0, 0, 0, 255)

            write_rgba_png(legacy_composited, width, height, black_with_dom_overlay)
            write_rgba_png(
                real_canvas,
                width,
                height,
                lambda x, y: (
                    x * 255 // (width - 1),
                    y * 255 // (height - 1),
                    (x + y) * 255 // (width + height - 2),
                    255,
                ),
            )

            # This documents the old false positive: the composited element
            # crop passes solely because DOM overlays add entropy. The shared
            # browser helper now removes those siblings, yielding the isolated
            # black canvas which must fail, while genuine canvas signal passes.
            self.assertTrue(
                web_surface.canvas_png_content_receipt(legacy_composited)["passed"],
            )
            self.assertFalse(
                web_surface.canvas_png_content_receipt(isolated_black)["passed"],
            )
            self.assertTrue(web_surface.canvas_png_content_receipt(real_canvas)["passed"])

        self.assertIn("async function capturePrimaryCanvas", web_surface._SPA_DRIVER)
        self.assertIn(
            "browserContract.canvas_isolation = await exerciseCanvasIsolationContract(context)",
            web_surface._SPA_DRIVER,
        )
        self.assertIn(
            "const pixels = await capturePrimaryCanvas(page);",
            web_surface._SPA_DRIVER,
        )
        self.assertIn(
            "await capturePrimaryCanvas(page, { path: canvasPng });",
            web_surface._SPA_DRIVER,
        )
        self.assertIn(
            "browserContract.final_canvas_settlement = await waitForFinalCanvasSettlement(page)",
            web_surface._SPA_DRIVER,
        )
        self.assertNotIn("await canvas.screenshot({ path: canvasPng });", web_surface._SPA_DRIVER)

    def test_arm_serializes_browser_failure_diagnostic(self) -> None:
        arm = passing_arm(2)
        arm.diagnostic = "locator.click timed out\nCall log: element was outside viewport"
        self.assertEqual(arm.to_dict()["diagnostic"], arm.diagnostic)

    def test_embedded_driver_never_hard_codes_a_dpr1_context(self) -> None:
        self.assertIn("deviceScaleFactor", web_surface._SPA_DRIVER)
        self.assertIn("device_scale_factor", web_surface._SPA_DRIVER)
        self.assertIn(
            "const diagnostic = String(e && e.stack ? e.stack : e);",
            web_surface._SPA_DRIVER,
        )
        self.assertIn("async function firstActionableAnnotationPin", web_surface._SPA_DRIVER)
        self.assertIn("async function createActionableAnnotationPin", web_surface._SPA_DRIVER)
        self.assertIn("await pin.click({ trial: true, timeout: 10000 });", web_surface._SPA_DRIVER)
        self.assertIn("trigger_hit_testable_before_click", web_surface._SPA_DRIVER)
        self.assertIn("canvas_client_width", web_surface._SPA_DRIVER)
        self.assertIn("backing_to_client_x", web_surface._SPA_DRIVER)
        self.assertIn("page.locator('.workspace-dashboard-actions')", web_surface._SPA_DRIVER)
        self.assertIn(
            "name: /^(New Workspace|Creating\\.\\.\\.)$/",
            web_surface._SPA_DRIVER,
        )
        self.assertNotIn("deviceScaleFactor: 1,", web_surface._SPA_DRIVER)
        self.assertNotIn("deviceScaleFactor: 1.25", web_surface._SPA_DRIVER)

    def test_embedded_driver_enables_linux_software_webgpu(self) -> None:
        capture_base = [
            "--enable-unsafe-webgpu",
            "--ignore-gpu-blocklist",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        linux_software = [
            "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
            "--enable-gpu",
            "--enable-unsafe-swiftshader",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--use-vulkan=swiftshader",
            "--use-webgpu-adapter=swiftshader",
        ]
        self.assertEqual(headless_webgpu_browser_args("darwin"), capture_base)
        self.assertEqual(headless_webgpu_browser_args("win32"), capture_base)
        self.assertEqual(
            headless_webgpu_browser_args("linux"),
            [*capture_base, *linux_software],
        )
        self.assertIn("const browserArgs = req.browser_args", web_surface._SPA_DRIVER)
        self.assertIn("args: browserArgs", web_surface._SPA_DRIVER)
        self.assertNotIn("browserArgs.filter", web_surface._SPA_DRIVER)

    def test_layers_dialog_focus_wait_uses_the_product_dialog_identity(self) -> None:
        self.assertIn("async function waitForFocusInside", web_surface._SPA_DRIVER)
        self.assertIn("wait_error: waitError", web_surface._SPA_DRIVER)
        self.assertIn(
            "#layers-panel[role=\"dialog\"]",
            web_surface._SPA_DRIVER,
        )
        self.assertIn(
            "#layers-panel button[aria-label=\"Close layers panel\"]",
            web_surface._SPA_DRIVER,
        )
        self.assertIn("expected_focus_matched", web_surface._SPA_DRIVER)
        self.assertIn("focusFailureScreenshotPath", web_surface._SPA_DRIVER)
        self.assertIn(".workspace-share-header button", web_surface._SPA_DRIVER)
        self.assertIn("async function waitForLocatorFocus", web_surface._SPA_DRIVER)
        self.assertIn("first-run.sharing-dialog-focus-restored", web_surface._SPA_DRIVER)
        self.assertIn("async function waitForRenderedChannel", web_surface._SPA_DRIVER)
        self.assertIn("navigationBaselineFrame", web_surface._SPA_DRIVER)
        self.assertIn("cycle_start_index", web_surface._SPA_DRIVER)
        self.assertIn("initial_state: initial", web_surface._SPA_DRIVER)
        self.assertIn("forward_states: forward", web_surface._SPA_DRIVER)

    def test_overlay_and_error_probes_use_reflow_clips_and_workspace_scroll(self) -> None:
        self.assertIn("browser-page-scale-1.25", web_surface._SPA_DRIVER)
        self.assertIn("width: 1024, height: 576", web_surface._SPA_DRIVER)
        self.assertIn("Emulation.setPageScaleFactor", web_surface._SPA_DRIVER)
        self.assertIn("window.visualViewport.scale", web_surface._SPA_DRIVER)
        self.assertIn("exerciseCollectionSelector(page, label)", web_surface._SPA_DRIVER)
        self.assertIn("edge_cell_hit_testable", web_surface._SPA_DRIVER)
        self.assertIn("edge_cell_focus_visible", web_surface._SPA_DRIVER)
        self.assertIn(
            "const outlineOffset = Number.parseFloat(style.outlineOffset || '0');",
            web_surface._SPA_DRIVER,
        )
        self.assertIn("edge_cell_click_received", web_surface._SPA_DRIVER)
        self.assertIn("selector_minimap_overlap", web_surface._SPA_DRIVER)
        self.assertIn("applicable: false", web_surface._SPA_DRIVER)
        self.assertIn("const requireCollection1x12", web_surface._SPA_DRIVER)
        self.assertIn("collection_1x12_required", web_surface._SPA_DRIVER)
        self.assertIn("required 1x12 collection capability was absent", web_surface._SPA_DRIVER)
        self.assertIn("captured_before_focus_mutation", web_surface._SPA_DRIVER)
        self.assertIn("surfaceSafeRegionPairsChecked", web_surface._SPA_DRIVER)
        self.assertIn("document.querySelectorAll('[data-floating-safe-region]')", web_surface._SPA_DRIVER)
        self.assertIn("function visibleClip(element)", web_surface._SPA_DRIVER)
        self.assertIn("window.__lucidaTryoutEffectiveVisibleRect", web_surface._SPA_DRIVER)
        self.assertIn("current.getAttribute('aria-hidden') === 'true'", web_surface._SPA_DRIVER)
        self.assertIn("async function waitForLayoutSettlement", web_surface._SPA_DRIVER)
        self.assertIn("async function prepareViewportTrigger", web_surface._SPA_DRIVER)
        probe_start = web_surface._SPA_DRIVER.index("async function floatingSurfaceProbe")
        interaction = web_surface._SPA_DRIVER.index(
            "const collectionInteraction = exercisePersistentInteraction", probe_start,
        )
        geometry = web_surface._SPA_DRIVER.index("const probe = await page.evaluate", probe_start)
        # The A12 click changes the selected collection member and can close a
        # thread whose projected pin leaves the canvas. Simultaneous geometry
        # must therefore be captured before that mutating interaction.
        self.assertGreater(interaction, geometry)
        self.assertIn("intersects_visible_clip", web_surface._SPA_DRIVER)
        self.assertIn("async function resetWorkspaceScroll", web_surface._SPA_DRIVER)
        self.assertIn("document.querySelector('.main-content')", web_surface._SPA_DRIVER)
        self.assertIn("const failureReceipt = async (reason)", web_surface._SPA_DRIVER)
        self.assertIn("stage = 'dataset-readiness'", web_surface._SPA_DRIVER)
        self.assertNotIn("channelSlider.inputValue()", web_surface._SPA_DRIVER)
        self.assertIn("websocket-frame-sent", web_surface._SPA_DRIVER)
        self.assertIn("websocket-frame-received", web_surface._SPA_DRIVER)
        self.assertIn("firstRun.on('console'", web_surface._SPA_DRIVER)
        self.assertNotIn(
            "[role=\"dialog\"][aria-label=\"Layers\"]",
            web_surface._SPA_DRIVER,
        )

    def test_idle_driver_uses_three_samples_without_masking_activity(self) -> None:
        self.assertIn("for (let index = 0; index < 3; index++)", web_surface._SPA_DRIVER)
        self.assertIn("required_passing_sample_count: 2", web_surface._SPA_DRIVER)
        self.assertIn("sample.strict_zero_activity", web_surface._SPA_DRIVER)
        self.assertIn("samples.every((sample) => sample.strict_zero_activity)", web_surface._SPA_DRIVER)
        self.assertIn("median(samples.map((sample) => sample.cpu_task_duration_delta_ms))", web_surface._SPA_DRIVER)
        self.assertNotIn("requested_delta: median(", web_surface._SPA_DRIVER)
        self.assertNotIn("long_task_count_delta: median(", web_surface._SPA_DRIVER)

    def test_live_failure_matrix_uses_public_boundaries_and_mandatory_receipts(self) -> None:
        for marker in (
            "exerciseDashboardFailures(",
            "exerciseWorkspaceOpenFailure(",
            "exerciseViewerApiFailures(",
            "exerciseTransportFailure(",
            "exerciseTerminalPath(",
            "sharing_cancel",
            "duplicate_submit_blocked",
            "retry_send_frame_delta",
            "gpu-worker-crash",
            "gpu-device-loss",
            "decode-terminal",
            "worker_recreated",
            "failNextConstruction(",
            "construction_failure_surfaced",
            "presented_frame_count",
            "socket.close(4012",
            "asyncFailureContractFailures(",
            "terminalPathFailures(",
        ):
            self.assertIn(marker, web_surface._SPA_DRIVER)
        self.assertIn('page.route(\'**/api/workspaces', web_surface._SPA_DRIVER)
        self.assertIn("class HarnessObservedWebSocket", web_surface._SPA_DRIVER)
        self.assertIn("class HarnessObservedWorker", web_surface._SPA_DRIVER)
        self.assertNotIn("__lucidaTestBackdoor", web_surface._SPA_DRIVER)

    def test_browser_harness_fallback_uses_exact_repository_pins(self) -> None:
        package = (
            Path(__file__).resolve().parents[3] / "lucida-web" / "package.json"
        ).read_text(encoding="utf-8")
        self.assertIn(
            f'"playwright": "{web_surface.PLAYWRIGHT_VERSION}"',
            package,
        )
        self.assertIn(
            f'"axe-core": "{web_surface.AXE_CORE_VERSION}"',
            package,
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            modules = Path(temp_dir)
            playwright_manifest = modules / "playwright" / "package.json"
            axe_manifest = modules / "axe-core" / "package.json"
            playwright_manifest.parent.mkdir()
            axe_manifest.parent.mkdir()
            playwright_manifest.write_text('{"version":"0.0.1"}', encoding="utf-8")
            axe_manifest.write_text('{"version":"0.0.1"}', encoding="utf-8")
            self.assertFalse(web_surface._has_pinned_playwright(Path(temp_dir)))
            self.assertFalse(web_surface._has_pinned_axe_core(Path(temp_dir)))
            self.assertFalse(web_surface._has_pinned_browser_harness(Path(temp_dir)))
            playwright_manifest.write_text(
                '{"version":"' + web_surface.PLAYWRIGHT_VERSION + '"}',
                encoding="utf-8",
            )
            axe_manifest.write_text(
                '{"version":"' + web_surface.AXE_CORE_VERSION + '"}',
                encoding="utf-8",
            )
            self.assertTrue(web_surface._has_pinned_playwright(Path(temp_dir)))
            self.assertTrue(web_surface._has_pinned_axe_core(Path(temp_dir)))
            self.assertTrue(web_surface._has_pinned_browser_harness(Path(temp_dir)))

    def test_structured_browser_acceptance_receipt_executes_every_scope(self) -> None:
        contract = passing_browser_contract(1)
        self.assertEqual(
            web_surface._browser_acceptance_contract_failures(
                contract,
                device_scale_factor=1,
                require_first_run=False,
                required_channel_count=3,
            ),
            [],
        )
        dpr2_contract = passing_browser_contract(2)
        self.assertEqual(
            web_surface._browser_acceptance_contract_failures(
                dpr2_contract,
                device_scale_factor=2,
                require_first_run=False,
                required_channel_count=3,
            ),
            [],
        )

        broken = deepcopy(contract)
        broken["dashboard"]["layouts"].pop()
        broken["overlays"]["logical_focus"]["reached_panel"] = False
        broken["overlays"]["thread"]["close_restored_trigger"] = False
        broken["canvas_isolation"]["isolated_matches_black"] = False
        broken["final_canvas_settlement"]["passed"] = False
        broken["overlays"]["probes"]["zoomed"]["layout_viewport"] = [1280, 720]
        broken["overlays"]["probes"]["narrow"]["primary_controls_unoccluded"] = False
        broken["keyboard"]["drawer_focus_cycle"]["backward_full_cycle_inside"] = False
        broken["keyboard"]["drawer_focus_wait"]["wait_passed"] = False
        broken["error_placement"]["scroll_resets"]["mobile"]["main_content_top"] = 200
        broken["error_placement"]["axe"][0]["violations"].append({"id": "button-name"})
        failures = web_surface._browser_acceptance_contract_failures(
            broken,
            device_scale_factor=1,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertTrue(any("dashboard DPR arm" in failure for failure in failures))
        self.assertTrue(any("overlay logical focus" in failure for failure in failures))
        self.assertTrue(any("annotation-thread focus" in failure for failure in failures))
        self.assertTrue(any("canvas-only capture isolation" in failure for failure in failures))
        self.assertTrue(any("final isolated canvas settlement" in failure for failure in failures))
        self.assertTrue(any("browser-page-scale 125%" in failure for failure in failures))
        self.assertTrue(any("overlay narrow geometry" in failure for failure in failures))
        self.assertTrue(any("keyboard/focus" in failure for failure in failures))
        self.assertTrue(
            any("keyboard.layers-dialog-initial-focus" in failure for failure in failures)
        )
        self.assertTrue(any("dataset-error-desktop" in failure for failure in failures))
        self.assertTrue(any("workspace scroll container" in failure for failure in failures))

        missing_collection = deepcopy(contract)
        missing_collection["overlays"]["persistent_profiles"]["mobile"]["collection"]["present"] = False
        missing_collection["overlays"]["persistent_profiles"]["mobile"]["collection_interaction"]["edge_cell_hit_testable"] = False
        missing_collection_failures = web_surface._browser_acceptance_contract_failures(
            missing_collection,
            device_scale_factor=1,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertIn(
            "overlay mobile persistent-overlay profile did not pass",
            missing_collection_failures,
        )

        non_collection = deepcopy(contract)
        for probe in non_collection["overlays"]["probes"].values():
            probe["named_surfaces"]["collection_selector"].update({
                "present": False,
                "within_viewport": None,
                "registered_safe_region": False,
                "accessible_name": None,
            })
            probe["collection_interaction"] = {
                "applicable": False,
                "present": False,
                "populated_cell_count": 0,
                "required_cell_count": 12,
                "skip_reason": "fixture does not expose a visible collection selector",
            }
        non_collection_mobile = non_collection["overlays"]["persistent_profiles"]["mobile"]
        non_collection_mobile["owner_layout"] = "inline"
        non_collection_mobile["collection"].update({
            "present": False,
            "within_viewport": None,
            "registered_safe_region": False,
            "accessible_name": None,
        })
        non_collection_mobile["collection_interaction"] = {
            "applicable": False,
            "present": False,
            "populated_cell_count": 0,
            "required_cell_count": 12,
            "skip_reason": "fixture does not expose a visible collection selector",
        }
        self.assertEqual(
            web_surface._browser_acceptance_contract_failures(
                non_collection,
                device_scale_factor=1,
                require_first_run=False,
                required_channel_count=3,
            ),
            [],
        )

        required_collection = deepcopy(non_collection)
        required_collection["fixture_capabilities"]["collection_1x12_required"] = True
        required_collection_failures = (
            web_surface._browser_acceptance_contract_failures(
                required_collection,
                device_scale_factor=1,
                require_first_run=False,
                required_channel_count=3,
                require_collection_1x12=True,
            )
        )
        self.assertIn(
            "overlay mobile persistent-overlay profile did not pass",
            required_collection_failures,
        )

        lost_click_focus = deepcopy(contract)
        lost_click_focus["overlays"]["mentions_focus_after_click"]["trigger_focused"] = False
        lost_click_focus_failures = web_surface._browser_acceptance_contract_failures(
            lost_click_focus,
            device_scale_factor=1,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertIn(
            "Mentions trigger did not retain focus immediately after click",
            lost_click_focus_failures,
        )

        broken_saved_view_menu = deepcopy(contract)
        broken_saved_view_menu["overlays"]["saved_view_actions"]["clipped_anchor"][
            "fallback_focused"
        ] = False
        broken_saved_view_menu_failures = web_surface._browser_acceptance_contract_failures(
            broken_saved_view_menu,
            device_scale_factor=1,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertIn(
            "overlay saved-view actions menu lifecycle did not pass",
            broken_saved_view_menu_failures,
        )

        safe_region_collision = deepcopy(contract)
        safe_region_collision["overlays"]["probes"]["desktop"][
            "surface_safe_region_collisions"
        ] = [["mentions", "Share Workspace"]]
        safe_region_failures = web_surface._browser_acceptance_contract_failures(
            safe_region_collision,
            device_scale_factor=1,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertIn("overlay desktop geometry receipt did not pass", safe_region_failures)

        missing_failures = web_surface._browser_acceptance_contract_failures(
            {
                **dpr2_contract,
                "async_failures": None,
                "terminal_paths": None,
            },
            device_scale_factor=2,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertTrue(any("async failure receipt was missing" in failure for failure in missing_failures))
        self.assertTrue(any("terminal path receipt was missing" in failure for failure in missing_failures))

        contradictory = deepcopy(dpr2_contract)
        gpu_receipt = contradictory["terminal_paths"]["receipts"][0]
        gpu_receipt["workers_before"] = {"gpu_created": 9, "gpu_active": 1}
        gpu_receipt["workers_after"] = {"gpu_created": 0, "gpu_active": 0}
        gpu_receipt["recovery_proof"]["presented_frame_count"] = 0
        contradictory_failures = web_surface._browser_acceptance_contract_failures(
            contradictory,
            device_scale_factor=2,
            require_first_run=False,
            required_channel_count=3,
        )
        self.assertTrue(any(
            "raw GPU worker counters contradict recovery" in failure
            for failure in contradictory_failures
        ))
        self.assertTrue(any(
            "newly presented frame" in failure
            for failure in contradictory_failures
        ))

    def test_runtime_receipt_rejects_forwarded_zero_idle_work_and_failed_resume(self) -> None:
        def failures_for(contract: dict) -> list[str]:
            return web_surface._browser_acceptance_contract_failures(
                contract,
                device_scale_factor=1,
                require_first_run=False,
                required_channel_count=3,
            )

        missing_version = passing_browser_contract(1)
        missing_version["runtime"]["version"] = 0
        self.assertIn(
            "renderer runtime contract version 1 was unavailable",
            failures_for(missing_version),
        )

        forwarded_zero = passing_browser_contract(1)
        recovery = forwarded_zero["initial_zero_size_recovery"][0]
        recovery["initial_invalid_not_forwarded"] = False
        recovery["initial"]["client"]["surface"]["byMode"]["slice"]["forwarded"] = 1
        self.assertTrue(
            any("before forwarding" in failure for failure in failures_for(forwarded_zero))
        )

        missing_later = passing_browser_contract(1)
        missing_later["zero_size_recovery"] = []
        self.assertTrue(any("later 0x0" in failure for failure in failures_for(missing_later)))

        later_forwarded_zero = passing_browser_contract(1)
        later = later_forwarded_zero["zero_size_recovery"][0]
        later["collapsed_invalid_not_forwarded"] = False
        later["collapsed_runtime"]["client"]["surface"]["byMode"]["slice"]["forwarded"] = 5
        self.assertTrue(
            any("later 0x0 collapse" in failure for failure in failures_for(later_forwarded_zero))
        )

        idle_worker = passing_browser_contract(1)
        idle_worker["idle"]["worker_message_delta"] = 1
        idle_worker["idle"]["after"]["client"]["worker"]["messages"] += 1
        self.assertIn(
            "settled viewer performed renderer or worker work while idle",
            failures_for(idle_worker),
        )

        idle_raf = passing_browser_contract(1)
        idle_raf["idle"]["requested_delta"] = 1
        idle_raf["idle"]["fired_delta"] = 1
        self.assertIn(
            "idle browser trace exceeded its requestAnimationFrame budget",
            failures_for(idle_raf),
        )

        idle_cpu = passing_browser_contract(1)
        idle_cpu["idle"]["cpu_task_duration_delta_ms"] = 26
        self.assertIn(
            "idle main-thread task duration exceeded its CPU budget",
            failures_for(idle_cpu),
        )

        idle_long_task = passing_browser_contract(1)
        idle_long_task["idle"]["long_task_count_delta"] = 1
        idle_long_task["idle"]["long_task_duration_delta_ms"] = 51
        idle_long_task["idle"]["after"]["mainThread"]["longTaskCount"] = 1
        idle_long_task["idle"]["after"]["mainThread"]["longTaskDurationMs"] = 51
        self.assertIn(
            "idle main thread exceeded the zero-long-task budget",
            failures_for(idle_long_task),
        )

        hidden_raf_window = passing_browser_contract(1)
        hidden_raf_window["idle"]["samples"][0]["requested_delta"] = 1
        # Leave aggregate/boolean claims untouched: the independent validator
        # must inspect every raw sample rather than trusting the median receipt.
        self.assertIn(
            "idle activity was non-zero in at least one quiet window",
            failures_for(hidden_raf_window),
        )

        hidden_long_task_window = passing_browser_contract(1)
        hidden_long_task_window["idle"]["samples"][2]["long_task_count_delta"] = 1
        self.assertIn(
            "idle activity was non-zero in at least one quiet window",
            failures_for(hidden_long_task_window),
        )

        one_noisy_cpu_window = passing_browser_contract(1)
        one_noisy_cpu_window["idle"]["samples"][0]["cpu_task_duration_delta_ms"] = 40
        one_noisy_cpu_window["idle"]["samples"][0]["quiet_window_passed"] = False
        one_noisy_cpu_window["idle"]["passing_sample_count"] = 2
        one_noisy_cpu_window["idle"]["cpu_task_duration_delta_ms"] = 3
        self.assertNotIn(
            "idle main-thread task duration exceeded its CPU budget",
            failures_for(one_noisy_cpu_window),
        )

        two_noisy_cpu_windows = passing_browser_contract(1)
        for index in (0, 1):
            two_noisy_cpu_windows["idle"]["samples"][index][
                "cpu_task_duration_delta_ms"
            ] = 40
            two_noisy_cpu_windows["idle"]["samples"][index]["quiet_window_passed"] = False
        two_noisy_cpu_windows["idle"]["passing_sample_count"] = 1
        two_noisy_cpu_windows["idle"]["cpu_task_duration_delta_ms"] = 40
        self.assertIn(
            "idle browser trace did not pass two of three quiet windows",
            failures_for(two_noisy_cpu_windows),
        )

        failed_resume = passing_browser_contract(1)
        failed_resume["idle"]["interaction"]["presented_advanced"] = False
        failed_resume["idle"]["resumed"]["client"]["frames"]["presented"] = 8
        self.assertIn(
            "real keyboard interaction did not resume and settle a presented frame",
            failures_for(failed_resume),
        )

        dirty_resume = passing_browser_contract(1)
        dirty_resume["idle"]["resumed"]["loop"]["interactiveDirty"] = True
        self.assertIn(
            "real keyboard interaction did not resume and settle a presented frame",
            failures_for(dirty_resume),
        )

    def test_python_parser_rejects_inconsistent_raw_layout_and_keyboard_receipts(self) -> None:
        def failures_for(contract: dict) -> list[str]:
            return web_surface._browser_acceptance_contract_failures(
                contract,
                device_scale_factor=1,
                require_first_run=False,
                required_channel_count=3,
            )

        bad_layout = passing_browser_contract(1)
        bad_layout["layouts"][0]["horizontal_overflow"] = True
        bad_layout["layouts"][0]["finite_positive_canvas"] = False
        bad_layout["layouts"][0]["reachable_controls"] = {}
        self.assertTrue(any("viewer layout receipt" in failure for failure in failures_for(bad_layout)))

        bad_dashboard = passing_browser_contract(1)
        bad_dashboard["dashboard"]["layouts"][0]["controls"] = {}
        self.assertTrue(any("dashboard layout receipt" in failure for failure in failures_for(bad_dashboard)))

        bad_keyboard = passing_browser_contract(1)
        bad_keyboard["keyboard"]["canvas_name"] = ""
        bad_keyboard["keyboard"]["canvas_instructions"] = ""
        bad_keyboard["keyboard"]["sidebar_resizer_changed"] = False
        bad_keyboard["keyboard"]["drawer_escape_restored_focus"] = False
        self.assertIn(
            "keyboard/focus/reduced-motion receipt was incomplete",
            failures_for(bad_keyboard),
        )

    def test_ci_first_run_requires_fixture_receipt_and_exact_three_channel_move(self) -> None:
        missing = passing_browser_contract(2)
        failures = web_surface._browser_acceptance_contract_failures(
            missing,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertIn("required DPR2 first-run acceptance was not requested", failures)

        passing = passing_browser_contract(2, first_run=True)
        self.assertEqual(
            web_surface._browser_acceptance_contract_failures(
                passing,
                device_scale_factor=2,
                require_first_run=True,
                required_channel_count=3,
            ),
            [],
        )
        failed_readiness = deepcopy(passing)
        failed_readiness["first_run"].update({
            "ok": False,
            "stage": "dataset-readiness",
            "reason": "seeded dataset did not render",
        })
        failures = web_surface._browser_acceptance_contract_failures(
            failed_readiness,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertTrue(
            any(
                "at dataset-readiness: seeded dataset did not render" in failure
                for failure in failures
            )
        )

        missing_seed_send = deepcopy(passing)
        missing_seed_send["first_run"]["browser_events"] = [
            event for event in missing_seed_send["first_run"]["browser_events"]
            if event.get("message_type") != "open_remote_dataset"
        ]
        failures = web_surface._browser_acceptance_contract_failures(
            missing_seed_send,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertIn("first-run browser did not send its seeded dataset open", failures)

        missing_seed_success = deepcopy(passing)
        missing_seed_success["first_run"]["browser_events"] = [
            event for event in missing_seed_success["first_run"]["browser_events"]
            if event.get("message_type") != "open_dataset_succeeded"
        ]
        failures = web_surface._browser_acceptance_contract_failures(
            missing_seed_success,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertIn(
            "first-run seeded open lacked a correlated authoritative success",
            failures,
        )
        for field, bad_value in (
            ("next_channel_enabled", False),
            ("channel_after", 2),
            ("rendered_channel_wait_matched", False),
            ("rendered_frame_after", 10),
            ("rendered_channel_after", 2),
            ("rendered_layer_channel_after", 2),
        ):
            broken = deepcopy(passing)
            broken["first_run"][field] = bad_value
            failures = web_surface._browser_acceptance_contract_failures(
                broken,
                device_scale_factor=2,
                require_first_run=True,
                required_channel_count=3,
            )
            self.assertIn(
                "first-run channel navigation was not an exact enabled transition",
                failures,
            )

        skipped_channel = deepcopy(passing)
        skipped_channel["first_run"].update({
            "expected_channel_after": 2,
            "channel_after": 2,
            "rendered_channel_after": 2,
            "rendered_layer_channel_after": 2,
        })
        failures = web_surface._browser_acceptance_contract_failures(
            skipped_channel,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertIn(
            "first-run channel navigation was not an exact enabled transition",
            failures,
        )

        optimistic_raw = deepcopy(passing)
        optimistic_raw["first_run"]["dataset_opened"] = False
        optimistic_raw["first_run"]["sharing_dialog_opened"] = False
        failures = web_surface._browser_acceptance_contract_failures(
            optimistic_raw,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertIn(
            "first-run raw workspace/navigation/sharing receipt was incomplete",
            failures,
        )

        unchanged_pixels = deepcopy(passing)
        unchanged_pixels["first_run"]["canvas_digest_after"] = "a" * 64
        unchanged_pixels["first_run"]["canvas_pixels_changed"] = False
        failures = web_surface._browser_acceptance_contract_failures(
            unchanged_pixels,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertIn(
            "first-run channel transition did not change rendered canvas pixels",
            failures,
        )

        broken_focus = deepcopy(passing)
        broken_focus["first_run"]["sharing_focus_wait"]["wait_passed"] = False
        broken_focus["first_run"]["sharing_focus_contract"] = False
        failures = web_surface._browser_acceptance_contract_failures(
            broken_focus,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertTrue(
            any("first-run.sharing-dialog-initial-focus" in failure for failure in failures)
        )

        broken_restore = deepcopy(passing)
        broken_restore["first_run"]["sharing_focus_restore_wait"]["wait_passed"] = False
        broken_restore["first_run"]["sharing_focus_restored"] = False
        broken_restore["first_run"]["sharing_focus_contract"] = False
        failures = web_surface._browser_acceptance_contract_failures(
            broken_restore,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertTrue(any("restore focus after Escape" in failure for failure in failures))

        broken_visible_focus = deepcopy(passing)
        broken_visible_focus["first_run"]["sharing_initial_focus_visible"] = False
        broken_visible_focus["first_run"]["sharing_focus_contract"] = False
        failures = web_surface._browser_acceptance_contract_failures(
            broken_visible_focus,
            device_scale_factor=2,
            require_first_run=True,
            required_channel_count=3,
        )
        self.assertTrue(any("visibly indicated" in failure for failure in failures))

    def test_matrix_threads_required_channel_count_and_enforces_first_run(self) -> None:
        seen: list[tuple[int, int]] = []

        def fake_arm(**kwargs):
            dpr = kwargs["device_scale_factor"]
            seen.append((dpr, kwargs["first_run_required_channels"]))
            arm = passing_arm(dpr)
            arm.browser_contract = passing_browser_contract(dpr, first_run=dpr == 2)
            return arm

        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(web_surface, "_capture_real_spa_arm", side_effect=fake_arm):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    expectation=web_surface.RealContentExpectation(min_channel_count=3),
                    first_run_dataset_path="/tmp/fixture.ome.zarr",
                    require_first_run=True,
                    log=lambda _message: None,
                )

        self.assertEqual(seen, [(1, 3), (2, 3)])
        self.assertTrue(result.ok)

    def test_known_wide_collection_fixture_requires_1x12_acceptance(self) -> None:
        seen: list[tuple[int, bool]] = []

        def fake_arm(**kwargs):
            dpr = kwargs["device_scale_factor"]
            collection_required = kwargs["require_collection_1x12"]
            seen.append((dpr, collection_required))
            arm = passing_arm(dpr)
            arm.browser_contract = passing_browser_contract(
                dpr,
                collection_required=collection_required,
            )
            return arm

        with tempfile.TemporaryDirectory() as temp_dir:
            fixture = Path(temp_dir) / "wide.ome.zarr"
            fixture.mkdir()
            fixture.joinpath("zarr.json").write_text(
                """{
                    "attributes": {
                        "ome": {
                            "plate": {
                                "name": "lucida-browser-smoke-wide-collection",
                                "rows": [{"name": "A"}],
                                "columns": [
                                    {"name": "1"}, {"name": "2"},
                                    {"name": "3"}, {"name": "4"},
                                    {"name": "5"}, {"name": "6"},
                                    {"name": "7"}, {"name": "8"},
                                    {"name": "9"}, {"name": "10"},
                                    {"name": "11"}, {"name": "12"}
                                ]
                            }
                        }
                    }
                }""",
                encoding="utf-8",
            )
            with patch.object(web_surface, "_capture_real_spa_arm", side_effect=fake_arm):
                result = web_surface.capture_real_spa(
                    url="http://127.0.0.1/w/ws-test",
                    web_out=Path(temp_dir),
                    first_run_dataset_path=str(fixture),
                    log=lambda _message: None,
                )

        self.assertEqual(seen, [(1, True), (2, True)])
        self.assertTrue(result.ok)

    def test_browser_contract_failure_fails_an_otherwise_rendered_arm(self) -> None:
        arm = passing_arm(2)
        arm.contract_failures.append("mobile-390x844: horizontal document overflow")
        self.assertFalse(arm.ok)

    def test_fixture_contract_checks_non_u16_channels_selection_and_contrast(self) -> None:
        arm = passing_arm(2)
        failures = web_surface._content_contract_failures(
            arm.render,
            web_surface.RealContentExpectation(
                require_non_u16=True,
                min_channel_count=3,
                expected_channel=1,
                expected_contrast=(10.0, 200.0),
            ),
            2,
        )
        self.assertEqual(failures, [])

        arm.render["view"]["c"] = 0
        arm.render["view"]["layers"][0]["channel"] = 0
        failures = web_surface._content_contract_failures(
            arm.render,
            web_surface.RealContentExpectation(
                require_non_u16=True,
                min_channel_count=4,
                expected_channel=1,
                expected_contrast=(10.0, 201.0),
            ),
            2,
        )
        self.assertTrue(any("max channel count" in failure for failure in failures))
        self.assertTrue(any("rendered channel" in failure for failure in failures))
        self.assertTrue(any("rendered contrast" in failure for failure in failures))

    def test_fixture_contract_rejects_reported_dpr_without_scaled_backing_store(self) -> None:
        arm = passing_arm(2)
        arm.render["canvas_backing_width"] = 800
        arm.render["backing_to_client_x"] = 1

        failures = web_surface._content_contract_failures(
            arm.render,
            web_surface.RealContentExpectation(),
            2,
        )

        self.assertTrue(any("backing/client x-axis ratio" in failure for failure in failures))


class ScenarioBrowserMatrixTests(unittest.TestCase):
    def test_interaction_driver_is_explicitly_dpr2_not_an_implicit_dpr1(self) -> None:
        self.assertIn("device_scale_factor", _browser._UI_DRIVER)
        self.assertIn("deviceScaleFactor !== 2", _browser._UI_DRIVER)
        self.assertNotIn("deviceScaleFactor: 1", _browser._UI_DRIVER)

    def test_interaction_driver_enables_linux_software_webgpu(self) -> None:
        self.assertIn("const browserArgs = req.browser_args", _browser._UI_DRIVER)
        self.assertIn("args: browserArgs", _browser._UI_DRIVER)
        self.assertNotIn("browserArgs.filter", _browser._UI_DRIVER)

    def test_interaction_request_passes_the_platform_profile_to_playwright(self) -> None:
        expected = [
            "--enable-unsafe-webgpu",
            "--ignore-gpu-blocklist",
            "--no-first-run",
            "--no-default-browser-check",
            "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
            "--enable-gpu",
            "--enable-unsafe-swiftshader",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--use-vulkan=swiftshader",
            "--use-webgpu-adapter=swiftshader",
        ]
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"ran":true,"reason":"ok","steps":[],"shots_taken":[]}\n',
            stderr="",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with (
                patch.object(_browser, "capture_real_spa", return_value=web_surface.RealSpaResult(
                    captured=True,
                    ok=True,
                    reason="rendered",
                )),
                patch.object(_browser.shutil, "which", return_value="/node"),
                patch.object(_browser, "_ensure_playwright", return_value=root / "modules"),
                patch.object(_browser, "_system_browser_path", return_value="/browser"),
                patch.object(_browser, "headless_webgpu_browser_args", return_value=expected),
                patch.object(_browser, "run_group", return_value=completed) as run_group,
            ):
                result = _browser.drive_ui_program(
                    url="http://127.0.0.1/w/ws-test",
                    shots_dir=root / "shots",
                    steps=[],
                    init_scripts=[],
                    work_dir=root,
                    log=lambda _message: None,
                )

        request = json.loads(run_group.call_args.args[0][2])
        self.assertTrue(result.ran)
        self.assertEqual(request["browser_args"], expected)

    def test_failed_render_preflight_stops_before_mutating_steps(self) -> None:
        failed = web_surface.RealSpaResult(
            captured=False,
            ok=False,
            reason="DPR2: black canvas",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(_browser, "capture_real_spa", return_value=failed):
                result = _browser.drive_ui_program(
                    url="http://127.0.0.1/w/ws-test",
                    shots_dir=root / "shots",
                    steps=[_browser.UiStep(action="click_testid", testid="mutating")],
                    init_scripts=[],
                    work_dir=root,
                    log=lambda _message: None,
                )

        self.assertFalse(result.ran)
        self.assertIn("DPR1/2 render preflight failed", result.reason)
        self.assertEqual(result.steps, [])
        self.assertEqual(result.render_matrix, failed.to_dict())


if __name__ == "__main__":
    unittest.main()
