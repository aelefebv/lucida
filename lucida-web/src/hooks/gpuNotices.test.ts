import { describe, expect, it } from "vitest";

import type { GpuErrorKind } from "../renderer/workerProtocol.ts";
import { GPU_NOTICE_SPACING_MS, gpuNotice } from "./gpuNotices.ts";

const error = (kind: GpuErrorKind) => ({ type: "gpuError", kind, message: "m", count: 1 }) as const;

describe("gpuNotice", () => {
  it("shows each kind once within the spacing, and again after it", () => {
    const shown = new Map<GpuErrorKind, number>();
    expect(gpuNotice(error("validation"), shown, 0)?.title).toBe("The GPU reported an error");
    expect(gpuNotice(error("validation"), shown, GPU_NOTICE_SPACING_MS - 1)).toBeNull();
    expect(gpuNotice(error("out-of-memory"), shown, 10)?.title).toBe("The GPU ran out of memory");
    expect(gpuNotice(error("validation"), shown, GPU_NOTICE_SPACING_MS)).not.toBeNull();
  });

  it("leaves a restored device unannounced and a failed one to the banner", () => {
    const shown = new Map<GpuErrorKind, number>();
    expect(gpuNotice({ type: "gpuDeviceRestored" }, shown, 0)).toBeNull();
    expect(gpuNotice({ type: "gpuFailed", message: "gone" }, shown, 0)).toBeNull();
  });
});
