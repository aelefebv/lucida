/**
 * Debug overlay layer over the canvas, with pointer-events: none so it never
 * steals interaction. It reads existing scene, orchestrator, and cache state;
 * production code carries nothing for it. Colors and text come from the pure
 * `overlayDrawList.ts`; this file projects and mounts. The brushed selection
 * is read from `trace/linkedSelection.ts`, never from the dock.
 *
 * Both modes project voxel to world to `WasmScene.project_to_screen`. Slice:
 * world is voxel plus the tile position, placed in the scene frame as its
 * dataset is. Volume: world is the tile model matrix times voxel / fullVoxel,
 * which bakes in the renderer's Y-flip and placement.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import { currentChunkSelection, onChunkSelectionChanged } from "../trace/linkedSelection.ts";
import { traceRecorder } from "../trace/recorder.ts";
import type { DatasetState } from "../types.ts";
import { frameToScene, readPlacement, type Placement } from "../placement.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { CpuCache } from "../pipeline/fetch/index.ts";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  chunkWithinRenderRadius,
  renderRadiusLimitVox,
  visibleRegionCenterVox,
  type ChunkRadiusGeometry,
} from "../pipeline/renderRadius.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import type { VisibleRegion } from "../pipeline/viewport.ts";
import type {
  CacheStateSnapshot,
  ChunkRequest,
  RequestPlan,
} from "../pipeline/planning/index.ts";
import {
  DEBUG_OVERLAYS,
  getRenderRadiusPreviewTier,
  isOverlayEnabled,
  onOverlaysChanged,
  onRenderRadiusPreviewChanged,
  type DebugOverlay,
} from "./logging.ts";
import {
  buildChunkDrawList,
  describeHoverInspector,
  hitTestChunk,
  overlayAbsence,
  readOverlayColors,
  selectionCaption,
  type ChunkCell,
  type ChunkDrawItem,
  type ChunkDrawList,
  type DisplayTier,
  type InspectorView,
} from "./overlayDrawList.ts";
import { radiusSpecsForOverlay } from "./radiusPreview.ts";
import {
  buildVolumeDrawList,
  hitTestBox,
  isVolumeDrawList,
  projectChunkBox,
  type ProjectedBox,
  type Projector,
  type Vec3,
} from "./volumeWireframe.ts";
import { readResolvedLayers, shownChannels } from "../resolvedLayers.ts";
import "./DebugOverlays.css";

interface Props {
  wasmSceneRef: RefObject<WasmScene | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  datasets: Map<string, DatasetState>;
  renderLoopRef: RefObject<RenderLoop | null>;
  cpuCache: CpuCache | null;
  viewMode: "2d" | "3d";
}

const POLL_MS = 100;
const MAX_CHUNK_RECTS = 600;

interface GroupBadge {
  key: string;
  centerX: number;
  centerY: number;
  mode: string;
  label: string;
  title: string;
}

export interface TierCoverageCounts {
  /** Chunks requested by the current plan for this tier. */
  wanted: number;
  /**
   * Chunks available for this tier. Counts worker-delivered chunks plus
   * CPU-ready chunks so cold-state rebuilds during pan/zoom do not make
   * the overlay flash D0/N while the atlas still visibly contains data.
   */
  shown: number;
  /** Chunks currently decoded in the CPU cache, whether uploaded or not. */
  ready: number;
  /** Chunks currently being fetched/decoded. */
  inFlight: number;
}

export interface GroupTierCoverage {
  detail: TierCoverageCounts;
  coarse: TierCoverageCounts;
}

interface RadiusPath {
  key: string;
  tier: ResidencyTier;
  plane: "xy" | "xz" | "yz";
  d: string;
  title: string;
}

const RADIUS_SAMPLE_COUNT = 96;

function tierDrawOrder(cell: ChunkCell): number {
  if (cell.sourceTier === "missing") return 0;
  if (cell.sourceTier === "coarse") return 0;
  if (cell.sourceTier === "detail") return 1;
  return 2;
}

const EMPTY_DRAW_LIST: ChunkDrawList = { items: [], withRow: 0, churned: 0, selected: 0 };

/** How faint a cell outside the brushed selection is drawn while one is on. */
const UNSELECTED_OPACITY = 0.35;

/** Where the inspector sits relative to the pointer, in CSS pixels. */
const INSPECTOR_OFFSET = 14;

/** The box the inspector describes gets a wide stroke under its own edges, so it stands out of the stack. */
const HOVERED_BOX_EXTRA_WIDTH = 3;

function emptyTierCoverageCounts(): TierCoverageCounts {
  return { wanted: 0, shown: 0, ready: 0, inFlight: 0 };
}

function emptyGroupTierCoverage(): GroupTierCoverage {
  return {
    detail: emptyTierCoverageCounts(),
    coarse: emptyTierCoverageCounts(),
  };
}

