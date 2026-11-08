/**
 * Scene-state epoch counters. Each field bumps when its slice of scene
 * state changes; consumers diff against their last read to detect what
 * changed. Only `request` is planning-owned (bumped by {@link plan}).
 */
export interface SceneEpochs {
  content: number;
  layout: number;
  view: number;
  selection: number;
  /** Bumped when Planning produces a new request plan. */
  request: number;
}
