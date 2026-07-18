/** Bounded, workspace-scoped history for local viewport state.
 *
 * The history stores semantic before/after snapshots supplied by the viewport
 * coordinator. It knows nothing about React or WASM, which keeps gesture
 * coalescing, branching, workspace isolation, and failure atomicity directly
 * testable without a browser.
 */

export interface HistoryRecordOptions {
  label: string;
  /** Consecutive records with the same key may collapse into one gesture. */
  coalesceKey?: string;
  /** Maximum gap between updates in one gesture. Omit for discrete actions. */
  coalesceWindowMs?: number;
  /** Deterministic clock seam for tests. */
  timestampMs?: number;
}

export interface LocalViewHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoReason: string;
  redoReason: string;
}

interface Entry<T> {
  before: T;
  after: T;
  label: string;
  coalesceKey?: string;
  timestampMs: number;
  sealed: boolean;
}

type Listener = () => void;

export class LocalViewHistory<T> {
  private scope: string;
  private readonly capacity: number;
  private readonly equal: (left: T, right: T) => boolean;
  private readonly past: Entry<T>[] = [];
  private readonly future: Entry<T>[] = [];
  private readonly listeners = new Set<Listener>();
  private state: LocalViewHistoryState;

  constructor(scope: string, equal: (left: T, right: T) => boolean, capacity = 100) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Local view history capacity must be a positive integer");
    }
    this.scope = scope;
    this.equal = equal;
    this.capacity = capacity;
    this.state = this.computeState();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): LocalViewHistoryState {
    return this.state;
  }

  private computeState(): LocalViewHistoryState {
    const undo = this.past[this.past.length - 1];
    const redo = this.future[this.future.length - 1];
    return {
      canUndo: Boolean(undo),
      canRedo: Boolean(redo),
      undoReason: undo ? `Undo ${undo.label}` : "Nothing to undo in this workspace",
      redoReason: redo ? `Redo ${redo.label}` : "Nothing to redo in this workspace",
    };
  }

  /** A workspace replacement starts a fresh local session by contract. */
  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.clear();
  }

  clear(): void {
    if (this.past.length === 0 && this.future.length === 0) return;
    this.past.length = 0;
    this.future.length = 0;
    this.emit();
  }

  record(before: T, after: T, options: HistoryRecordOptions): boolean {
    if (this.equal(before, after)) return false;
    const timestampMs = options.timestampMs ?? performance.now();
    const previous = this.past[this.past.length - 1];
    const windowMs = options.coalesceWindowMs;
    const canCoalesce =
      options.coalesceKey !== undefined
      && previous?.coalesceKey === options.coalesceKey
      && !previous.sealed
      && windowMs !== undefined
      && timestampMs - previous.timestampMs <= windowMs;

    if (canCoalesce) {
      previous.after = after;
      previous.timestampMs = timestampMs;
      previous.label = options.label;
    } else {
      this.past.push({
        before,
        after,
        label: options.label,
        coalesceKey: options.coalesceKey,
        timestampMs,
        sealed: false,
      });
      if (this.past.length > this.capacity) this.past.shift();
    }
    // Any new forward mutation invalidates the alternate redo branch.
    this.future.length = 0;
    this.emit();
    return true;
  }

  /** Seal a pointer/scrub gesture so the next gesture with the same source
   * starts a new history entry even if it occurs immediately. */
  endCoalescing(key: string): void {
    const previous = this.past[this.past.length - 1];
    if (previous?.coalesceKey === key) previous.sealed = true;
  }

  /** Restore first, move the stack second. A throwing restore leaves history
   * untouched, so a transient engine failure never lies about what was undone. */
  undo(restore: (snapshot: T) => void): boolean {
    const entry = this.past[this.past.length - 1];
    if (!entry) return false;
    restore(entry.before);
    this.past.pop();
    this.future.push(entry);
    this.emit();
    return true;
  }

  redo(restore: (snapshot: T) => void): boolean {
    const entry = this.future[this.future.length - 1];
    if (!entry) return false;
    restore(entry.after);
    this.future.pop();
    this.past.push(entry);
    this.emit();
    return true;
  }

  private emit(): void {
    this.state = this.computeState();
    for (const listener of this.listeners) listener();
  }
}

export type ViewerHistoryShortcut = "undo" | "redo";

function isNativeEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[role='dialog'], [role='menu'], [role='menubar']")) return true;
  if (target.closest("[contenteditable='true']")) return true;
  return Boolean(target.closest("input, textarea, select, button"));
}

/** Resolve only the platform undo/redo shortcuts that belong to the focused
 * viewer. Native editing, menus, dialogs, and controls always win. */
export function viewerHistoryShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "defaultPrevented" | "target">,
  viewer: HTMLElement | null,
): ViewerHistoryShortcut | null {
  if (event.defaultPrevented || event.altKey || !viewer) return null;
  if (!viewer.contains(event.target as Node | null)) return null;
  if (isNativeEditingContext(event.target)) return null;
  const accelerator = event.metaKey || event.ctrlKey;
  if (!accelerator) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}
