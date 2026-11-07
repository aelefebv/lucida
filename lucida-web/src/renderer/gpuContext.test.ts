import { describe, expect, it } from "vitest";
import { webGpuUnavailableReason } from "./gpuContext.ts";

describe("webGpuUnavailableReason", () => {
  it("tells a browser without WebGPU from one without an adapter", () => {
    expect(webGpuUnavailableReason("WebGPU is not supported in this browser")).toBe("missing");
    expect(webGpuUnavailableReason("Error: Failed to get WebGPU adapter")).toBe("no-adapter");
  });

  it("leaves every other init failure to the error banner", () => {
    expect(webGpuUnavailableReason("Failed to get WebGPU canvas context")).toBeNull();
    expect(webGpuUnavailableReason("pipeline compile failed")).toBeNull();
  });
});
