import type { SceneEpochs } from "./pipeline/epochs.ts";

export type ViewportLoadingPhase = "idle" | "evaluating" | "loading";

export interface ViewportLoadingState {
  phase: ViewportLoadingPhase;
  /** Render invalidation source that began the latest discrete navigation. */
  source: string | null;
  /** Known worker-missing chunks. Null until every active dataset reports. */
  missingChunks: number | null;
  /** Monotonic identity for component transitions and deterministic tests. */
  transitionId: number;
}

export interface ViewportLoadingStore {
  getViewportLoadingState(): ViewportLoadingState;
  subscribeViewportLoading(listener: () => void): () => void;
}

export const IDLE_VIEWPORT_LOADING_STATE: ViewportLoadingState = Object.freeze({
  phase: "idle",
  source: null,
  missingChunks: null,
  transitionId: 0,
});

/**
 * Render sources that replace the visible view rather than incrementally move
 * it. These are the transitions where an old image disappearing can otherwise
 * read as an empty dataset. Continuous pan/zoom and cosmetic invalidations stay
 * out so navigation never produces a blinking status chip.
 */
const DISCRETE_VIEW_SOURCES = new Set([
  "loop_start",
  "dataset_added",
  "dataset_manifest_updated",
  "dimension_z",
  "dimension_t",
  "dimension_c",
  "collection_group_click",
  "view_mode_toggle",
  "explore_navigation",
  "local_history_undo",
  "local_history_redo",
  "auto_fit_on_open",
  "auto_fit_on_snapshot",
]);

export function isDiscreteViewportTransition(source: string): boolean {
  return DISCRETE_VIEW_SOURCES.has(source);
}

interface Transition {
  id: number;
  source: string;
  targetFrameId: number;
  minimumEpochs: SceneEpochs;
  expectedDatasets: Set<string>;
  missingByDataset: Map<string, number>;
  presented: boolean;
}

/**
 * Pure state machine joining the three truthful renderer signals:
 *
 * 1. a discrete scene mutation promises a future main-view frame;
 * 2. the worker reports the current view's missing residency set per dataset;
 * 3. GPU completion acknowledges the correlated target frame.
 *
 * The indicator retires only when every active dataset reports zero missing
 * chunks and the target (or a newer) frame is presented. Frame ids and view
 * epochs reject late messages from rapid group/timepoint changes.
 */
export class ViewportLoadingTracker implements ViewportLoadingStore {
  private transition: Transition | null = null;
  private state = IDLE_VIEWPORT_LOADING_STATE;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  getViewportLoadingState = (): ViewportLoadingState => this.state;

  subscribeViewportLoading = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  begin(options: {
    source: string;
    targetFrameId: number;
    minimumEpochs: SceneEpochs;
    datasetIds: Iterable<string>;
  }): void {
    const expectedDatasets = new Set(options.datasetIds);
    if (expectedDatasets.size === 0) {
      this.reset();
      return;
    }
    const current = this.transition;
    if (
      current &&
      current.source === options.source &&
      current.targetFrameId === options.targetFrameId &&
      epochsEqual(current.minimumEpochs, options.minimumEpochs) &&
      setsEqual(current.expectedDatasets, expectedDatasets)
    ) {
      return;
    }
    this.transition = {
      id: this.nextId++,
      source: options.source,
      targetFrameId: options.targetFrameId,
      minimumEpochs: options.minimumEpochs,
      expectedDatasets,
      missingByDataset: new Map(),
      presented: false,
    };
    this.publish();
  }

  /**
   * Keep an active loading affordance attached to the latest visible camera
   * after continuous interaction. The user did not start a new discrete
   * transition, so the label/id stay stable, but residency and presentation
   * acknowledgements for the superseded pose must be discarded.
   */
  advance(options: {
    targetFrameId: number;
    minimumEpochs: SceneEpochs;
    datasetIds: Iterable<string>;
  }): void {
    const transition = this.transition;
    if (!transition) return;
    const expectedDatasets = new Set(options.datasetIds);
    if (expectedDatasets.size === 0) {
      this.reset();
      return;
    }
    if (
      transition.targetFrameId === options.targetFrameId &&
      epochsEqual(transition.minimumEpochs, options.minimumEpochs) &&
      setsEqual(transition.expectedDatasets, expectedDatasets)
    ) {
      return;
    }
    transition.targetFrameId = options.targetFrameId;
    transition.minimumEpochs = options.minimumEpochs;
    transition.expectedDatasets = expectedDatasets;
    transition.missingByDataset.clear();
    transition.presented = false;
    this.publish();
  }

  wantedSet(datasetId: string, epochs: SceneEpochs, missingChunks: number): void {
    const transition = this.transition;
    if (
      !transition ||
      !transition.expectedDatasets.has(datasetId) ||
      epochsOlderThan(epochs, transition.minimumEpochs)
    ) {
      return;
    }
    transition.missingByDataset.set(datasetId, Math.max(0, missingChunks));
    this.publish();
  }

  framePresented(frameId: number): void {
    const transition = this.transition;
    if (!transition || frameId < transition.targetFrameId) return;
    transition.presented = true;
    this.publish();
  }

  removeDataset(datasetId: string): void {
    const transition = this.transition;
    if (!transition || !transition.expectedDatasets.delete(datasetId)) return;
    transition.missingByDataset.delete(datasetId);
    this.publish();
  }

  reset(): void {
    if (this.transition === null && this.state === IDLE_VIEWPORT_LOADING_STATE) return;
    this.transition = null;
    this.setState(IDLE_VIEWPORT_LOADING_STATE);
  }

  private publish(): void {
    const transition = this.transition;
    if (!transition || transition.expectedDatasets.size === 0) {
      this.reset();
      return;
    }

    let knownMissing = 0;
    for (const count of transition.missingByDataset.values()) knownMissing += count;
    const allReported = transition.missingByDataset.size === transition.expectedDatasets.size;
    if (allReported && knownMissing === 0 && transition.presented) {
      this.transition = null;
      this.setState(IDLE_VIEWPORT_LOADING_STATE);
      return;
    }

    this.setState({
      phase: allReported && knownMissing > 0 ? "loading" : "evaluating",
      source: transition.source,
      missingChunks: allReported ? knownMissing : null,
      transitionId: transition.id,
    });
  }

  private setState(next: ViewportLoadingState): void {
    if (
      this.state.phase === next.phase &&
      this.state.source === next.source &&
      this.state.missingChunks === next.missingChunks &&
      this.state.transitionId === next.transitionId
    ) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function epochsEqual(left: SceneEpochs, right: SceneEpochs): boolean {
  return left.content === right.content &&
    left.layout === right.layout &&
    left.view === right.view &&
    left.selection === right.selection &&
    left.request === right.request;
}

function epochsOlderThan(value: SceneEpochs, minimum: SceneEpochs): boolean {
  return value.content < minimum.content ||
    value.layout < minimum.layout ||
    value.view < minimum.view ||
    value.selection < minimum.selection ||
    value.request < minimum.request;
}
