import assert from "node:assert/strict";

import {
  headlessCaptureBrowserArgs,
  headlessCaptureLaunchOptions,
  webGpuStressBrowserArgs,
} from "./headless-browser-contract.mjs";

const linuxSoftwareArgs = [
  "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--use-webgpu-adapter=swiftshader",
];
const captureBase = [
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--no-first-run",
  "--no-default-browser-check",
];

assert.deepEqual(headlessCaptureBrowserArgs("darwin"), captureBase);
assert.deepEqual(headlessCaptureBrowserArgs("win32"), captureBase);
assert.deepEqual(headlessCaptureBrowserArgs("linux"), [...captureBase, ...linuxSoftwareArgs]);
assert.deepEqual(webGpuStressBrowserArgs("darwin"), ["--enable-unsafe-webgpu"]);
assert.deepEqual(webGpuStressBrowserArgs("win32"), ["--enable-unsafe-webgpu"]);
assert.deepEqual(
  webGpuStressBrowserArgs("linux"),
  ["--enable-unsafe-webgpu", ...linuxSoftwareArgs],
);
assert.deepEqual(headlessCaptureLaunchOptions("/browser", "linux"), {
  headless: true,
  executablePath: "/browser",
  args: [...captureBase, ...linuxSoftwareArgs],
});
