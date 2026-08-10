/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * Canvas sizing at the real devicePixelRatio. DPR-1-only verification has
 * hidden whole defect classes in this repo, and a timeline drawn at DPR 1 on a
 * retina display is exactly the kind of thing that looks fine in a screenshot
 * and is unreadable in the room.
 */

/** Resize the backing store to the element's CSS box at the true DPR. */
export function sizeToDpr(
  canvas: HTMLCanvasElement,
): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } | null {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

export const PHASE_COLORS: Record<string, string> = {
  plan: "#7c6cff",
  queue: "#ff6b4a",
  wire: "#ffb020",
  decode: "#3fc4a0",
  upload: "#4a9eff",
  present: "#9aa4b2",
  permit: "#ff8a5c",
  ttfb: "#ffd166",
  body: "#57d9a3",
  enqueue: "#8d99ae",
};
