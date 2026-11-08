/**
 * Scene-invalidation intents. A scene mutation becomes visible only when it
 * both bumps the settings generation (so the planner re-reads settings from
 * wasm) and marks the render loop dirty (so a tick runs). Either one alone is
 * a silent no-op, so call sites state what happened and both land together,
 * in the same task. Every intent also tells the scene store, so what React
 * reads moves in the same task.
 *
 * `interactive` renders next frame; `residency` alone renders on the
 * throttled ~30 fps cadence while the tick still runs every frame.
 */
import { noteSceneWrite } from "./sceneStore.ts";
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
 *  is accepted (no loop mounted yet); the generation bump still happens, so
 *  the first tick of a later-mounted loop reads fresh settings. */
export interface InvalidationSink {
  markInteractiveDirty(source?: string): void;
  markResidencyDirty(source?: string): void;
  /** An interactive dirty that the trace recorder hears by input name. */
  markInput(input: InputKind): void;
}

/**
 * Dataset/channel/label display settings (or dataset order) changed in the
 * scene, e.g. a `set_*` display command was applied, or peer dataset
 * presence was imported. The planner must re-read the settings snapshot and
 * the user expects the frame now.
 */
export function invalidateDisplaySettings(
  loop: InvalidationSink | null | undefined,
  source: string = "display_settings",
): void {
  bumpSettingsGeneration();
  loop?.markInteractiveDirty(source);
  noteSceneWrite();
}

/**
 * A channel, a dataset, or a label was shown or hidden. For the planner this
 * is a display-settings change like {@link invalidateDisplaySettings}. For
 * the trace recorder it is a select, one of the inputs that open an
 * interaction run, so the loop hears it under that name.
 */
export function invalidateSelection(loop: InvalidationSink | null | undefined): void {
  bumpSettingsGeneration();
  loop?.markInput("select");
  noteSceneWrite();
}

/**
 * Display settings changed from a *data-driven* source (e.g. auto-contrast
 * adopting a freshly reported intensity range): the planner must re-read
 * settings, but the render may ride the throttled residency cadence, since
 * these arrive in bursts during loading and don't warrant a frame each.
 */
export function invalidateResidency(
  loop: InvalidationSink | null | undefined,
  source: string = "residency_settings",
): void {
  bumpSettingsGeneration();
  loop?.markResidencyDirty(source);
  noteSceneWrite();
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
  noteSceneWrite();
}

/**
 * View-only change: camera moved, an overlay or cursor needs reprojection, a
 * debug surface toggled. No scene settings were touched, so no generation
 * bump.
 */
export function requestRender(
  loop: InvalidationSink | null | undefined,
  source: string = "render_request",
): void {
  loop?.markInteractiveDirty(source);
  noteSceneWrite();
}
