"""Canonical Playwright launch arguments for real-browser tryout surfaces."""

from __future__ import annotations

import sys


BASE_HEADLESS_WEBGPU_ARGS = (
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--no-first-run",
    "--no-default-browser-check",
)
LINUX_SOFTWARE_WEBGPU_ARGS = (
    # Playwright already supplies CDPScreenshotNewSurface through an
    # --enable-features switch. Chromium only honors the last repeated switch,
    # so preserve that feature when enabling the Linux WebGPU backend.
    "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--use-webgpu-adapter=swiftshader",
)


def headless_webgpu_browser_args(platform: str | None = None) -> list[str]:
    """Return the exact platform launch profile passed to Playwright."""

    selected = sys.platform if platform is None else platform
    arguments = list(BASE_HEADLESS_WEBGPU_ARGS)
    if selected.startswith("linux"):
        arguments.extend(LINUX_SOFTWARE_WEBGPU_ARGS)
    return arguments
