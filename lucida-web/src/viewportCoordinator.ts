import type { WasmScene } from "lucida-core";
import type { ViewportCommand } from "./commands.ts";
import { applyViewportCommand } from "./applyAndSend.ts";
import {
  invalidateAfterViewRestore,
  invalidateDisplaySettings,
  invalidateResidency,
  requestRender,
  type InvalidationSink,
} from "./invalidation.ts";
import {
  type HistoryRecordOptions,
  LocalViewHistory,
  type LocalViewHistoryState,
} from "./localViewHistory.ts";

export type ViewportInvalidation = "view" | "display" | "residency" | "restore" | "none";
export type ViewportPublication = "presence" | "dataset-presence" | "none";

export interface ViewportMutationOptions {
  source: string;
  breakFollow?: boolean;
  invalidation?: ViewportInvalidation;
  publication?: ViewportPublication;
  /** URL/last-view sync plus active saved-view invalidation. */
  recordLiveView?: boolean;
  history?: Omit<HistoryRecordOptions, "label"> & {
    label?: string;
    skip?: boolean;
  };
}

export interface ViewportHistorySnapshot {
  presence: string;
  datasetPresence: string;
}

export interface ViewportCoordinator {
  apply(
    commands: ViewportCommand | readonly ViewportCommand[],
    options: ViewportMutationOptions,
  ): boolean;
  transact(
    mutate: (scene: WasmScene, apply: (command: ViewportCommand) => void) => void,
    options: ViewportMutationOptions,
  ): boolean;
  /** Commit effects around a non-command scene mutation, such as a view restore. */
  commit(mutate: () => void, options: ViewportMutationOptions): boolean;
  checkpoint(): ViewportHistorySnapshot | null;
  commitExternal(
    before: ViewportHistorySnapshot | null,
    options: ViewportMutationOptions,
  ): boolean;
  undo(): boolean;
  redo(): boolean;
  endGesture(key: string): void;
  setHistoryScope(scope: string): void;
  getHistoryState(): LocalViewHistoryState;
  subscribeHistory(listener: () => void): () => void;
}

interface Dependencies {
  sceneRef: { current: WasmScene | null };
  loopRef: { current: InvalidationSink | null };
  breakFollow: () => void;
  emitPresence: () => void;
  emitDatasetPresence: () => void;
  recordLiveView: () => void;
  history?: LocalViewHistory<ViewportHistorySnapshot>;
  afterHistoryRestore?: (scene: WasmScene) => void;
}

const DEFAULTS = {
  breakFollow: true,
  invalidation: "view" as ViewportInvalidation,
  publication: "presence" as ViewportPublication,
  recordLiveView: true,
};

const EMPTY_HISTORY_STATE: LocalViewHistoryState = {
  canUndo: false,
  canRedo: false,
  undoReason: "Nothing to undo in this workspace",
  redoReason: "Nothing to redo in this workspace",
};

function snapshotsEqual(left: ViewportHistorySnapshot, right: ViewportHistorySnapshot): boolean {
  return left.presence === right.presence && left.datasetPresence === right.datasetPresence;
}

export function createViewportHistory(scope: string, capacity = 100) {
  return new LocalViewHistory<ViewportHistorySnapshot>(scope, snapshotsEqual, capacity);
}

function historyLabel(source: string): string {
  return source.replaceAll("_", " ");
}

/**
 * The single transaction boundary for local viewport mutations.
 *
 * Scene writes happen first. Only a successful write publishes follow, URL,
 * presence, saved-view, and repaint effects, and each effect is emitted once
 * for a whole command batch. This makes it impossible for annotation, camera,
 * collection, or dimension callers to remember only part of the contract.
 */
