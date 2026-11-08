/**
 * What the user is told about the GPU. A lost device or a GPU error changes
 * what the canvas can show, and nothing on the canvas says so.
 */

import type { GpuStatus } from "../renderer/renderClient.ts";
import type { GpuErrorKind } from "../renderer/workerProtocol.ts";
import type { ToastOptions } from "../ui/toastQueue.ts";

/** One notice per kind in this long, however often the GPU repeats it. */
export const GPU_NOTICE_SPACING_MS = 60_000;

const NOTICES: Record<GpuErrorKind, ToastOptions> = {
  "device-lost": {
    title: "The GPU was reset",
    description: "The viewer is reloading its data onto the GPU.",
    tone: "info",
  },
  "out-of-memory": {
    title: "The GPU ran out of memory",
    description: "The viewer is holding less on the GPU, so parts of the view may load more slowly.",
    tone: "warning",
  },
  validation: {
    title: "The GPU reported an error",
    description: "What the canvas shows may be incomplete.",
    tone: "warning",
  },
  internal: {
    title: "The GPU reported an error",
    description: "What the canvas shows may be incomplete.",
    tone: "warning",
  },
};

/**
 * The toast for a GPU status, or null when there is none to show: a restored
 * device, a failure the banner explains, or a kind already shown within the
 * spacing. `shownAt` records when each kind was last shown.
 */
export function gpuNotice(
  status: GpuStatus,
  shownAt: Map<GpuErrorKind, number>,
  now: number,
): ToastOptions | null {
  if (status.type !== "gpuError") return null;
  const last = shownAt.get(status.kind);
  if (last !== undefined && now - last < GPU_NOTICE_SPACING_MS) return null;
  shownAt.set(status.kind, now);
  return NOTICES[status.kind];
}
