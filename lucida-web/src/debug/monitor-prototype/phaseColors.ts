/**
 * PROTOTYPE — throwaway. Issue #892.
 *
 * One colour per phase, shared by every variant so that a phase is the same
 * colour in the wall, the budget bar and the callout drill-in.
 */

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