export function createViewportCoordinator(deps: Dependencies): ViewportCoordinator {
  const finish = (options: ViewportMutationOptions) => {
    const policy = { ...DEFAULTS, ...options };
    if (policy.breakFollow) deps.breakFollow();
    if (policy.publication === "presence") deps.emitPresence();
    else if (policy.publication === "dataset-presence") deps.emitDatasetPresence();
    if (policy.recordLiveView) deps.recordLiveView();

    const loop = deps.loopRef.current;
    if (policy.invalidation === "display") invalidateDisplaySettings(loop, policy.source);
    else if (policy.invalidation === "residency") invalidateResidency(loop, policy.source);
    else if (policy.invalidation === "restore") invalidateAfterViewRestore(loop, policy.source);
    else if (policy.invalidation === "view") requestRender(loop, policy.source);
  };

  const checkpoint = (): ViewportHistorySnapshot | null => {
    const scene = deps.sceneRef.current;
    if (!scene) return null;
    try {
      return {
        presence: scene.export_presence(),
        datasetPresence: scene.export_dataset_presence(),
      };
    } catch {
      // A narrow test stub or a scene being torn down may not expose a stable
      // snapshot. The mutation can still run, but history/rollback is
      // unavailable for that call.
      return null;
    }
  };

  const record = (
    before: ViewportHistorySnapshot | null,
    options: ViewportMutationOptions,
  ) => {
    if (!before || options.history?.skip || options.recordLiveView === false) return;
    const after = checkpoint();
    if (!after) return;
    deps.history?.record(before, after, {
      label: options.history?.label ?? historyLabel(options.source),
      ...(options.history?.coalesceKey !== undefined
        ? { coalesceKey: options.history.coalesceKey }
        : {}),
      ...(options.history?.coalesceWindowMs !== undefined
        ? { coalesceWindowMs: options.history.coalesceWindowMs }
        : {}),
      ...(options.history?.timestampMs !== undefined
        ? { timestampMs: options.history.timestampMs }
        : {}),
    });
  };

  const execute = (mutate: () => void, options: ViewportMutationOptions) => {
    if (!deps.sceneRef.current) return false;
    const before = checkpoint();
    try {
      mutate();
    } catch (error) {
      // A batch/restore is one user mutation. If any later command rejects,
      // restore both canonical local-presence slices before surfacing the
      // error; callers never observe a half-applied camera/display sequence.
      if (before) restore(before);
      throw error;
    }
    record(before, options);
    finish(options);
    return true;
  };

  const publishRestore = (source: string) => {
    const scene = deps.sceneRef.current;
    if (!scene) return;
    deps.afterHistoryRestore?.(scene);
    deps.breakFollow();
    deps.emitPresence();
    deps.emitDatasetPresence();
    deps.recordLiveView();
    invalidateAfterViewRestore(deps.loopRef.current, source);
  };

  const restore = (snapshot: ViewportHistorySnapshot) => {
    const scene = deps.sceneRef.current;
    if (!scene) throw new Error("Viewer is unavailable");
    scene.import_presence(snapshot.presence);
    scene.import_dataset_presence(snapshot.datasetPresence);
  };

  const commit = (mutate: () => void, options: ViewportMutationOptions) => {
    return execute(mutate, options);
  };

  return {
    apply(commands, options) {
      const scene = deps.sceneRef.current;
      if (!scene) return false;
      const batch: readonly ViewportCommand[] = Array.isArray(commands)
        ? commands
        : [commands as ViewportCommand];
      return execute(() => {
        for (const command of batch) applyViewportCommand(scene, command);
      }, options);
    },
    transact(mutate, options) {
      const scene = deps.sceneRef.current;
      if (!scene) return false;
      return execute(
        () => mutate(scene, (command) => applyViewportCommand(scene, command)),
        options,
      );
    },
    commit,
    checkpoint,
    commitExternal(before, options) {
      if (!deps.sceneRef.current) return false;
      record(before, options);
      publishRestore(options.source);
      return true;
    },
    undo() {
      if (!deps.sceneRef.current || !deps.history) return false;
      const changed = deps.history.undo(restore);
      if (changed) publishRestore("local_history_undo");
      return changed;
    },
    redo() {
      if (!deps.sceneRef.current || !deps.history) return false;
      const changed = deps.history.redo(restore);
      if (changed) publishRestore("local_history_redo");
      return changed;
    },
    endGesture(key) {
      deps.history?.endCoalescing(key);
    },
    setHistoryScope(scope) {
      deps.history?.setScope(scope);
    },
    getHistoryState() {
      return deps.history?.getState() ?? EMPTY_HISTORY_STATE;
    },
    subscribeHistory(listener) {
      return deps.history?.subscribe(listener) ?? (() => {});
    },
  };
}
