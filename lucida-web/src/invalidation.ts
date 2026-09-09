/**
 * Composed scene-invalidation intents.
 *
 * A user action that mutates the scene must reach two independent JS-side
 * mechanisms for the change to become visible:
 *
 *   1. `bumpSettingsGeneration()` (tickCommon.ts) — invalidates the cached
 *      `SceneSettings` snapshot so the planner (`TickCoordinator.planAndFetch`
 *      → `getSceneSettings`) re-reads dataset order + display settings from
 *      WASM on its next run.
 *   2. `RenderLoop.markInteractiveDirty()` / `markResidencyDirty()` — schedule
 *      the RAF tick that actually runs the planner and renders.
 *
 * Tapping these individually at every call site invites a silent-no-op bug
 * class: a generation bump without a dirty mark leaves the change invisible
 * until something else wakes the loop (the bump never schedules work by
 * itself), while a dirty mark without a bump lets the tick plan against the
 * stale cached settings. This module exports the taps composed by *intent*,
 * so a call site states what happened and the right flags land together.
 *
 * Ordering: within one intent the relative order of the generation bump and
 * the dirty marks is immaterial. The dirty mark only schedules a
 * `requestAnimationFrame` callback, which cannot preempt the current task,
 * and the tick reads the generation lazily (`getSceneSettings` compares
 * counters when it runs) — so the tick observes every tap made in the same
 * synchronous task, whatever their order. What *does* matter is that all taps
 * for one mutation land in the same task, which composing them guarantees.
 *
 * Dirty-kind semantics (see renderLoop.ts): `interactive` renders on the next
 * frame and clears both flags; `residency` alone renders on the throttled
 * ~30 fps cadence (`RESIDENCY_RENDER_INTERVAL_MS`), though the tick itself —
 * planning and uploads — still runs every frame while it is set.
 */
import { bumpSettingsGeneration } from "./tickCommon.ts";
import type { InputKind } from "./trace/types.ts";

/**
 * The dirty source a generated-availability update from the server marks the
 * loop under. Named once, because a tick woken by this source alone is one
 * turn of the server and the client answering each other, and the loop tells
 * the recorder so through {@link TickWake}.
 */
export const AVAILABILITY_UPDATE_SOURCE = "generated_availability_update";

/**
 * What has dirtied the loop since the tick before, reduced to the one
 * question the trace asks: was it an availability update and nothing else?
 * Two booleans rather than a set of sources, because the tick reads it once
 * and the answer is one bit on the per-tick sample.
 */
export class TickWake {
  private availability = false;
  /** The first tick is the loop's own start, which nothing announced. */
  private other = true;

  note(source: string): void {
    if (source === AVAILABILITY_UPDATE_SOURCE) this.availability = true;
    else this.other = true;
  }

  /**
   * True when availability alone woke the tick about to run. Clears both
   * marks, so what the tick itself dirties counts toward the next one.
   */
  take(): boolean {
    const alone = this.availability && !this.other;
    this.availability = false;
    this.other = false;
    return alone;
  }
}

/** The dirty-flag surface these intents drive. `RenderLoop` satisfies it
 *  structurally; tests can substitute a recording double. `null`/`undefined`
 *  is accepted (no loop mounted yet) — the generation bump still happens, so
 *  the first tick of a later-mounted loop reads fresh settings. */
export interface InvalidationSink {
  markInteractiveDirty(source?: string): void;
  markResidencyDirty(source?: string): void;
  /** An interactive dirty that the trace recorder hears by input name. */
  markInput(input: InputKind): void;
}

/**
 * Dataset/channel/label display settings (or dataset order) changed in the
 * scene — e.g. a `set_*` display command was applied, or peer dataset
 * presence was imported. The planner must re-read the settings snapshot and
 * the user expects the frame now.
 */
export function invalidateDisplaySettings(
  loop: InvalidationSink | null | undefined,
  source: string = "display_settings",
): void {
  bumpSettingsGeneration();
  loop?.markInteractiveDirty(source);
}

/**
 * A channel, a dataset, or a label was shown or hidden. For the planner this
 * is a display-settings change like {@link invalidateDisplaySettings}. For
 * the trace recorder it is a select, one of the five inputs that open an
 * interaction run, so the loop hears it under that name.
 */
export function invalidateSelection(loop: InvalidationSink | null | undefined): void {
  bumpSettingsGeneration();
  loop?.markInput("select");
}

/**
 * Display settings changed from a *data-driven* source (e.g. auto-contrast
 * adopting a freshly reported intensity range): the planner must re-read
 * settings, but the render may ride the throttled residency cadence — these
 * arrive in bursts during loading and don't warrant a frame each.
 */
export function invalidateResidency(
  loop: InvalidationSink | null | undefined,
  source: string = "residency_settings",
): void {
  bumpSettingsGeneration();
  loop?.markResidencyDirty(source);
}

/**
 * A whole view was just written into the scene (camera + z/t/c + display),
 * e.g. a saved-view apply or an annotation-view restore. Everything the
 * planner and renderer derive from the scene is suspect: re-read settings,
 * render immediately, and leave the residency trail marked so the follow-up
 * data work (fetch/upload for the new viewport) is attributed to the restore.
 */
export function invalidateAfterViewRestore(
  loop: InvalidationSink | null | undefined,
  source: string = "view_restore",
): void {
  bumpSettingsGeneration();
  loop?.markInteractiveDirty(source);
  loop?.markResidencyDirty(source);
}

/**
 * View-only change — camera moved, an overlay/cursor needs reprojection, a
 * debug surface toggled. No scene settings were touched, so no generation
 * bump: just schedule a prompt frame.
 */
export function requestRender(
  loop: InvalidationSink | null | undefined,
  source: string = "render_request",
): void {
  loop?.markInteractiveDirty(source);
}
