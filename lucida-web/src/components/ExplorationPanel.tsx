// The human-facing "guided exploration" panel.
//
// Guided exploration asks one question: from *this* view of a dataset, what are
// the small, sensible moves a user might want to take next — and what does each
// one land on? The pure generator that answers it lives in
// `lucida_core::view_transform` (shared by the CLI + Python surfaces); this panel
// is the web surface over its wasm export (`explore_view`).
//
// It is deliberately a thin, prop-driven component in the spirit of
// `WorkspaceSavedViewsSidebar`: it reads the current view via `captureBuilder`,
// asks the generator for candidate next-steps, renders them as plain-language
// clickable rows, and drives navigation through the callbacks App.tsx wires in.
// Candidates are LABELLED ROWS, not rendered thumbnails — thumbnail rendering is
// a deferred polish, called out in the slice plan.

import { useCallback, useEffect, useRef, useState } from "react";
import { explore_view } from "lucida-core";
import type { WasmScene } from "lucida-core";
import { applyViewportCommand } from "../applyAndSend.ts";
import type { SavedView } from "../savedView/types.ts";
import "./BookmarkSidebar.css";
import "./ExplorationPanel.css";

/** Dataset shape in canonical `[T, C, Z, Y, X]` order (the OME-Zarr level shape
 *  the rest of the app uses — see `useDimensions`/`Axis`). */
export type Dims = readonly [number, number, number, number, number];

/** One offered next-step, mirroring `lucida_core::view_transform::ExplorationCell`
 *  (only the fields this panel reads). The `view` is a full `SavedView` to
 *  descend into. */
interface ExplorationCell {
  handle: string;
  transform: string;
  label: string;
  view: SavedView;
}

/** The parsed shape of `explore_view`'s JSON — either an error envelope or a
 *  sidecar (`ExplorationSidecar`). */
interface ExplorationSidecar {
  v: number;
  current: { handle: string; view: SavedView };
  cells: ExplorationCell[];
}

export interface ExplorationPanelProps {
  visible: boolean;
  /** Live scene ref (read at call time, never during render) — drives the MAIN
   *  view for the manual control buttons via `applyViewportCommand`. */
  wasmSceneRef: React.RefObject<WasmScene | null>;
  /** Capture the current view as a `SavedView` (App's
   *  `savedViewSync.captureBuilder`). Null when no scene exists yet. */
  captureBuilder: () => SavedView | null;
  /** Descend into a view: apply it to the viewer, then notify saved-view sync.
   *  App.tsx defines this as `savedViewApplier.apply(v)` + notify + breakFollow. */
  applyView: (view: SavedView) => Promise<void>;
  /** Called after a manual camera nudge (Rotate/Zoom) mutates the scene via
   *  `applyViewportCommand`. App.tsx wires this to mark the render loop dirty
   *  (so the canvas repaints — `applyViewportCommand` alone does NOT), break
   *  peer-follow, and co-tap presence/URL. Optional so the panel still works in
   *  isolation (tests), but always supplied by App.tsx. */
  onViewportChanged?: () => void;
  /** Bookmark the current view (App's workspace `createSavedView`). Always saved
   *  as an ephemeral PERSONAL view — guided exploration never auto-shares. */
  createSavedView: (
    name: string,
    view: SavedView,
    visibility: "personal",
  ) => Promise<unknown>;
  /** First visible dataset's id, or null when nothing is loaded. */
  datasetId: string | null;
  /** Human name of the first visible dataset (for the header). */
  datasetName?: string | null;
  /** First visible dataset's `[T, C, Z, Y, X]` shape, or null. */
  dims: Dims | null;
  /** Current viewport size in CSS px (for the synthesized Home camera). */
  viewport: readonly [number, number];
  /** Whether the main view is currently in a rotatable 3D mode (arcball). The
   *  rotate buttons drive the live camera, so they're only meaningful in 3D. */
  is3D: boolean;
  style?: React.CSSProperties;
}

// Canonical manual-control deltas, matched to the generator's move-set so the
// MAIN-view buttons feel like the offered cells: a 45° orbit and a 2x zoom.
const ROTATE_RAD = 0.785; // ~45°
// 2D slice `zoom_by` factors (> 1 zooms in).
const ZOOM_IN = 2.0;
const ZOOM_OUT = 0.5;
// 3D arcball `arcball_zoom` step: `distance *= (1 + delta)`, so a NEGATIVE delta
// pulls the eye closer (zoom in). 0.5 halves/doubles the distance, mirroring the
// 2x slice factor.
const ARCBALL_ZOOM_STEP = 0.5;

