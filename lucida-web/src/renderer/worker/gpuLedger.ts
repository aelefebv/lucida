/**
 * Bytes held by the worker's module-scoped GPU resources, the ones outside
 * `RendererState`: render targets and minimap textures. Each owner sets its
 * line whenever it allocates or frees, so the budget can add them to the
 * pools without reaching into the owners' modules.
 */

export type GpuLedgerLine = "viewportTargets" | "depth" | "minimapTextures" | "minimapTargets";

const lines = new Map<GpuLedgerLine, number>();

export function setGpuLedgerLine(line: GpuLedgerLine, bytes: number): void {
  lines.set(line, bytes);
}

export function gpuLedgerLine(line: GpuLedgerLine): number {
  return lines.get(line) ?? 0;
}