/** The tier a request fills for the view. Speculative and minimap work is not coverage. */
function overlayTierForRequest(req: ChunkRequest): ResidencyTier | null {
  if (req.lane === "prefetch" || req.lane === "minimap") return null;
  return req.tier;
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildGroupTierCoverage(
  plan: Pick<RequestPlan, "requests">,
  parentByEntity: ReadonlyMap<string, string | null>,
  cpuCache: Pick<CpuCache, "deliveryState"> | null,
  cacheSnap: CacheStateSnapshot | null,
): Map<string, GroupTierCoverage> {
  const out = new Map<string, GroupTierCoverage>();
  for (const req of plan.requests) {
    const tier = overlayTierForRequest(req);
    if (!tier) continue;

    const groupId = parentByEntity.get(req.entityId) ?? req.entityId;
    let coverage = out.get(groupId);
    if (!coverage) {
      coverage = emptyGroupTierCoverage();
      out.set(groupId, coverage);
    }

    const counts = coverage[tier];
    counts.wanted++;
    const ready = cacheSnap?.cached.get(req.entityId)?.has(req.chunkKey) ?? false;
    if (ready) {
      counts.ready++;
    }
    if (cacheSnap?.inFlight.get(req.entityId)?.has(req.chunkKey)) {
      counts.inFlight++;
    }
    if (ready || cpuCache?.deliveryState.isChunkHeld(req.imageId, req.c, req.chunkKey, tier)) {
      counts.shown++;
    }
  }
  return out;
}

// eslint-disable-next-line react-refresh/only-export-components
export function formatTierCoverageLabel(
  coverage: GroupTierCoverage,
  fallbackLod: number | null,
): string {
  const detail = `D${coverage.detail.shown}/${coverage.detail.wanted}`;
  const coarse = `C${coverage.coarse.shown}/${coverage.coarse.wanted}`;
  const detailComplete =
    coverage.detail.wanted > 0 && coverage.detail.shown >= coverage.detail.wanted;
  const coarseActive =
    coverage.coarse.wanted > 0 && coverage.coarse.shown > 0 && !detailComplete;
  const parts: string[] = coarseActive
    ? [
        coarse,
        ...(coverage.detail.wanted > 0 ? [detail] : []),
      ]
    : [
        ...(coverage.detail.wanted > 0 ? [detail] : []),
        ...(coverage.coarse.wanted > 0 ? [coarse] : []),
      ];
  if (parts.length > 0) return parts.join(" ");
  return fallbackLod !== null ? `L${fallbackLod}` : "";
}

// eslint-disable-next-line react-refresh/only-export-components
export function tierCoverageMode(coverage: GroupTierCoverage): string {
  const detailComplete =
    coverage.detail.wanted > 0 && coverage.detail.shown >= coverage.detail.wanted;
  if (detailComplete) return "render-detail";
  if (coverage.coarse.shown > 0) return "render-coarse";
  if (coverage.detail.shown > 0) return "render-detail";
  if (coverage.detail.wanted > 0 || coverage.coarse.wanted > 0) {
    return "render-waiting";
  }
  // Nothing wanted: the planner holds the target level, so nothing is owed.
  return "render-detail";
}

// eslint-disable-next-line react-refresh/only-export-components
export function formatTierCoverageTitle(
  coverage: GroupTierCoverage,
  fallbackLod: number | null,
): string {
  const parts: string[] = [];
  if (coverage.detail.wanted > 0) {
    parts.push(
      `detail available ${coverage.detail.shown}/${coverage.detail.wanted}, ready ${coverage.detail.ready}, in-flight ${coverage.detail.inFlight}`,
    );
  }
  if (coverage.coarse.wanted > 0) {
    parts.push(
      `coarse available ${coverage.coarse.shown}/${coverage.coarse.wanted}, ready ${coverage.coarse.ready}, in-flight ${coverage.coarse.inFlight}`,
    );
  }
  const levelPart = fallbackLod !== null ? `target L${fallbackLod}` : "no target level";
  if (parts.length === 0) return levelPart;
  return `${parts.join("; ")}; ${levelPart}`;
}

function parseVisibleRegion(ws: WasmScene, dsId: string): VisibleRegion | null {
  let raw: string | null = null;
  try {
    raw = ws.visible_region(ws.active_view(), dsId);
  } catch {
    return null;
  }
  if (!raw || raw === "null") return null;
  try {
    const vr = JSON.parse(raw) as {
      xy_bounds: [number, number, number, number];
      z_range: [number, number];
      effective_zoom: number;
      radius_basis_vox?: number;
      sort_center: [number, number, number] | null;
      frustum_planes: [number, number, number, number][] | null;
    };
    return {
      xyBoundsVox: vr.xy_bounds,
      zRangeVox: vr.z_range,
      effectiveZoom: vr.effective_zoom,
      ...(vr.radius_basis_vox !== undefined ? { radiusBasisVox: vr.radius_basis_vox } : {}),
      sortCenterVox: vr.sort_center,
      frustumPlanes: vr.frustum_planes,
    };
  } catch {
    return null;
  }
}

function chunkKeyFor(
  level: number,
  t: number,
  c: number,
  z: number,
  y: number,
  x: number,
): string {
  return `${level}/${t}/${c}/${z}/${y}/${x}`;
}

function geometryForLevels(
  lvl0: { shape: number[] },
  lvl: { shape: number[]; chunk_shape: number[] },
): ChunkRadiusGeometry {
  return {
    fullDims: [
      lvl0.shape[Axis.X],
      lvl0.shape[Axis.Y],
      lvl0.shape[Axis.Z],
    ],
    levelDims: [
      lvl.shape[Axis.X],
      lvl.shape[Axis.Y],
      lvl.shape[Axis.Z],
    ],
    chunkDims: [
      lvl.chunk_shape[Axis.X],
      lvl.chunk_shape[Axis.Y],
      lvl.chunk_shape[Axis.Z],
    ],
  };
}

/**
 * Per-tile projection frame. `model === null` means 2D (slice mode):
 * voxel + position is world. `model !== null` means 3D: voxel /
 * fullVoxel goes through the model matrix to get world.
 */
interface TileFrame {
  pos: [number, number];
  fullVoxel: [number, number, number];
  model: Float32Array | null;
  /** Where the tile's dataset sits in the scene frame, for the slice path. */
  placement: Placement;
}

/** Project a world-space point to CSS-pixel screen coords. */
function projectWorld(
  ws: WasmScene,
  wx: number,
  wy: number,
  wz: number,
  dpr: number,
): { x: number; y: number } | null {
  const arr = ws.project_to_screen(wx, wy, wz);
  if (arr.length === 0) return null;
  return { x: arr[0] / dpr, y: arr[1] / dpr };
}

/** Convert tile-local voxel coords to world coords for the active mode. */
function voxelToWorld(
  frame: TileFrame,
  vx: number,
  vy: number,
  vz: number,
): [number, number, number] {
  if (frame.model) {
    // Volume path: unit-space Y is flipped vs image-convention voxel Y
    // (the shader does `(1 - pos.y) * levelDims.y` to sample voxels).
    // Mirror that flip here so projected chunk rects line up with what
    // the renderer actually displays.
    const ux = vx / frame.fullVoxel[0];
    const uy = 1 - vy / frame.fullVoxel[1];
    const uz = vz / frame.fullVoxel[2];
    const m = frame.model;
    return [
      m[0] * ux + m[4] * uy + m[8] * uz + m[12],
      m[1] * ux + m[5] * uy + m[9] * uz + m[13],
      m[2] * ux + m[6] * uy + m[10] * uz + m[14],
    ];
  }
  const [wx, wy] = frameToScene(frame.placement, [frame.pos[0] + vx, frame.pos[1] + vy]);
  return [wx, wy, vz];
}

/** Tile's world-space centroid (the (0.5, 0.5, 0.5) point of its unit cube). */
function tileWorldCenter(frame: TileFrame): [number, number, number] {
  return voxelToWorld(
    frame,
    frame.fullVoxel[0] / 2,
    frame.fullVoxel[1] / 2,
    frame.fullVoxel[2] / 2,
  );
}

/** The scene's camera: world coordinates to CSS pixels, or null behind the camera. */
function worldProjector(ws: WasmScene, dpr: number): Projector {
  return (wx, wy, wz) => {
    const arr = ws.project_to_screen(wx, wy, wz);
    return arr.length === 0 ? null : [arr[0] / dpr, arr[1] / dpr];
  };
}

function voxelProjector(ws: WasmScene, frame: TileFrame, dpr: number): Projector {
  const project = worldProjector(ws, dpr);
  return (vx, vy, vz) => {
    const [wx, wy, wz] = voxelToWorld(frame, vx, vy, vz);
    return project(wx, wy, wz);
  };
}

/** The camera's world position, for ordering boxes front to back in the hit test. */
function eyeOf(ws: WasmScene): [number, number, number] | null {
  try {
    const eye = ws.eye_position(ws.active_view());
    return eye.length >= 3 ? [eye[0], eye[1], eye[2]] : null;
  } catch {
    return null;
  }
}

function squaredDistance(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function distanceToVoxelAabbSq(
  point: [number, number, number],
  min: [number, number, number],
  max: [number, number, number],
): number {
  let out = 0;
  for (let i = 0; i < 3; i++) {
    if (point[i] < min[i]) out += (min[i] - point[i]) ** 2;
    else if (point[i] > max[i]) out += (point[i] - max[i]) ** 2;
  }
  return out;
}

function pathFromProjectedPoints(points: Array<{ x: number; y: number }>): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}

function projectRadiusCircle(
  ws: WasmScene,
  frame: TileFrame,
  centerLocalVox: [number, number, number],
  radiusVox: number,
  plane: RadiusPath["plane"],
  dpr: number,
): string[] {
  const paths: string[] = [];
  let segment: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (segment.length >= 2) paths.push(pathFromProjectedPoints(segment));
    segment = [];
  };

  for (let i = 0; i <= RADIUS_SAMPLE_COUNT; i++) {
    const theta = (i / RADIUS_SAMPLE_COUNT) * Math.PI * 2;
    const cos = Math.cos(theta) * radiusVox;
    const sin = Math.sin(theta) * radiusVox;
    let vx = centerLocalVox[0];
    let vy = centerLocalVox[1];
    let vz = centerLocalVox[2];
    if (plane === "xy") {
      vx += cos;
      vy += sin;
    } else if (plane === "xz") {
      vx += cos;
      vz += sin;
    } else {
      vy += cos;
      vz += sin;
    }

    const [wx, wy, wz] = voxelToWorld(frame, vx, vy, vz);
    const projected = projectWorld(ws, wx, wy, wz, dpr);
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
      flush();
      continue;
    }
    segment.push(projected);
  }
  flush();
  return paths;
}