/** Run the generator for `current` (or Home when `current` is null) and return
 *  the parsed result. Centralizes the JSON.stringify → wasm → JSON.parse hop so
 *  both `refresh()` and the Home helper share one code path. `depth` is the
 *  caller's walk depth (the breadcrumb length) so the sidecar's recorded depth is
 *  honest. */
function runExplore(
  current: SavedView | null,
  datasetId: string,
  dims: Dims,
  viewport: readonly [number, number],
  depth: number,
): { sidecar?: ExplorationSidecar; error?: string } {
  const [t, c, z, y, x] = dims;
  const [vw, vh] = viewport;
  const viewJson = current ? JSON.stringify(current) : undefined;
  let raw: string;
  try {
    raw = explore_view(
      viewJson,
      datasetId,
      Math.max(0, Math.floor(t)),
      Math.max(0, Math.floor(c)),
      Math.max(0, Math.floor(z)),
      Math.max(0, Math.floor(y)),
      Math.max(0, Math.floor(x)),
      Math.max(1, Math.floor(vw)),
      Math.max(1, Math.floor(vh)),
      Math.max(0, Math.floor(depth)),
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `Could not read suggestions: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    return { error: String((parsed as { error: unknown }).error) };
  }
  return { sidecar: parsed as ExplorationSidecar };
}

export function ExplorationPanel({
  visible,
  wasmSceneRef,
  captureBuilder,
  applyView,
  onViewportChanged,
  createSavedView,
  datasetId,
  datasetName,
  dims,
  viewport,
  is3D,
  style,
}: ExplorationPanelProps) {
  const [cells, setCells] = useState<ExplorationCell[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Where-you-came-from stack of SavedViews, for the Back button. The stack
  // itself lives in a ref so the async handlers can push/pop it deterministically
  // (a value read from inside a setState updater is NOT guaranteed available on
  // the next line, and StrictMode double-invokes updaters); `backDepth` mirrors
  // its length purely to re-render the Back button's enabled state.
  const backRef = useRef<SavedView[]>([]);
  const [backDepth, setBackDepth] = useState(0);
  const pushBack = useCallback((view: SavedView) => {
    backRef.current = [...backRef.current, view];
    setBackDepth(backRef.current.length);
  }, []);
  const popBack = useCallback((): SavedView | undefined => {
    const view = backRef.current[backRef.current.length - 1];
    if (view !== undefined) {
      backRef.current = backRef.current.slice(0, -1);
      setBackDepth(backRef.current.length);
    }
    return view;
  }, []);

  // The trail of moves taken from Home to here — plain-language labels, rendered
  // at the top of the panel. Without thumbnails this is the user's PRIMARY proof
  // that a click/nudge navigated (the candidate list and the slice number are
  // invariant under rotate/zoom). State drives the render; a ref mirror gives the
  // handlers the current length to pass as the generator's `depth` at call time.
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const breadcrumbRef = useRef<string[]>([]);
  const setTrail = useCallback((next: string[]) => {
    breadcrumbRef.current = next;
    setBreadcrumb(next);
  }, []);
  const pushTrail = useCallback(
    (label: string) => setTrail([...breadcrumbRef.current, label]),
    [setTrail],
  );
  const popTrail = useCallback(
    () => setTrail(breadcrumbRef.current.slice(0, -1)),
    [setTrail],
  );

  // A one-line "you are here" summary derived from the current view.
  const [hereLabel, setHereLabel] = useState<string>("");

  // Reference arcball distance for the "zoom Nx" closeness readout: captured the
  // first time we're at the exploration root (empty trail) with a 3D camera, so
  // Home reads "zoom 1.0x" and a zoom-in reads ">1x". Reset on Home.
  const homeDistanceRef = useRef<number | undefined>(undefined);

  // Latest onViewportChanged repaint hook, read at call time so the nudge
  // handler identity stays stable.
  const onViewportChangedRef = useRef(onViewportChanged);
  // eslint-disable-next-line react-hooks/refs
  onViewportChangedRef.current = onViewportChanged;

  // Latest props the imperative handlers read at call time, kept in refs so the
  // handler identities stay stable (mirrors the ref pattern in the saved-views
  // sidebar). These are read inside callbacks, never during render.
  const captureBuilderRef = useRef(captureBuilder);
  // eslint-disable-next-line react-hooks/refs
  captureBuilderRef.current = captureBuilder;
  const datasetIdRef = useRef(datasetId);
  // eslint-disable-next-line react-hooks/refs
  datasetIdRef.current = datasetId;
  const dimsRef = useRef(dims);
  // eslint-disable-next-line react-hooks/refs
  dimsRef.current = dims;
  const viewportRef = useRef(viewport);
  // eslint-disable-next-line react-hooks/refs
  viewportRef.current = viewport;

  // Generate (or regenerate) the candidate next-steps from the CURRENT view.
  // Captures the live view, runs the generator, and either surfaces an error or
  // sets the candidate rows. Stable identity (reads everything via refs).
  const refresh = useCallback(() => {
    const dsId = datasetIdRef.current;
    const ds = dimsRef.current;
    if (!dsId || !ds) {
      setCells([]);
      setError(null);
      setHereLabel("");
      return;
    }
    const current = captureBuilderRef.current();
    const { sidecar, error: err } = runExplore(
      current,
      dsId,
      ds,
      viewportRef.current,
      breadcrumbRef.current.length,
    );
    if (err || !sidecar) {
      setError(err ?? "No suggestions available.");
      setCells([]);
      return;
    }
    setError(null);
    setCells(sidecar.cells);
    // At the exploration root (empty trail) with a 3D camera, record the arcball
    // distance as the zoom reference so Home reads "zoom 1.0x".
    const cam = sidecar.current.view.camera;
    if (breadcrumbRef.current.length === 0 && cam.mode === "arcball" && cam.distance > 0) {
      homeDistanceRef.current = cam.distance;
    }
    setHereLabel(describeView(sidecar.current.view, ds, homeDistanceRef.current));
  }, []);

  // Refresh when the panel becomes visible (and whenever the dataset/dims it's
  // pointed at change while open) so the menu reflects the live view.
  useEffect(() => {
    if (!visible) return;
    refresh();
  }, [visible, datasetId, dims, refresh]);

  // Descend into a candidate: remember where we are (for Back), apply the
  // candidate's view to the viewer, then regenerate the menu from there.
  const descend = useCallback(
    async (cell: ExplorationCell) => {
      const current = captureBuilderRef.current();
      try {
        await applyView(cell.view);
      } catch (e) {
        setError(`Could not open that view: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (current) pushBack(current);
      pushTrail(cell.label);
      refresh();
    },
    [applyView, pushBack, pushTrail, refresh],
  );

  // Back: pop the previous view (and the matching trail step), then apply it
  // (without pushing onto the stack).
  const goBack = useCallback(async () => {
    const prevView = popBack();
    if (!prevView) return;
    try {
      await applyView(prevView);
    } catch (e) {
      setError(`Could not go back: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    popTrail();
    refresh();
  }, [applyView, popBack, popTrail, refresh]);

  // Home: ask the generator for the dataset's Home view (`view_json = undefined`
  // makes the wasm wrapper synthesize it), remember where we were for Back, apply
  // the Home view, then reset the trail to the root and regenerate the menu. Home
  // is the exploration root, so its walk depth is 0.
  const goHome = useCallback(async () => {
    const dsId = datasetIdRef.current;
    const ds = dimsRef.current;
    if (!dsId || !ds) return;
    const { sidecar, error: err } = runExplore(null, dsId, ds, viewportRef.current, 0);
    if (err || !sidecar) {
      setError(err ?? "Could not return home.");
      return;
    }
    const current = captureBuilderRef.current();
    try {
      await applyView(sidecar.current.view);
    } catch (e) {
      setError(`Could not return home: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (current) pushBack(current);
    setTrail([]);
    // Re-capture the zoom reference from the fresh Home camera on next refresh.
    homeDistanceRef.current = undefined;
    refresh();
  }, [applyView, pushBack, setTrail, refresh]);

  // Manual controls drive the MAIN view directly (a live camera nudge, not a
  // generated child). `applyViewportCommand` mutates the scene but does NOT mark
  // the render loop dirty, so we MUST call `onViewportChanged` for the canvas to
  // repaint (it also breaks follow + co-taps presence/URL — see App.tsx). Then we
  // record the move on the trail and regenerate the menu from the new vantage.
  // Rotate is 3D-only.
  const nudge = useCallback(
    (cmd: Record<string, unknown>, label: string) => {
      const scene = wasmSceneRef.current;
      if (!scene) return;
      applyViewportCommand(scene, cmd);
      onViewportChangedRef.current?.();
      pushTrail(label);
      refresh();
    },
    [wasmSceneRef, pushTrail, refresh],
  );

  // Zoom drives the MAIN camera. The wasm `zoom_by` command acts on the 2D slice
  // camera only; in 3D the arcball zooms via `arcball_zoom { delta }`, where
  // `distance *= (1 + delta)` so a NEGATIVE delta pulls the eye closer (zoom in).
  // We map the canonical 2x / 0.5x factors to a comparable arcball delta so the
  // button feels the same in either mode rather than being a dead no-op in 3D.
  const zoom = useCallback(
    (zoomIn: boolean) => {
      const label = zoomIn ? "Zoom in" : "Zoom out";
      if (is3D) {
        // Negative delta = closer (zoom in); positive = farther (zoom out).
        nudge(
          { type: "arcball_zoom", delta: zoomIn ? -ARCBALL_ZOOM_STEP : ARCBALL_ZOOM_STEP },
          label,
        );
      } else {
        nudge({ type: "zoom_by", factor: zoomIn ? ZOOM_IN : ZOOM_OUT }, label);
      }
    },
    [is3D, nudge],
  );

  const handleBookmark = useCallback(async () => {
    const current = captureBuilderRef.current();
    if (!current) {
      setError("No active view to bookmark.");
      return;
    }
    const name = window.prompt("Name this bookmark", suggestBookmarkName(datasetName));
    if (name === null) return; // cancelled
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    try {
      await createSavedView(trimmed, current, "personal");
    } catch (e) {
      setError(`Bookmark failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [createSavedView, datasetName]);

  if (!visible) return null;

  const noDataset = !datasetId || !dims;

  return (
    <div className="bookmark-sidebar explore-panel" style={style} data-testid="explore-panel">
      <div className="bookmark-sidebar-header">
        <h3>Explore</h3>
        <button
          type="button"
          className="primary"
          onClick={() => void handleBookmark()}
          disabled={noDataset}
          title="Bookmark the current view (saved privately to you)"
          data-testid="explore-bookmark"
        >
          Bookmark
        </button>
      </div>

      <div className="explore-here" data-testid="explore-here">
        <div className="explore-here-dataset">
          {datasetName || datasetId || "No dataset open"}
        </div>
        {!noDataset && (
          <div
            className="explore-breadcrumb"
            data-testid="explore-breadcrumb"
            title={["Home", ...breadcrumb].join(" › ")}
          >
            {formatBreadcrumb(breadcrumb)}
          </div>
        )}
        {!noDataset && hereLabel && (
          <div className="explore-here-detail">You are here: {hereLabel}</div>
        )}
      </div>

      <div className="explore-controls" data-testid="explore-controls">
        <button
          type="button"
          onClick={() =>
            nudge({ type: "arcball_rotate", d_theta: -ROTATE_RAD, d_phi: 0 }, "Rotate left 45°")
          }
          disabled={noDataset || !is3D}
          title={is3D ? "Rotate the view left" : "Rotate is available in 3D"}
          data-testid="explore-rotate-left"
        >
          Rotate left
        </button>
        <button
          type="button"
          onClick={() =>
            nudge({ type: "arcball_rotate", d_theta: ROTATE_RAD, d_phi: 0 }, "Rotate right 45°")
          }
          disabled={noDataset || !is3D}
          title={is3D ? "Rotate the view right" : "Rotate is available in 3D"}
          data-testid="explore-rotate-right"
        >
          Rotate right
        </button>
        <button
          type="button"
          onClick={() => zoom(true)}
          disabled={noDataset}
          title="Zoom in"
        >
          Zoom in
        </button>
        <button
          type="button"
          onClick={() => zoom(false)}
          disabled={noDataset}
          title="Zoom out"
        >
          Zoom out
        </button>
        <button
          type="button"
          onClick={() => void goHome()}
          disabled={noDataset}
          title="Frame the whole dataset"
        >
          Home
        </button>
        <button
          type="button"
          onClick={() => void goBack()}
          disabled={backDepth === 0}
          title="Go back to the previous view"
          data-testid="explore-back"
        >
          Back
        </button>
        <button
          type="button"
          className="explore-suggest"
          onClick={() => refresh()}
          disabled={noDataset}
          title="Suggest views from where you are now"
          data-testid="explore-suggest"
        >
          Suggest views from here
        </button>
      </div>

      {error && (
        <div className="bookmark-error" data-testid="explore-error">
          {error}
        </div>
      )}

      <div className="explore-section-header">Suggested next views</div>
      <div className="bookmark-list" role="list">
        {noDataset && (
          <div className="bookmark-empty">
            Open a dataset to start exploring.
          </div>
        )}
        {!noDataset && cells.length === 0 && !error && (
          <div className="bookmark-empty">
            No suggestions from here. Try Home, or zoom out.
          </div>
        )}
        {cells.map((cell) => (
          <div
            role="listitem"
            key={cell.handle + cell.transform}
            className="bookmark-row explore-cell"
            data-testid="explore-cell"
            onClick={() => void descend(cell)}
          >
            <div className="bookmark-row-top">
              <span className="bookmark-name" title={cell.label}>
                {cell.label}
              </span>
            </div>
            <div className="bookmark-row-meta explore-cell-transform">{cell.transform}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A compact "you are here" readout that reflects BOTH the live camera and the
 *  dataset's axes — e.g. `3D · az 45° · zoom 2.0x · Z 171/340 · T 0/40 · C 0/3`.
 *
 *  Two jobs:
 *  - **Prove movement.** The candidate list and the slice number are invariant
 *    under rotate/zoom; with no thumbnails, the only on-screen signal of an orbit
 *    or zoom is the camera-derived part (azimuth from the arcball `theta`, a
 *    closeness ratio from `distance`, or the 2D zoom factor).
 *  - **Reveal the axes that exist.** Always shows the dataset's Z/T/C extents,
 *    including T and C **only when their count > 1**, so a 40-timepoint /
 *    3-channel image visibly announces those axes exist even though stepping them
 *    is a later slice — fixing the "rich timeseries reads as flat 2D" blind spot.
 *
 *  `dims` is `[T, C, Z, Y, X]`. `homeDistance` (the Home arcball distance, when
 *  known) lets the closeness ratio read "1.0x at Home"; absent, it falls back to
 *  showing the raw distance. */
function describeView(view: SavedView, dims: Dims, homeDistance?: number): string {
  const [tCount, cCount, zCount] = dims;
  const parts: string[] = [];

  const cam = view.camera;
  if (cam.mode === "arcball") {
    parts.push("3D");
    // Azimuth: arcball theta in radians → degrees, normalized to [0, 360).
    const az = ((((cam.theta * 180) / Math.PI) % 360) + 360) % 360;
    parts.push(`az ${Math.round(az)}°`);
    // Closeness: smaller distance = more zoomed in. Express relative to Home when
    // we know it (so Home reads "zoom 1.0x"); otherwise show the raw distance.
    if (homeDistance && homeDistance > 0 && cam.distance > 0) {
      parts.push(`zoom ${(homeDistance / cam.distance).toFixed(1)}x`);
    } else if (cam.distance > 0) {
      parts.push(`dist ${cam.distance.toFixed(0)}`);
    }
  } else if (cam.mode === "fly") {
    parts.push("fly-through");
  } else {
    parts.push("2D");
    parts.push(`zoom ${cam.zoom.toFixed(1)}x`);
  }

  // Axis extents. Z always (it's the slice axis); T and C only when they have
  // more than one entry — but their presence is the point, so include them
  // whenever the dataset actually has that axis.
  const z = view.view?.z_range?.start ?? 0;
  if (zCount > 1) parts.push(`Z ${z + 1}/${zCount}`);
  const t = view.view?.t ?? 0;
  if (tCount > 1) parts.push(`T ${t}/${tCount}`);
  const c = view.view?.c ?? 0;
  if (cCount > 1) parts.push(`C ${c}/${cCount}`);

  return parts.join(" · ");
}

/** Render the move trail as `Home › a › b › c`, truncating the HEAD (keeping the
 *  most recent steps) when it gets long so the current location stays visible. */
function formatBreadcrumb(trail: readonly string[]): string {
  const MAX = 4; // most-recent steps to show after Home
  const steps = trail.length > MAX ? ["…", ...trail.slice(-MAX)] : [...trail];
  return ["Home", ...steps].join(" › ");
}

/** Default bookmark name suggestion. */
function suggestBookmarkName(datasetName?: string | null): string {
  const base = datasetName?.trim();
  return base && base.length > 0 ? `${base} — explore` : "Explore bookmark";
}
