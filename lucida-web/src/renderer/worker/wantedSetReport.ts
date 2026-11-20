/**
 * The worker's wanted-set report to the page: for each view's draw of a
 * dataset, the wanted chunks it lacks that the page has not been told of,
 * and which levels its entities show.
 *
 * A report goes out at the next {@link WantedSetReporter.flush}, once a
 * frame, so a frame's many uploads make one report. Each draw keeps its
 * reading between reports (`WantedSetTracker`), and every pool notes the
 * slot keys it held or let go (`SlotJournal`), so a report costs what
 * changed since the last one, not what the views hold or want.
 *
 * The page checks each chunk a report names against its residency mirror,
 * and one the mirror holds is a disagreement. A chunk is named when it
 * becomes wanted and is lacking, and again whenever its slot changes and it
 * is lacking after, so a slot let go without a loss reported is named at
 * the next report.
 */

import type { PoolMode, MissingChunk, WorkerToMainMessage } from "../workerProtocol.ts";
import type { SliceAtlasState } from "../slice/atlas.ts";
import type { AtlasState } from "../volume/atlas.ts";
import { computeWantedSet, WantedSetTracker, type AtlasSnapshot, type SlotChanges, type SourcePoolResolver } from "../wantedSet.ts";
import { sourceKey } from "../poolKeys.ts";
import type { RendererState, ViewDraw } from "./state.ts";
import { drawOf, drawsOf } from "./draws.ts";

export class WantedSetReporter {
  private readonly state: RendererState;
  private readonly post: (msg: WorkerToMainMessage) => void;
  private readonly trackers = new WeakMap<ViewDraw, WantedSetTracker>();
  private readonly due = new Set<ViewDraw>();

  constructor(state: RendererState, post: (msg: WorkerToMainMessage) => void) {
    this.state = state;
    this.post = post;
  }

  /**
   * Report at the next flush each view that draws one dataset from its pools
   * of `mode`, or from either mode's when `mode` is absent, or `view` alone:
   * the dataset named, else the view whose cold state arrived last.
   */
  request(datasetId?: string, mode?: PoolMode, view?: number): void {
    const state = this.state;
    if (datasetId === undefined) {
      const cold = state.currentColdState;
      const draw = cold ? drawOf(state, cold.datasetId, cold.view) : undefined;
      if (draw) this.due.add(draw);
      return;
    }
    for (const draw of drawsOf(state, datasetId, mode)) {
      if (view === undefined || draw.view === view) this.due.add(draw);
    }
  }

  /**
   * Post the report of every view asked for since the last flush, and of
   * every view reading a pool whose slots changed since it. A view with
   * nothing new posts nothing.
   */
  flush(): void {
    const state = this.state;
    const changes = { volume: drainJournals(state.volumeAtlases), slice: drainJournals(state.sliceAtlases) };
    if (this.due.size === 0 && changes.volume.size === 0 && changes.slice.size === 0) return;
    // Only views still drawn: one released since it was asked for has told
    // the page it shows nothing.
    for (const draw of state.draws.values()) {
      const poolChanges = changes[draw.mode];
      const snapshots = viewSnapshots(draw.mode === "volume" ? state.volumeAtlases : state.sliceAtlases, draw);
      if (!this.due.has(draw) && !readsAny(snapshots, poolChanges)) continue;
      this.report(draw, snapshots, poolChanges);
    }
    this.due.clear();
  }

  /** What `datasetId`'s views want and lack, all of it, computed now from nothing kept. */
  lackingNow(datasetId: string): MissingChunk[] {
    const missing: MissingChunk[] = [];
    for (const draw of drawsOf(this.state, datasetId)) {
      const snapshots = viewSnapshots(draw.mode === "volume" ? this.state.volumeAtlases : this.state.sliceAtlases, draw);
      const result = computeWantedSet(
        draw.cold,
        draw.wanted,
        draw.mode === "volume" ? snapshots : new Map(),
        draw.mode === "slice" ? snapshots : new Map(),
        routesOf(draw),
      );
      missing.push(...result.missing);
    }
    return missing;
  }

  private report(draw: ViewDraw, snapshots: Map<string, AtlasSnapshot>, changes: ReadonlyMap<string, SlotChanges>): void {
    const { cold, mode } = draw;
    let tracker = this.trackers.get(draw);
    if (!tracker) this.trackers.set(draw, (tracker = new WantedSetTracker()));
    const update = tracker.update(
      cold,
      draw.wanted,
      mode === "volume" ? snapshots : new Map(),
      mode === "slice" ? snapshots : new Map(),
      routesOf(draw),
      (poolKey) => changes.get(poolKey),
    );
    if (update.missing.length > 0) {
      const epochs = cold === this.state.currentColdState ? this.state.currentEpochs ?? cold.epochs : cold.epochs;
      this.post({ type: "wantedSetDelta", datasetId: cold.datasetId, viewMode: mode, epochs, missing: update.missing });
    }
    if (update.levels !== null) {
      this.post({ type: "entityLevels", datasetId: cold.datasetId, view: draw.view, entities: update.levels });
    }
  }
}

function routesOf(draw: ViewDraw): SourcePoolResolver {
  return (memberId, tier, level) => draw.routes.get(memberId)?.get(sourceKey(tier, level));
}

/** Each pool's slot changes since the last drain, of the pools that have any. */
function drainJournals(atlases: ReadonlyMap<string, SliceAtlasState | AtlasState>): Map<string, SlotChanges> {
  const out = new Map<string, SlotChanges>();
  for (const [poolKey, atlas] of atlases) {
    if (!atlas.journal.empty) out.set(poolKey, atlas.journal.drain());
  }
  return out;
}

function readsAny(snapshots: ReadonlyMap<string, AtlasSnapshot>, changes: ReadonlyMap<string, SlotChanges>): boolean {
  if (changes.size === 0) return false;
  for (const poolKey of snapshots.keys()) if (changes.has(poolKey)) return true;
  return false;
}

/**
 * The pools `draw`'s view draws from, each as that view samples it: the
 * shared slots, read through the view's sections at the view's Z.
 */
function viewSnapshots(
  atlases: ReadonlyMap<string, SliceAtlasState | AtlasState>,
  draw: ViewDraw,
): Map<string, AtlasSnapshot> {
  const out = new Map<string, AtlasSnapshot>();
  for (const [poolKey, atlas] of atlases) {
    const view = atlas.views.get(draw.view);
    if (!view || atlas.datasetId !== draw.datasetId) continue;
    out.set(poolKey, {
      z: draw.cold.currentZ,
      slots: atlas.slots,
      planesByChunk: "planesByChunk" in atlas ? atlas.planesByChunk : undefined,
      entityMetas: view.entityMetas,
    });
  }
  return out;
}
