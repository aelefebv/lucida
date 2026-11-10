/**
 * Bytes held by the worker's GPU resources outside the chunk and label
 * pools: each view's layer targets and depth, the frames views that cover
 * part of the canvas keep, and the minimap's textures. Each owner sets its
 * line whenever it allocates or frees, so the budget can add them to the
 * pools without reaching into the owners' modules.
 */

export type GpuLedgerLine = "viewportTargets" | "depth" | "viewFrames" | "minimapTextures" | "minimapTargets";

const lines = new Map<GpuLedgerLine, number>();

export function setGpuLedgerLine(line: GpuLedgerLine, bytes: number): void {
  lines.set(line, bytes);
}

export function gpuLedgerLine(line: GpuLedgerLine): number {
  return lines.get(line) ?? 0;
}
