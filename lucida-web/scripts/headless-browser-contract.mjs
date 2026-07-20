const BASE_CAPTURE_ARGS = Object.freeze([
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--no-first-run",
  "--no-default-browser-check",
]);
const BASE_STRESS_ARGS = Object.freeze(["--enable-unsafe-webgpu"]);

const LINUX_SOFTWARE_WEBGPU_ARGS = Object.freeze([
  // Playwright already supplies CDPScreenshotNewSurface through an
  // --enable-features switch. Chromium only honors the last repeated switch,
  // so preserve that feature when enabling the Linux WebGPU backend.
  "--enable-features=CDPScreenshotNewSurface,Vulkan,WebGPU",
  // Headless Chrome otherwise forces software rendering before the explicit
  // SwiftShader drivers below can own an OffscreenCanvas in a render worker.
  "--enable-gpu",
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--use-vulkan=swiftshader",
  "--use-webgpu-adapter=swiftshader",
]);

function platformBrowserArgs(baseArguments, platform) {
  return platform === "linux"
    ? [...baseArguments, ...LINUX_SOFTWARE_WEBGPU_ARGS]
    : [...baseArguments];
}

export function headlessCaptureBrowserArgs(platform = process.platform) {
  return platformBrowserArgs(BASE_CAPTURE_ARGS, platform);
}

export function webGpuStressBrowserArgs(platform = process.platform) {
  return platformBrowserArgs(BASE_STRESS_ARGS, platform);
}

export function headlessCaptureLaunchOptions(executablePath, platform = process.platform) {
  return {
    headless: true,
    executablePath,
    args: headlessCaptureBrowserArgs(platform),
  };
}
