// The guided exploration panel: the web surface over `WasmScene.explore`, the
// `lucida_core::view_transform` generator that the CLI and Python also use. It offers small next moves from the current view and navigates
// through callbacks App.tsx wires in.
//
// Row thumbnails are rendered by the worker from the already-resident coarse
// overview, through the `requestThumbnail` prop so this component stays
// testable. They are optional: lazy, concurrency-capped, and any failure falls
// back to a label-only row.

import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  BookmarkSimpleIcon,
  HouseIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import { positionLabel } from "../axes.ts";
import type { SavedView } from "../savedView/types.ts";
import { useAppearance } from "../theme/appearance.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { PanelHeader } from "../ui/PanelHeader.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import { UnstyledButton } from "../ui/UnstyledButton.tsx";
import "./BookmarkSidebar.css";
import "./ExplorationPanel.css";

/** Dataset shape in canonical `[T, C, Z, Y, X]` order. */
export type Dims = readonly [number, number, number, number, number];

/** The fields this panel reads from `lucida_core::view_transform::ExplorationCell`. */
interface ExplorationCell {
  handle: string;
  transform: string;
  label: string;
  view: SavedView;
}

/** `WasmScene.explore`'s JSON when it is not an error envelope. */
interface ExplorationSidecar {
  v: number;
  /** The current view, and the plane of the dataset it stands on along Z. */
  current: { handle: string; z: number; view: SavedView };
  cells: ExplorationCell[];
}

export interface ExplorationPanelProps {
  visible: boolean;
  /** Capture the current view as a `SavedView` (App's
   *  `savedViewSync.captureBuilder`). Null when no scene exists yet. */
  captureBuilder: () => SavedView | null;
  /** Apply a view to the viewer, then notify saved-view sync. Rows and nudge
   *  buttons both go through this. */
  applyView: (view: SavedView) => Promise<void>;
  /** Bookmark the current view. Always personal: guided exploration never
   *  auto-shares. */
  createSavedView: (
    name: string,
    view: SavedView,
    visibility: "personal",
  ) => Promise<unknown>;
  /** First visible dataset's id, or null when nothing is loaded. */
  datasetId: string | null;
  datasetName?: string | null;
  /** First visible dataset's `[T, C, Z, Y, X]` shape, for the labels, or null. */
  dims: Dims | null;
  /** Current viewport size in CSS px (for the synthesized Home camera). */
  viewport: readonly [number, number];
  /** The live scene, which builds the moves and the Home every client shares.
   *  Null before there is one. */
  getScene: () => WasmScene | null;
  /**
   * Render a preview of `view`, or resolve `null` when one can't be produced yet
   * (the coarse overview isn't resident) so the row stays label-only. `size` is
   * the square edge in device pixels. Omit it for label-only rows.
   */
  requestThumbnail?: (view: SavedView, size: number) => Promise<ImageBitmap | null>;
}

// Each nudge button is keyed to a generator move (`ViewTransform::id`) and applies
// the candidate the generator already computed for it, so no move math lives here
// to drift from the engine. A button is disabled when the generator didn't offer
// its move.
const NUDGES: ReadonlyArray<{
  transform: string;
  text: string;
  icon: Icon;
  testid: string;
}> = [
  {
    transform: "azimuth:-45",
    text: "Rotate left",
    icon: ArrowCounterClockwiseIcon,
    testid: "explore-rotate-left",
  },
  {
    transform: "azimuth:+45",
    text: "Rotate right",
    icon: ArrowClockwiseIcon,
    testid: "explore-rotate-right",
  },
  {
    transform: "zoom:in",
    text: "Zoom in",
    icon: MagnifyingGlassPlusIcon,
    testid: "explore-zoom-in",
  },
  {
    transform: "zoom:out",
    text: "Zoom out",
    icon: MagnifyingGlassMinusIcon,
    testid: "explore-zoom-out",
  },
];