export function DebugOverlays({
  wasmSceneRef,
  canvasRef,
  datasets,
  renderLoopRef,
  cpuCache,
  viewMode,
}: Props) {
  const readEnabled = (): Record<DebugOverlay, boolean> => {
    const out = {} as Record<DebugOverlay, boolean>;
    for (const name of DEBUG_OVERLAYS) out[name] = isOverlayEnabled(name);
    return out;
  };
  const [enabled, setEnabled] = useState<Record<DebugOverlay, boolean>>(readEnabled);
  useEffect(() => {
    return onOverlaysChanged(() => setEnabled(readEnabled()));
  }, []);
  const [radiusPreviewTier, setRadiusPreviewTier] = useState<ResidencyTier | null>(
    getRenderRadiusPreviewTier,
  );
  useEffect(() => {
    return onRenderRadiusPreviewChanged(() => setRadiusPreviewTier(getRenderRadiusPreviewTier()));
  }, []);
  const [selection, setSelection] = useState(currentChunkSelection);
  useEffect(() => {
    return onChunkSelectionChanged(() => setSelection(currentChunkSelection()));
  }, []);

  const anyEnabled =
    DEBUG_OVERLAYS.some(o => enabled[o]) || radiusPreviewTier !== null || selection !== null;
  // The trace-reading modes and a brushed selection all color the chunk
  // grid, so any of them shows the grid without a second toggle.
  const showGrid = enabled.chunkGrid || enabled.phaseColor || enabled.churnTint || selection !== null;

  const [badges, setBadges] = useState<GroupBadge[]>([]);
  const [drawList, setDrawList] = useState<ChunkDrawList>(EMPTY_DRAW_LIST);
  const [windowMs, setWindowMs] = useState<number | null>(null);
  const [radiusPaths, setRadiusPaths] = useState<RadiusPath[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // The pointer and the latest draw list live in refs so a pointer move
  // hit-tests without a render, and a tick refreshes the open inspector
  // without a pointer move.
  const drawListRef = useRef<ChunkDrawList>(EMPTY_DRAW_LIST);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const hoveredKeyRef = useRef<string | null>(null);
  const [inspector, setInspector] = useState<{ key: string; left: number; top: number; view: InspectorView } | null>(
    null,
  );

  const hitTest = useCallback(
    (x: number, y: number): ChunkDrawItem | null =>
      viewMode === "3d" ? hitTestBox(drawListRef.current.items, x, y) : hitTestChunk(drawListRef.current.items, x, y),
    [viewMode],
  );

  // One live lookup per hovered cell per tick, never per pointer move: the
  // rank is a pass over the interval's rows, a cost a hover can pay and a
  // frame cannot.
  const refreshInspector = useCallback(() => {
    const pointer = pointerRef.current;
    const item = pointer ? hitTest(pointer.x, pointer.y) : null;
    if (!pointer || !item) {
      hoveredKeyRef.current = null;
      setInspector(null);
      return;
    }
    const lookup = traceRecorder.lookupChunkLive(item.cell);
    hoveredKeyRef.current = item.key;
    setInspector({
      key: item.key,
      left: pointer.x + INSPECTOR_OFFSET,
      top: pointer.y + INSPECTOR_OFFSET,
      view: describeHoverInspector(item, lookup, traceRecorder.openIntervalMs),
    });
  }, [hitTest]);

  const closeInspector = useCallback(() => {
    pointerRef.current = null;
    hoveredKeyRef.current = null;
    setInspector(null);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !showGrid) {
      closeInspector();
      return;
    }
    const onMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      pointerRef.current = { x, y };
      const item = hitTest(x, y);
      if (item && item.key === hoveredKeyRef.current) {
        // Same cell: move the box without another lookup.
        setInspector((open) => (open ? { ...open, left: x + INSPECTOR_OFFSET, top: y + INSPECTOR_OFFSET } : open));
        return;
      }
      refreshInspector();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", closeInspector);
    canvas.addEventListener("pointerdown", closeInspector);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", closeInspector);
      canvas.removeEventListener("pointerdown", closeInspector);
    };
  }, [canvasRef, showGrid, hitTest, refreshInspector, closeInspector]);

  useEffect(() => {
    if (!anyEnabled) {
      // Reset when overlays are toggled off. There is no external state to
      // subscribe to; the toggle is the state change we react to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBadges([]);
      drawListRef.current = EMPTY_DRAW_LIST;
      setDrawList(EMPTY_DRAW_LIST);
      setRadiusPaths([]);
      return;
    }

    const tick = () => {
      const ws = wasmSceneRef.current;
      const canvas = canvasRef.current;
      if (!ws || !canvas) return;

      const canvasWCss = canvas.clientWidth;
      const canvasHCss = canvas.clientHeight;
      setSize({ w: canvasWCss, h: canvasHCss });
      if (canvasWCss === 0 || canvasHCss === 0) return;

      const dpr = devicePixelRatio;
      const is3D = viewMode === "3d";
      const eye = is3D ? eyeOf(ws) : null;

      const coord = renderLoopRef.current?.getTickCoordinator();
      const plans = coord?.getLastPlans();

      // Off-screen culling margin (CSS px).
      const xMin = -64;
      const yMin = -32;
      const xMax = canvasWCss + 64;
      const yMax = canvasHCss + 32;
      const offScreen = (box: ProjectedBox): boolean =>
        box.left + box.width < xMin || box.top + box.height < yMin || box.left > xMax || box.top > yMax;
      const volumeFields = (box: ProjectedBox, centerWorld: Vec3): Pick<ChunkCell, "corners" | "depth"> =>
        is3D ? { corners: box.corners, depth: eye ? squaredDistance(eye, centerWorld) : undefined } : {};

      // Per-tick model-matrix cache; one WASM call per (dsId, imageId)
      // even when many overlays / groups reference the same tile.
      const modelCache = new Map<string, Float32Array | null>();
      const getFrame = (dsId: string, imageId: string, lvl0Shape: number[]): TileFrame => {
        const cacheKey = `${dsId}|${imageId}`;
        let model: Float32Array | null | undefined = modelCache.get(cacheKey);
        if (model === undefined) {
          if (is3D) {
            try {
              model = new Float32Array(ws.member_model_matrix(dsId, imageId));
            } catch {
              model = null;
            }
          } else {
            model = null;
          }
          modelCache.set(cacheKey, model);
        }
        return {
          pos: [0, 0], // overwritten below
          fullVoxel: [lvl0Shape[Axis.X], lvl0Shape[Axis.Y], lvl0Shape[Axis.Z]],
          model,
          placement: readPlacement(ws, dsId),
        };
      };

      const showRenderRadius = enabled.renderRadius || radiusPreviewTier !== null;
      if (showRenderRadius && plans) {
        const out: RadiusPath[] = [];
        const planningConfig = configStore.get();
        const radiusSpecs = radiusSpecsForOverlay(planningConfig, radiusPreviewTier);

        if (radiusSpecs.length > 0) {
          for (const [dsId, plan] of plans) {
            const ds = datasets.get(dsId);
            if (!ds) continue;
            const visibleRegion = parseVisibleRegion(ws, dsId);
            if (!visibleRegion) continue;

            let positions: Record<string, [number, number]> = {};
            try {
              positions = JSON.parse(ws.member_positions(dsId));
            } catch {
              positions = {};
            }
            const centerGlobal = visibleRegionCenterVox(visibleRegion);
            let frame: TileFrame | null = null;
            let centerLocal: [number, number, number] = centerGlobal;

            if (is3D) {
              const imgById = new Map(ds.manifest.images.map(i => [i.image_id, i]));
              let best: {
                score: number;
                frame: TileFrame;
                pos: [number, number];
              } | null = null;
              for (const entry of plan.activeSet) {
                if (entry.kind !== "tile") continue;
                const pos = positions[entry.entityId];
                const img = imgById.get(entry.imageId);
                const lvl0 = img?.multiscale.levels[0];
                if (!pos || !lvl0) continue;
                const candidate = getFrame(dsId, entry.imageId, lvl0.shape);
                if (!candidate.model) continue;
                candidate.pos = pos;
                const score = distanceToVoxelAabbSq(
                  centerGlobal,
                  [pos[0], pos[1], 0],
                  [
                    pos[0] + lvl0.shape[Axis.X],
                    pos[1] + lvl0.shape[Axis.Y],
                    lvl0.shape[Axis.Z],
                  ],
                );
                if (!best || score < best.score) {
                  best = { score, frame: candidate, pos };
                }
              }
              if (!best) continue;
              frame = best.frame;
              centerLocal = [
                centerGlobal[0] - best.pos[0],
                centerGlobal[1] - best.pos[1],
                centerGlobal[2],
              ];
            } else {
              frame = {
                pos: [0, 0],
                fullVoxel: [1, 1, 1],
                model: null,
                placement: readPlacement(ws, dsId),
              };
            }
            if (!frame) continue;

            const planes: RadiusPath["plane"][] = is3D ? ["xy", "xz", "yz"] : ["xy"];
            for (const spec of radiusSpecs) {
              const radiusVox = renderRadiusLimitVox(visibleRegion, spec.radiusView);
              if (!Number.isFinite(radiusVox)) continue;
              const title = `${spec.tier} render radius ${spec.radiusView.toFixed(2)}x (${radiusVox.toFixed(1)} vox)`;
              for (const plane of planes) {
                const paths = projectRadiusCircle(
                  ws,
                  frame,
                  centerLocal,
                  radiusVox,
                  plane,
                  dpr,
                );
                for (let i = 0; i < paths.length; i++) {
                  out.push({
                    key: `${dsId}/${spec.tier}/${plane}/${i}`,
                    tier: spec.tier,
                    plane,
                    d: paths[i],
                    title,
                  });
                }
              }
            }
          }
        }
        setRadiusPaths(out);
      } else if (radiusPaths.length > 0) {
        setRadiusPaths([]);
      }

      if (enabled.groupModes && plans) {
        const out: GroupBadge[] = [];
        for (const [dsId, plan] of plans) {
          const ds = datasets.get(dsId);
          if (!ds) continue;
          const parentByEntity = new Map<string, string | null>();
          for (const ent of ds.manifest.entities) {
            parentByEntity.set(ent.id, ent.parent ?? null);
          }
          let positions: Record<string, [number, number]> = {};
          try {
            positions = JSON.parse(ws.member_positions(dsId));
          } catch {
            positions = {};
          }
          const imgById = new Map(ds.manifest.images.map(i => [i.image_id, i]));
          const cacheSnap = cpuCache?.snapshot() ?? null;
          const coverageByGroup = buildGroupTierCoverage(
            plan,
            parentByEntity,
            cpuCache,
            cacheSnap,
          );

          // Per-group aggregator carrying world centroids of tiles.
          const groups = new Map<string, {
            lod: number | null;
            coverage: GroupTierCoverage;
            worldCentroids: Array<[number, number, number]>;
          }>();

          const addTile = (
            groupId: string,
            entityId: string,
            imageId: string,
            lod: number | null,
          ) => {
            const pos = positions[entityId];
            const img = imgById.get(imageId);
            const lvl0 = img?.multiscale.levels[0];
            if (!pos || !lvl0) return;
            const frame = getFrame(dsId, imageId, lvl0.shape);
            frame.pos = pos;
            const worldCenter = tileWorldCenter(frame);
            let agg = groups.get(groupId);
            if (!agg) {
              agg = {
                lod,
                coverage: coverageByGroup.get(groupId) ?? emptyGroupTierCoverage(),
                worldCentroids: [],
              };
              groups.set(groupId, agg);
            }
            agg.worldCentroids.push(worldCenter);
          };

          for (const entry of plan.activeSet) {
            // Invisible entries get no badge.
            if (entry.kind !== "tile") continue;
            const groupId = parentByEntity.get(entry.entityId) ?? entry.entityId;
            addTile(groupId, entry.entityId, entry.imageId, entry.detailLevels[0] ?? null);
          }

          for (const [groupId, agg] of groups) {
            if (agg.worldCentroids.length === 0) continue;
            let sumX = 0;
            let sumY = 0;
            let sumZ = 0;
            for (const c of agg.worldCentroids) {
              sumX += c[0];
              sumY += c[1];
              sumZ += c[2];
            }
            const n = agg.worldCentroids.length;
            const screen = projectWorld(ws, sumX / n, sumY / n, sumZ / n, dpr);
            if (!screen) continue;
            if (screen.x < xMin || screen.y < yMin || screen.x > xMax || screen.y > yMax) {
              continue;
            }
            out.push({
              key: `${dsId}/${groupId}`,
              centerX: screen.x,
              centerY: screen.y,
              mode: tierCoverageMode(agg.coverage),
              label: formatTierCoverageLabel(agg.coverage, agg.lod),
              title: formatTierCoverageTitle(agg.coverage, agg.lod),
            });
          }
        }
        setBadges(out);
      } else if (badges.length > 0) {
        setBadges([]);
      }

      if (showGrid && plans && cpuCache) {
        const out: ChunkCell[] = [];
        const resolvedLayers = readResolvedLayers(ws, ws.active_view());
        const planningConfig = configStore.get();
        const snap = cpuCache.snapshot();
        // Rank lookup for "planned" color gradient. Built once per
        // tick: pending queue is in priority order, so array index ==
        // rank. Key matches CpuCache's inFlightKey: `${entityId}/${chunkKey}`.
        const pending = cpuCache.getPendingSnapshot();
        const rankByKey = new Map<string, number>();
        for (let i = 0; i < pending.length; i++) {
          const r = pending[i];
          rankByKey.set(`${r.entityId}/${r.chunkKey}`, i);
        }

        outer: for (const [dsId, plan] of plans) {
          if (out.length >= MAX_CHUNK_RECTS) break;
          const ds = datasets.get(dsId);
          if (!ds) continue;
          // A group proxy is fetched for the layer's first shown channel at
          // its own timepoint.
          const layer = resolvedLayers.get(dsId);
          const t = layer?.t ?? ws.t();
          const c = shownChannels(layer)[0];
          let positions: Record<string, [number, number]> = {};
          try {
            positions = JSON.parse(ws.member_positions(dsId));
          } catch {
            positions = {};
          }
          const imgById = new Map(ds.manifest.images.map(i => [i.image_id, i]));
          const visibleRegion = parseVisibleRegion(ws, dsId);

          for (const entry of plan.activeSet) {
            if (out.length >= MAX_CHUNK_RECTS) break outer;

            // Invisible entries contribute no chunks.
            if (entry.kind === "invisible") continue;
            if (!visibleRegion) continue;
            const pos = positions[entry.entityId];
            const img = imgById.get(entry.imageId);
            if (!pos || !img) continue;
            const lvl0 = img.multiscale.levels[0];
            if (!lvl0) continue;
            const frame = getFrame(dsId, entry.imageId, lvl0.shape);
            frame.pos = pos;
            const projectVoxel = voxelProjector(ws, frame, dpr);
            const fullX = lvl0.shape[Axis.X];
            const fullY = lvl0.shape[Axis.Y];

            const cachedSet = snap.cached.get(entry.entityId);
            const inFlightSet = snap.inFlight.get(entry.entityId);

            const residency = (
              key: string,
              tier: ResidencyTier,
              geometry: ChunkRadiusGeometry,
              chunk: { x: number; y: number; z: number },
            ): boolean => {
              const radiusView = tier === "detail"
                ? planningConfig.detailRenderRadiusView
                : planningConfig.coarseRenderRadiusView;
              if (!chunkWithinRenderRadius({
                region: visibleRegion,
                radiusView,
                layoutPositionVox: pos,
                geometry,
                chunk,
              })) {
                return false;
              }
              return cpuCache.deliveryState.isChunkHeld(entry.imageId, c, key, tier);
            };

            const statusFor = (key: string): Pick<ChunkCell, "status" | "priorityRank" | "tier"> => {
              if (cachedSet?.has(key)) {
                return {
                  status: "cached",
                  tier: enabled.cachedTier ? cpuCache.getCachedChunkTier(entry.entityId, key) : undefined,
                };
              }
              if (inFlightSet?.has(key)) return { status: "in-flight" };
              return {
                status: "planned",
                priorityRank: enabled.plannedRank ? rankByKey.get(`${entry.entityId}/${key}`) : undefined,
              };
            };

            const coarseLevel = entry.coarseLevel ?? null;
            const coarseLvl = coarseLevel !== null ? img.multiscale.levels[coarseLevel] : undefined;
            const coarseGeometry = coarseLvl ? geometryForLevels(lvl0, coarseLvl) : null;
            const coarseChunkAt = (vx: number, vy: number, vz: number): {
              key: string;
              x: number;
              y: number;
              z: number;
            } | null => {
              if (coarseLevel === null || !coarseLvl || !coarseGeometry) return null;
              const [cwX, cwY, cwZ] = coarseGeometry.chunkDims.map((chunkDim, i) =>
                chunkDim * (coarseGeometry.fullDims[i] / Math.max(1, coarseGeometry.levelDims[i])),
              ) as [number, number, number];
              const maxXIdx = Math.ceil(coarseLvl.shape[Axis.X] / coarseLvl.chunk_shape[Axis.X]);
              const maxYIdx = Math.ceil(coarseLvl.shape[Axis.Y] / coarseLvl.chunk_shape[Axis.Y]);
              const maxZIdx = Math.ceil(coarseLvl.shape[Axis.Z] / coarseLvl.chunk_shape[Axis.Z]);
              const xIdx = Math.max(0, Math.min(maxXIdx - 1, Math.floor(vx / cwX)));
              const yIdx = Math.max(0, Math.min(maxYIdx - 1, Math.floor(vy / cwY)));
              const zIdx = Math.max(0, Math.min(maxZIdx - 1, Math.floor(vz / cwZ)));
              return {
                key: chunkKeyFor(coarseLevel, t, c, zIdx, yIdx, xIdx),
                x: xIdx,
                y: yIdx,
                z: zIdx,
              };
            };

            const appendSource = (level: number, sourceTier: ResidencyTier): void => {
              const lvl = img.multiscale.levels[level];
              if (!lvl) return;
              const geometry = geometryForLevels(lvl0, lvl);
              const [chunkWorldX, chunkWorldY, chunkWorldZ] = geometry.chunkDims.map((chunkDim, i) =>
                chunkDim * (geometry.fullDims[i] / Math.max(1, geometry.levelDims[i])),
              ) as [number, number, number];
              const maxCol = Math.ceil(lvl.shape[Axis.X] / lvl.chunk_shape[Axis.X]);
              const maxRow = Math.ceil(lvl.shape[Axis.Y] / lvl.chunk_shape[Axis.Y]);
              const maxZ = Math.ceil(lvl.shape[Axis.Z] / lvl.chunk_shape[Axis.Z]);

              const localMinX = visibleRegion.xyBoundsVox[0] - pos[0];
              const localMaxX = visibleRegion.xyBoundsVox[2] - pos[0];
              const localMinY = visibleRegion.xyBoundsVox[1] - pos[1];
              const localMaxY = visibleRegion.xyBoundsVox[3] - pos[1];
              if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) return;

              const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
              const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
              const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
              const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));
              const zStart = Math.max(0, Math.floor(visibleRegion.zRangeVox[0] / chunkWorldZ));
              const zEnd = Math.min(maxZ, Math.max(0, Math.ceil(visibleRegion.zRangeVox[1] / chunkWorldZ)));

              for (let iz = zStart; iz < zEnd; iz++) {
                if (out.length >= MAX_CHUNK_RECTS) return;
                for (let row = rowStart; row < rowEnd; row++) {
                  if (out.length >= MAX_CHUNK_RECTS) return;
                  for (let col = colStart; col < colEnd; col++) {
                    if (out.length >= MAX_CHUNK_RECTS) return;
                    const key = chunkKeyFor(level, t, c, iz, row, col);
                    const boxMin: [number, number, number] = [col * chunkWorldX, row * chunkWorldY, iz * chunkWorldZ];
                    const boxMax: [number, number, number] = [
                      (col + 1) * chunkWorldX,
                      (row + 1) * chunkWorldY,
                      (iz + 1) * chunkWorldZ,
                    ];
                    const box = projectChunkBox(projectVoxel, boxMin, boxMax);
                    if (!box || offScreen(box)) continue;

                    let displayTier: DisplayTier = "missing";
                    let statusKey = key;
                    if (sourceTier === "detail") {
                      if (residency(key, "detail", geometry, { x: col, y: row, z: iz })) {
                        displayTier = "detail";
                      } else {
                        const coarseChunk = coarseChunkAt(
                          (col + 0.5) * chunkWorldX,
                          (row + 0.5) * chunkWorldY,
                          (iz + 0.5) * chunkWorldZ,
                        );
                        if (
                          coarseChunk &&
                          coarseGeometry &&
                          residency(coarseChunk.key, "coarse", coarseGeometry, coarseChunk)
                        ) {
                          displayTier = "coarse";
                          statusKey = coarseChunk.key;
                        }
                      }
                    } else if (residency(key, "coarse", geometry, { x: col, y: row, z: iz })) {
                      displayTier = "coarse";
                    }

                    // The trace is read for the cell's own chunk, even when
                    // its pixels come from the coarse chunk behind it: "why
                    // is this chunk not here" is a question about this chunk.
                    out.push({
                      key: `${dsId}/${entry.entityId}/${sourceTier}/${key}`,
                      datasetId: dsId,
                      entityId: entry.entityId,
                      chunkKey: key,
                      level,
                      t,
                      c,
                      z: iz,
                      y: row,
                      x: col,
                      left: box.left,
                      top: box.top,
                      width: box.width,
                      height: box.height,
                      sourceTier: displayTier,
                      ...statusFor(statusKey),
                      ...volumeFields(
                        box,
                        voxelToWorld(
                          frame,
                          (boxMin[0] + boxMax[0]) / 2,
                          (boxMin[1] + boxMax[1]) / 2,
                          (boxMin[2] + boxMax[2]) / 2,
                        ),
                      ),
                    });
                  }
                }
              }
            };

            if (coarseLevel !== null) {
              appendSource(coarseLevel, "coarse");
            }
            for (const level of entry.detailLevels) appendSource(level, "detail");
          }
        }
        out.sort((a, b) => tierDrawOrder(a) - tierDrawOrder(b));
        const window = traceRecorder.openIntervalMs;
        const input = {
          cells: out,
          colors: readOverlayColors(),
          modes: enabled,
          readingOf: (cell: ChunkCell) => traceRecorder.readChunk(cell),
          windowMs: window,
          selection,
        };
        const list = is3D ? buildVolumeDrawList(input) : buildChunkDrawList(input);
        drawListRef.current = list;
        setDrawList(list);
        setWindowMs(window);
        refreshInspector();
      } else if (drawListRef.current.items.length > 0) {
        drawListRef.current = EMPTY_DRAW_LIST;
        setDrawList(EMPTY_DRAW_LIST);
        refreshInspector();
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, showGrid, radiusPreviewTier, viewMode, datasets, cpuCache, wasmSceneRef, canvasRef, renderLoopRef, refreshInspector, selection]);

  if (!anyEnabled) return null;

  const absence = overlayAbsence(enabled, drawList, windowMs);
  const brushed = selectionCaption(selection, drawList);
  const volumeList = viewMode === "3d" && isVolumeDrawList(drawList) ? drawList : null;
  const hoveredBox = volumeList && inspector ? volumeList.items.find(item => item.key === inspector.key) ?? null : null;

  return (
    <div className="debug-overlays" style={{ width: size.w, height: size.h }}>
      {showGrid && viewMode !== "3d" && drawList.items.map(item => (
        <div
          key={item.key}
          className="debug-overlays-cell"
          data-selected={item.selected ? "true" : undefined}
          style={{
            left: item.left,
            top: item.top,
            width: item.width,
            height: item.height,
            background: item.fill,
            border: item.border,
            opacity: selection !== null && !item.selected ? UNSELECTED_OPACITY : undefined,
          }}
          title={item.tooltip}
        />
      ))}
      {showGrid && volumeList && volumeList.batches.length > 0 && (
        <svg
          data-testid="overlay-boxes"
          className="debug-overlays-svg"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
        >
          {/* Halos first, so every edge draws over every halo. */}
          {volumeList.batches.map((batch, i) =>
            batch.style.halo ? (
              <path
                key={`halo-${i}`}
                d={batch.d}
                fill="none"
                stroke={batch.style.halo.stroke}
                strokeWidth={batch.style.halo.strokeWidth}
                strokeLinecap="round"
                opacity={selection !== null && !batch.selected ? UNSELECTED_OPACITY : undefined}
              />
            ) : null,
          )}
          {hoveredBox && (
            <path
              data-testid="overlay-box-hovered"
              data-chunk={hoveredBox.cell.chunkKey}
              className="debug-overlays-hovered-box"
              d={hoveredBox.path}
              fill="none"
              strokeWidth={hoveredBox.style.strokeWidth + HOVERED_BOX_EXTRA_WIDTH}
              strokeLinecap="round"
            />
          )}
          {volumeList.batches.map((batch, i) => (
            <path
              key={`edges-${i}`}
              data-testid="overlay-box-batch"
              data-count={batch.count}
              data-selected={batch.selected ? "true" : undefined}
              d={batch.d}
              fill="none"
              stroke={batch.style.stroke}
              strokeWidth={batch.style.strokeWidth}
              strokeDasharray={batch.style.dash ?? undefined}
              strokeLinecap="round"
              opacity={selection !== null && !batch.selected ? UNSELECTED_OPACITY : undefined}
            />
          ))}
        </svg>
      )}
      {showGrid && inspector && (
        <div
          data-testid="overlay-inspector"
          role="tooltip"
          className="debug-overlays-card debug-overlays-inspector"
          style={{ left: inspector.left, top: inspector.top }}
        >
          <div className="debug-overlays-inspector-title">{inspector.view.title}</div>
          {inspector.view.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {(absence || brushed) && (
        <div className="debug-overlays-captions">
          {brushed && (
            <div data-testid="overlay-selection" className="debug-overlays-card debug-overlays-caption">
              {brushed}
            </div>
          )}
          {absence && (
            <div data-testid="overlay-absence" className="debug-overlays-card debug-overlays-caption">
              {absence}
            </div>
          )}
        </div>
      )}
      {(enabled.renderRadius || radiusPreviewTier !== null) && radiusPaths.length > 0 && (
        <svg
          className="debug-overlays-svg"
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
        >
          {radiusPaths.map(r => {
            const isPrimaryPlane = r.plane === "xy";
            const dash = r.tier === "coarse"
              ? isPrimaryPlane ? "8 5" : "4 6"
              : isPrimaryPlane ? undefined : "2 6";
            return (
              <path
                key={r.key}
                className="debug-overlays-radius"
                data-tier={r.tier}
                d={r.d}
                fill="none"
                strokeWidth={isPrimaryPlane ? 2.25 : 1.5}
                strokeDasharray={dash}
                opacity={isPrimaryPlane ? 1 : 0.72}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${r.title}; ${r.plane.toUpperCase()} plane`}</title>
              </path>
            );
          })}
        </svg>
      )}
      {enabled.groupModes && badges.map(b => (
        <div
          key={b.key}
          className="debug-overlays-badge"
          data-mode={b.mode}
          style={{ left: b.centerX, top: b.centerY }}
          title={b.title}
        >
          {b.label}
        </div>
      ))}
    </div>
  );
}