/** Run the generator for `current` (or Home when `current` is null). `depth` is
 *  the breadcrumb length, so the sidecar's recorded depth is accurate. */
function runExplore(
  scene: WasmScene,
  current: SavedView | null,
  datasetId: string,
  viewport: readonly [number, number],
  depth: number,
): { sidecar?: ExplorationSidecar; error?: string } {
  const [vw, vh] = viewport;
  const viewJson = current ? JSON.stringify(current) : undefined;
  let raw: string;
  try {
    raw = scene.explore(
      viewJson,
      datasetId,
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

/** Thumbnail edge in CSS px; the render is this times the device pixel ratio. */
const THUMB_CSS_SIZE = 64;

/** Max thumbnail requests in flight, so a long list or fast scrolling can't
 *  flood the worker queue. */
const THUMB_CONCURRENCY = 3;

/**
 * Whether a preview can show this candidate. The overview path draws a volume
 * from a 3D camera; a 2D slice camera has no such view, so every 2D candidate
 * would get the same head-on picture of the whole stack.
 */
function canPreview(view: SavedView): boolean {
  return view.camera.mode !== "slice";
}

/**
 * Concurrency limiter for thumbnail requests: at most {@link THUMB_CONCURRENCY}
 * run at once. One instance per panel mount, shared by all rows.
 */
class ThumbnailScheduler {
  private active = 0;
  private queue: Array<() => void> = [];

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        task().then(resolve, reject).finally(() => {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < THUMB_CONCURRENCY) start();
      else this.queue.push(start);
    });
  }
}

/**
 * One row's preview thumbnail, requested once it scrolls into view. On `null` or
 * error it renders nothing, so a thumbnail failure can never break the row.
 * Mounted under a key that changes with the view and the canvas background, so
 * a change of either draws it afresh.
 */
function ExploreThumbnail({
  view,
  request,
  scheduler,
}: {
  view: SavedView;
  request: (view: SavedView, size: number) => Promise<ImageBitmap | null>;
  scheduler: ThumbnailScheduler;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<"pending" | "ready" | "empty">("pending");

  // Read at fire time, so the observer effect stays keyed on the view alone and
  // doesn't re-subscribe when the parent hands in fresh references.
  const requestRef = useRef(request);
  // eslint-disable-next-line react-hooks/refs
  requestRef.current = request;
  const schedulerRef = useRef(scheduler);
  // eslint-disable-next-line react-hooks/refs
  schedulerRef.current = scheduler;

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    let cancelled = false;
    let fired = false;
    const fire = () => {
      if (fired || cancelled) return;
      fired = true;
      const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
      const size = Math.max(1, Math.round(THUMB_CSS_SIZE * dpr));
      void schedulerRef.current
        .run(() => requestRef.current(view, size))
        .then((bitmap) => {
          if (cancelled) {
            bitmap?.close?.();
            return;
          }
          const canvas = canvasRef.current;
          if (!bitmap || !canvas) {
            setStatus("empty");
            return;
          }
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const cctx = canvas.getContext("2d");
          if (cctx) cctx.drawImage(bitmap, 0, 0);
          bitmap.close?.();
          setStatus("ready");
        })
        .catch(() => {
          if (!cancelled) setStatus("empty");
        });
    };

    // IntersectionObserver may be absent in test environments.
    if (typeof IntersectionObserver === "undefined") {
      fire();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            fire();
            observer.disconnect();
          }
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(holder);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [view]);

  if (status === "empty") return null;
  return (
    <span
      ref={holderRef}
      className="lc-explore-thumb"
      data-testid="explore-thumb"
      data-thumb-status={status}
    >
      <canvas ref={canvasRef} className="lc-explore-thumb-canvas" />
    </span>
  );
}

export function ExplorationPanel({
  visible,
  captureBuilder,
  applyView,
  createSavedView,
  datasetId,
  datasetName,
  dims,
  viewport,
  getScene,
  requestThumbnail,
}: ExplorationPanelProps) {
  const [cells, setCells] = useState<ExplorationCell[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showPreviews, setShowPreviews] = useState(true);
  const [bookmarkOpen, setBookmarkOpen] = useState(false);
  // useState rather than a ref so it's readable during render.
  const [scheduler] = useState(() => new ThumbnailScheduler());
  // A preview bakes in the canvas background, which can follow the UI theme.
  const appearance = useAppearance();
  const previewKey = `${appearance.theme}:${appearance.canvasBackground}`;
  const previewable = !!requestThumbnail && cells.some((cell) => canPreview(cell.view));
  const thumbnailsOn = showPreviews && previewable;
  // The Back stack lives in a ref so async handlers can push and pop it
  // deterministically: a value set inside a setState updater isn't available on
  // the next line, and StrictMode double-invokes updaters. `backDepth` mirrors
  // its length only to re-render the Back button.
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

  // The trail of moves from Home. Without thumbnails it is the main sign that a
  // nudge navigated, since the candidate list and slice number don't change under
  // rotate or zoom. The ref mirror gives handlers the current length as `depth`.
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

  const [hereLabel, setHereLabel] = useState<string>("");

  // Arcball distance at the exploration root, so Home reads "zoom 1.0x". Reset
  // on Home.
  const homeDistanceRef = useRef<number | undefined>(undefined);

  // Props the handlers read at call time, kept in refs so handler identities stay
  // stable. Read inside callbacks, never during render.
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
  const getSceneRef = useRef(getScene);
  // eslint-disable-next-line react-hooks/refs
  getSceneRef.current = getScene;

  /** Run the generator from `current` against the live dataset. */
  const explore = useCallback((current: SavedView | null, depth: number) => {
    const dsId = datasetIdRef.current;
    const scene = getSceneRef.current();
    if (!dsId || !dimsRef.current || !scene) return null;
    return runExplore(scene, current, dsId, viewportRef.current, depth);
  }, []);

  const refresh = useCallback(() => {
    const ds = dimsRef.current;
    const result = explore(captureBuilderRef.current(), breadcrumbRef.current.length);
    if (!result || !ds) {
      setCells([]);
      setError(null);
      setHereLabel("");
      return;
    }
    const { sidecar, error: err } = result;
    if (err || !sidecar) {
      setError(err ?? "No suggestions available.");
      setCells([]);
      return;
    }
    setError(null);
    setCells(sidecar.cells);
    const cam = sidecar.current.view.camera;
    if (breadcrumbRef.current.length === 0 && cam.mode === "arcball" && cam.distance > 0) {
      homeDistanceRef.current = cam.distance;
    }
    setHereLabel(describeView(sidecar.current.view, sidecar.current.z, datasetIdRef.current, ds, homeDistanceRef.current));
  }, [explore]);

  useEffect(() => {
    if (!visible) return;
    refresh();
  }, [visible, datasetId, dims, refresh]);

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

  // Home frames the whole dataset from the live view, keeping its 2D or 3D
  // camera and display settings, as the generator's Home move does. Only with
  // no live view does the generator synthesize one.
  const goHome = useCallback(async () => {
    const current = captureBuilderRef.current();
    const result = explore(current, 0);
    if (!result) return;
    const { sidecar, error: err } = result;
    const home = current
      ? sidecar?.cells.find((cell) => cell.transform === "home")?.view ?? current
      : sidecar?.current.view;
    if (err || !home) {
      setError(err ?? "Could not return home.");
      return;
    }
    try {
      await applyView(home);
    } catch (e) {
      setError(`Could not return home: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (current) pushBack(current);
    setTrail([]);
    homeDistanceRef.current = undefined;
    refresh();
  }, [applyView, explore, pushBack, setTrail, refresh]);

  // A nudge descends into the generator's matching cell, like clicking that row,
  // so Back undoes it too.
  const applyNudge = useCallback(
    (transform: string) => {
      const cell = cells.find((c) => c.transform === transform);
      if (!cell) return;
      void descend(cell);
    },
    [cells, descend],
  );

  const handleBookmark = useCallback(
    async (name: string) => {
      const current = captureBuilderRef.current();
      if (!current) {
        setError("No active view to bookmark.");
        return;
      }
      try {
        await createSavedView(name, current, "personal");
      } catch (e) {
        setError(`Bookmark failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [createSavedView],
  );

  if (!visible) return null;

  const noDataset = !datasetId || !dims;

  return (
    <section
      className="lc-rail-panel lc-explore"
      aria-label="Explore"
      data-testid="explore-panel"
    >
      <PanelHeader
        className="lc-rail-panel-header"
        title="Explore"
        actions={
          <Button
            size="sm"
            icon={BookmarkSimpleIcon}
            onPress={() => setBookmarkOpen(true)}
            isDisabled={noDataset}
            data-testid="explore-bookmark"
          >
            Bookmark
          </Button>
        }
      />

      <div className="lc-rail-panel-toolbar">
        <div className="lc-explore-here" data-testid="explore-here">
          <div className="lc-explore-dataset" title={datasetName || datasetId || undefined}>
            {datasetName || datasetId || "No dataset open"}
          </div>
          {!noDataset && (
            <div
              className="lc-explore-breadcrumb"
              data-testid="explore-breadcrumb"
              title={["Home", ...breadcrumb].join(" › ")}
            >
              {formatBreadcrumb(breadcrumb)}
            </div>
          )}
          {!noDataset && hereLabel && (
            <div className="lc-explore-detail">You are here: {hereLabel}</div>
          )}
        </div>

        <div className="lc-explore-moves" role="toolbar" aria-label="Moves" data-testid="explore-controls">
          <IconButton
            icon={ArrowLeftIcon}
            label="Back"
            tooltipPlacement="bottom"
            onPress={() => void goBack()}
            isDisabled={backDepth === 0}
            data-testid="explore-back"
          />
          <IconButton
            icon={HouseIcon}
            label="Home"
            tooltipPlacement="bottom"
            onPress={() => void goHome()}
            isDisabled={noDataset}
            data-testid="explore-home"
          />
          <span className="lc-explore-moves-gap" aria-hidden="true" />
          {NUDGES.map((n) => {
            const available = cells.some((c) => c.transform === n.transform);
            return (
              <IconButton
                key={n.transform}
                icon={n.icon}
                label={n.text}
                tooltipPlacement="bottom"
                onPress={() => applyNudge(n.transform)}
                isDisabled={noDataset || !available}
                data-testid={n.testid}
              />
            );
          })}
        </div>

        <div className="lc-explore-options">
          <Button
            size="sm"
            icon={ArrowsClockwiseIcon}
            onPress={() => refresh()}
            isDisabled={noDataset}
            data-testid="explore-suggest"
          >
            Suggest from here
          </Button>
          {previewable && (
            <div className="lc-explore-previews" data-testid="explore-previews-toggle">
              <Switch label="Previews" isSelected={showPreviews} onChange={setShowPreviews} />
            </div>
          )}
        </div>
      </div>

      <div className="lc-rail-panel-body">
        {error && (
          <p className="lc-rail-panel-note" data-tone="danger" data-testid="explore-error">
            {error}
          </p>
        )}
        <h3 className="lc-rail-panel-section-title">Suggested next views</h3>
        {noDataset && <p className="lc-rail-panel-empty">Open a dataset to start exploring.</p>}
        {!noDataset && cells.length === 0 && !error && (
          <p className="lc-rail-panel-empty">No suggestions from here. Try Home, or zoom out.</p>
        )}
        <ul className="lc-rail-list">
          {cells.map((cell) => (
            <li key={cell.handle + cell.transform} className="lc-rail-row">
              <UnstyledButton
                className="lc-rail-row-open"
                data-testid="explore-cell"
                title={cell.label}
                onPress={() => void descend(cell)}
              >
                {thumbnailsOn && requestThumbnail && canPreview(cell.view) && (
                  <ExploreThumbnail
                    // The handle is the content address of the child view, so it
                    // changes exactly when the view (hence the thumbnail) should.
                    key={`${cell.handle}|${previewKey}`}
                    view={cell.view}
                    request={requestThumbnail}
                    scheduler={scheduler}
                  />
                )}
                <span className="lc-rail-row-text">
                  <span className="lc-rail-row-name">{cell.label}</span>
                  <span className="lc-rail-row-meta lc-explore-transform">{cell.transform}</span>
                </span>
              </UnstyledButton>
            </li>
          ))}
        </ul>
      </div>

      {bookmarkOpen && (
        <BookmarkDialog
          defaultName={suggestBookmarkName(datasetName)}
          onCancel={() => setBookmarkOpen(false)}
          onSave={(name) => {
            setBookmarkOpen(false);
            void handleBookmark(name);
          }}
        />
      )}
    </section>
  );
}

/** Names the bookmark the Explore panel saves as a personal view. */
function BookmarkDialog({
  defaultName,
  onCancel,
  onSave,
}: {
  defaultName: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    nameRef.current?.select();
  }, []);
  const trimmed = name.trim();
  const submit = () => {
    if (trimmed.length > 0) onSave(trimmed);
  };
  return (
    <Dialog
      title="Bookmark this view"
      size="sm"
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      footer={
        <>
          <Button onPress={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            isDisabled={trimmed.length === 0}
            onPress={submit}
            data-testid="explore-bookmark-save"
          >
            Save
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        description="Saved to your personal views."
        value={name}
        onChange={setName}
        autoFocus
        inputRef={nameRef}
        data-testid="explore-bookmark-name"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
    </Dialog>
  );
}

/** A "you are here" readout of the camera and the dataset's axes, e.g.
 *  `3D · az 45° · zoom 2.0x · Z 171/340 · T 1/40 · C 1/3`.
 *
 *  The camera part is the only on-screen sign of an orbit or zoom when there are
 *  no thumbnails. T and C show when their count is above 1, so a time series
 *  doesn't read as flat 2D. Without `homeDistance` the raw distance is shown. */
function describeView(view: SavedView, z: number, datasetId: string | null, dims: Dims, homeDistance?: number): string {
  const [tCount, cCount, zCount] = dims;
  const parts: string[] = [];

  const cam = view.camera;
  if (cam.mode === "arcball") {
    parts.push("3D");
    // Theta in radians to degrees in [0, 360).
    const az = ((((cam.theta * 180) / Math.PI) % 360) + 360) % 360;
    parts.push(`az ${Math.round(az)}°`);
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

  if (zCount > 1) parts.push(positionLabel("Z", z, zCount));
  const t = view.view?.t ?? 0;
  if (tCount > 1) parts.push(positionLabel("T", t, tCount));
  const solo = datasetId ? view.dataset_settings?.[datasetId]?.solo : undefined;
  if (cCount > 1) {
    parts.push(typeof solo === "number" ? positionLabel("C", solo, cCount) : "composite");
  }

  return parts.join(" · ");
}

/** Render the trail as `Home › a › b › c`, dropping the oldest steps when long so
 *  the current location stays visible. */
function formatBreadcrumb(trail: readonly string[]): string {
  const MAX = 4; // most-recent steps to show after Home
  const steps = trail.length > MAX ? ["…", ...trail.slice(-MAX)] : [...trail];
  return ["Home", ...steps].join(" › ");
}

function suggestBookmarkName(datasetName?: string | null): string {
  const base = datasetName?.trim();
  return base && base.length > 0 ? `${base} — explore` : "Explore bookmark";
}
