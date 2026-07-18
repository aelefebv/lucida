/**
 * Debug overlay layer. Sits absolutely-positioned above the canvas with
 * pointer-events: none, so it never steals interaction from the viewer.
 * Reads from existing scene + orchestrator + cache state — no new
 * production-side state added for it to work.
 *
 * Primary overlays, each gated by its own toggle in the Logging tab:
 *  - groupModes: per-group badge with detail/coarse worker-delivered coverage
 *  - chunkGrid: planned LOD chunk grid for every visible tile, colored
 *    by status or tier. Capped at MAX_CHUNK_RECTS per tick as a backstop for
 *    pathological cases.
 *  - renderRadius: actual detail/coarse render-radius boundary, projected
 *    through the same voxel→world→screen path as chunk overlays.
 *
 * Both modes (slice + volume) share the same projection pipeline:
 *
 *   voxel coords  →  world coords  →  WasmScene.project_to_screen
 *
 * The middle step differs by mode. Slice: world == voxel + tile
 * position offset (camera projects voxel space directly). Volume: world
 * == tile model matrix * (voxel / fullVoxel), which maps the tile's
 * unit cube into normalized world space and bakes in the Y-flip and
 * physical-extent normalization the renderer applies.
 */
import { useEffect, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { CpuCache } from "../pipeline/fetch/index.ts";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  chunkWithinRenderRadius,
  renderRadiusLimitVox,
  visibleRegionCenterVox,
  type ChunkRadiusGeometry,
} from "../pipeline/renderRadius.ts";
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
  type RenderRadiusPreviewTier,
} from "./logging.ts";
import { radiusSpecsForOverlay } from "./radiusPreview.ts";

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

const MODE_COLOR: Record<string, string> = {
  "tiles-with-detail": "#4f4",
  "render-detail": "#4f4",
  "render-coarse": "#6cf",
  "render-waiting": "#fb4",
};

const MODE_LABEL: Record<string, string> = {
  "tiles-with-detail": "FD",
};

interface GroupBadge {
  key: string;
  centerX: number;
  centerY: number;
  mode: string;
  label: string;
  title: string;
}

type OverlayTier = "detail" | "coarse";
type DisplayTier = OverlayTier | "missing";

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

interface ChunkRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: "cached" | "in-flight" | "planned";
  /** Current render tier visible to the shader, or missing fallback. */
  sourceTier?: DisplayTier;
  /**
   * For `status === "planned"`: zero-based rank in the pending fetch
   * queue (0 = next to fetch). `undefined` means "in plan but not in
   * the pending queue we sampled" — the chunk was deduped, dropped, or
   * sampled between dequeue and fetch start. Useful debug signal: a
   * gray cell where you'd expect a hot-orange one says "planning
   * thinks this should fetch, scheduler doesn't have it queued."
   */
  priorityRank?: number;
  /**
   * For `status === "cached"`: which eviction tier the chunk is in.
   * Surfaces eviction churn — `active-detail` won't evict under
   * normal pressure, `demoted-detail` is next-to-go, `prefetch` is
   * cheapest. `null` for cached chunks where the lookup failed
   * (rare; treat as fallback green).
   */
  tier?: import("../pipeline/fetch/index.ts").EvictionTier | null;
}

interface RadiusPath {
  key: string;
  tier: OverlayTier;
  plane: "xy" | "xz" | "yz";
  d: string;
  title: string;
}

const SOLID_CACHED = "rgba(80, 220, 120, 0.30)";
const SOLID_IN_FLIGHT = "rgba(240, 200, 70, 0.35)";
const SOLID_PLANNED = "rgba(240, 90, 90, 0.30)";
const TIER_DETAIL = "rgba(80, 220, 120, 0.36)";
const TIER_COARSE = "rgba(245, 205, 70, 0.34)";
const TIER_MISSING = "rgba(245, 70, 70, 0.38)";
const RADIUS_DETAIL_STROKE = "rgba(80, 255, 130, 0.90)";
const RADIUS_COARSE_STROKE = "rgba(255, 220, 70, 0.90)";
const RADIUS_SAMPLE_COUNT = 96;

function tierColor(tier: DisplayTier | undefined): string | null {
  switch (tier) {
    case "detail": return TIER_DETAIL;
    case "coarse": return TIER_COARSE;
    case "missing": return TIER_MISSING;
    default: return null;
  }
}

function tierDrawOrder(rect: ChunkRect): number {
  if (rect.sourceTier === "missing") return 0;
  if (rect.sourceTier === "coarse") return 0;
  if (rect.sourceTier === "detail") return 1;
  return 2;
}

/**
 * Color for a planned chunk based on its position in the pending fetch
 * queue. Rank 0 = next-to-fetch (bright orange); higher = colder.
 * Discrete bands (rather than smooth interpolation) keep the visual
 * easy to read at a glance: orange = imminent, red = soon, dim red =
 * way back.
 */
function plannedColor(rank: number | undefined): string {
  if (rank === undefined) return "rgba(140, 140, 140, 0.20)";
  if (rank < 5) return "rgba(255, 180, 60, 0.50)";
  if (rank < 20) return "rgba(245, 110, 70, 0.40)";
  if (rank < 60) return "rgba(220, 70, 70, 0.32)";
  return "rgba(160, 40, 40, 0.24)";
}

/**
 * Color for a cached chunk based on eviction tier. Stays in the green
 * family so "cached = green" reads at a glance, with hue shifts that
 * convey "how at-risk":
 *   active-detail  → bright green (safest)
 *   demoted-detail → pale sage    (will evict on memory pressure)
 *   prefetch       → teal         (cheapest to lose)
 */
function cachedColor(
  tier: import("../pipeline/fetch/index.ts").EvictionTier | null | undefined,
): string {
  switch (tier) {
    case "active-detail":  return "rgba(80, 220, 120, 0.36)";
    case "demoted-detail": return "rgba(150, 200, 140, 0.30)";
    case "prefetch":       return "rgba(70, 200, 200, 0.32)";
    default:               return SOLID_CACHED;
  }
}

function emptyTierCoverageCounts(): TierCoverageCounts {
  return { wanted: 0, shown: 0, ready: 0, inFlight: 0 };
}

function emptyGroupTierCoverage(): GroupTierCoverage {
  return {
    detail: emptyTierCoverageCounts(),
    coarse: emptyTierCoverageCounts(),
  };
}

function overlayTierForRequest(req: ChunkRequest): OverlayTier | null {
  if (req.lane === "detail") return "detail";
  if (req.lane === "coarse") return "coarse";
  return null;
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
    if (ready || cpuCache?.deliveryState.wasChunkSent(req.imageId, req.c, req.chunkKey, tier)) {
      counts.shown++;
    }
  }
  return out;
}

// eslint-disable-next-line react-refresh/only-export-components
export function formatTierCoverageLabel(
  coverage: GroupTierCoverage,
  fallbackLabel: string,
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
  return `${fallbackLabel}${fallbackLod !== null ? ` L${fallbackLod}` : ""}`;
}

// eslint-disable-next-line react-refresh/only-export-components
export function tierCoverageMode(
  coverage: GroupTierCoverage,
  fallbackMode: string,
): string {
  const detailComplete =
    coverage.detail.wanted > 0 && coverage.detail.shown >= coverage.detail.wanted;
  if (detailComplete) return "render-detail";
  if (coverage.coarse.shown > 0) return "render-coarse";
  if (coverage.detail.shown > 0) return "render-detail";
  if (coverage.detail.wanted > 0 || coverage.coarse.wanted > 0) {
    return "render-waiting";
  }
  return fallbackMode;
}

// eslint-disable-next-line react-refresh/only-export-components
export function formatTierCoverageTitle(
  coverage: GroupTierCoverage,
  fallbackLabel: string,
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
  const modePart = `${fallbackLabel}${fallbackLod !== null ? ` L${fallbackLod}` : ""}`;
  if (parts.length === 0) return modePart;
  return `${parts.join("; ")}; planner ${modePart}`;
}

function parseVisibleRegion(ws: WasmScene, dsId: string): VisibleRegion | null {
  let raw: string | null = null;
  try {
    raw = ws.visible_region(dsId);
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
  return [frame.pos[0] + vx, frame.pos[1] + vy, vz];
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

/**
 * Project a tile-local voxel-space AABB to a screen-space AABB by
 * projecting all 8 corners and reducing.
 */
function projectVoxelAabb(
  ws: WasmScene,
  frame: TileFrame,
  vMin: [number, number, number],
  vMax: [number, number, number],
  dpr: number,
): { x: number; y: number; w: number; h: number } | null {
  let sxMin = Infinity;
  let syMin = Infinity;
  let sxMax = -Infinity;
  let syMax = -Infinity;
  let any = false;
  for (let i = 0; i < 8; i++) {
    const vx = i & 1 ? vMax[0] : vMin[0];
    const vy = (i >> 1) & 1 ? vMax[1] : vMin[1];
    const vz = (i >> 2) & 1 ? vMax[2] : vMin[2];
    const [wx, wy, wz] = voxelToWorld(frame, vx, vy, vz);
    const p = projectWorld(ws, wx, wy, wz, dpr);
    if (!p) continue;
    any = true;
    if (p.x < sxMin) sxMin = p.x;
    if (p.y < syMin) syMin = p.y;
    if (p.x > sxMax) sxMax = p.x;
    if (p.y > syMax) syMax = p.y;
  }
  if (!any) return null;
  return { x: sxMin, y: syMin, w: sxMax - sxMin, h: syMax - syMin };
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
  const [radiusPreviewTier, setRadiusPreviewTier] = useState<RenderRadiusPreviewTier | null>(
    getRenderRadiusPreviewTier,
  );
  useEffect(() => {
    return onRenderRadiusPreviewChanged(() => setRadiusPreviewTier(getRenderRadiusPreviewTier()));
  }, []);

  const anyEnabled = DEBUG_OVERLAYS.some(o => enabled[o]) || radiusPreviewTier !== null;

  const [badges, setBadges] = useState<GroupBadge[]>([]);
  const [chunks, setChunks] = useState<ChunkRect[]>([]);
  const [radiusPaths, setRadiusPaths] = useState<RadiusPath[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    if (!anyEnabled) {
      // Reset to empty when overlays are toggled off — no external state
      // to subscribe to, the toggle IS the state change we react to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBadges([]);
      setChunks([]);
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
      // WASM 2D projection now returns CSS-logical pixels; 3D projection still
      // returns physical viewport pixels and therefore needs DPR normalization.
      const projectionScale = is3D ? dpr : 1;

      const coord = renderLoopRef.current?.getTickCoordinator();
      const plans = coord?.getLastPlans();

      // Off-screen culling margin (CSS px).
      const xMin = -64;
      const yMin = -32;
      const xMax = canvasWCss + 64;
      const yMax = canvasHCss + 32;

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
                  projectionScale,
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

      // Group badges
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
            mode: string;
            lod: number | null;
            coverage: GroupTierCoverage;
            worldCentroids: Array<[number, number, number]>;
          }>();

          const addTile = (
            groupId: string,
            entityId: string,
            imageId: string,
            mode: string,
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
                mode,
                lod,
                coverage: coverageByGroup.get(groupId) ?? emptyGroupTierCoverage(),
                worldCentroids: [],
              };
              groups.set(groupId, agg);
            }
            agg.worldCentroids.push(worldCenter);
          };

          for (const entry of plan.activeSet) {
            if (entry.kind === "tile") {
              const groupId = parentByEntity.get(entry.entityId) ?? entry.entityId;
              addTile(groupId, entry.entityId, entry.imageId, entry.mode, entry.targetLod);
            }
            // entry.kind === "invisible" — skipped (not rendered as a
            // group badge; invisibles never had a promotion mode).
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
            const screen = projectWorld(ws, sumX / n, sumY / n, sumZ / n, projectionScale);
            if (!screen) continue;
            if (screen.x < xMin || screen.y < yMin || screen.x > xMax || screen.y > yMax) {
              continue;
            }
            out.push({
              key: `${dsId}/${groupId}`,
              centerX: screen.x,
              centerY: screen.y,
              mode: tierCoverageMode(agg.coverage, agg.mode),
              label: formatTierCoverageLabel(
                agg.coverage,
                MODE_LABEL[agg.mode] ?? agg.mode,
                agg.lod,
              ),
              title: formatTierCoverageTitle(
                agg.coverage,
                MODE_LABEL[agg.mode] ?? agg.mode,
                agg.lod,
              ),
            });
          }
        }
        setBadges(out);
      } else if (badges.length > 0) {
        setBadges([]);
      }

      // Chunk grid for every visible tile-mode entry.
      if (enabled.chunkGrid && plans && cpuCache) {
        const out: ChunkRect[] = [];
        const t = ws.t();
        const c = ws.c();
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

            // Invisible entries don't contribute chunks.
            if (entry.kind === "invisible") continue;
            if (!visibleRegion) continue;
            const pos = positions[entry.entityId];
            const img = imgById.get(entry.imageId);
            if (!pos || !img) continue;
            const lvl0 = img.multiscale.levels[0];
            if (!lvl0) continue;
            const frame = getFrame(dsId, entry.imageId, lvl0.shape);
            frame.pos = pos;
            const fullX = lvl0.shape[Axis.X];
            const fullY = lvl0.shape[Axis.Y];

            const cachedSet = snap.cached.get(entry.entityId);
            const inFlightSet = snap.inFlight.get(entry.entityId);

            const residency = (
              key: string,
              tier: OverlayTier,
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
              const worker = renderLoopRef.current?.workerChunkResidency(dsId, entry.imageId, c, key) ?? "unknown";
              if (worker === "resident") return true;
              if (worker === "missing") return false;
              return cpuCache.deliveryState.wasChunkSent(entry.imageId, c, key, tier);
            };

            const statusFor = (key: string): Pick<ChunkRect, "status" | "priorityRank" | "tier"> => {
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

            const appendSource = (level: number, sourceTier: OverlayTier): void => {
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
                    const rect = projectVoxelAabb(
                      ws,
                      frame,
                      [col * chunkWorldX, row * chunkWorldY, iz * chunkWorldZ],
                      [(col + 1) * chunkWorldX, (row + 1) * chunkWorldY, (iz + 1) * chunkWorldZ],
                      projectionScale,
                    );
                    if (!rect) continue;
                    if (rect.x + rect.w < xMin || rect.y + rect.h < yMin || rect.x > xMax || rect.y > yMax) {
                      continue;
                    }

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

                    out.push({
                      key: `${dsId}/${entry.entityId}/${sourceTier}/${key}`,
                      x: rect.x,
                      y: rect.y,
                      w: rect.w,
                      h: rect.h,
                      sourceTier: displayTier,
                      ...statusFor(statusKey),
                    });
                  }
                }
              }
            };

            if (coarseLevel !== null) {
              appendSource(coarseLevel, "coarse");
            }
            appendSource(entry.detailLevel ?? entry.targetLod, "detail");
          }
        }
        out.sort((a, b) => tierDrawOrder(a) - tierDrawOrder(b));
        setChunks(out);
      } else if (chunks.length > 0) {
        setChunks([]);
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, radiusPreviewTier, viewMode, datasets, cpuCache, wasmSceneRef, canvasRef, renderLoopRef]);

  if (!anyEnabled) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: size.w,
        height: size.h,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {enabled.chunkGrid && chunks.map(c => {
        // Each color band gates on its own toggle so the simple
        // 3-color view (cached/in-flight/planned) is recoverable by
        // turning off both sub-toggles.
        const tierBg = enabled.chunkTier ? tierColor(c.sourceTier) : null;
        const bg =
          tierBg ??
          (c.status === "cached"
            ? enabled.cachedTier ? cachedColor(c.tier) : SOLID_CACHED
            : c.status === "in-flight"
              ? SOLID_IN_FLIGHT
              : enabled.plannedRank ? plannedColor(c.priorityRank) : SOLID_PLANNED);
        const statusTooltip = c.status === "cached"
          ? enabled.cachedTier && c.tier
            ? `cached · tier ${c.tier}`
            : "cached"
          : c.status === "in-flight"
            ? "in-flight"
            : enabled.plannedRank && c.priorityRank !== undefined
              ? `planned · queue rank ${c.priorityRank}`
              : enabled.plannedRank
                ? "planned · not in pending queue"
                : "planned";
        const tooltip = c.sourceTier ? `${c.sourceTier} · ${statusTooltip}` : statusTooltip;
        return (
          <div
            key={c.key}
            style={{
              position: "absolute",
              left: c.x,
              top: c.y,
              width: c.w,
              height: c.h,
              background: bg,
              border: "1px solid rgba(255, 255, 255, 0.22)",
              boxSizing: "border-box",
            }}
            title={tooltip}
          />
        );
      })}
      {(enabled.renderRadius || radiusPreviewTier !== null) && radiusPaths.length > 0 && (
        <svg
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          {radiusPaths.map(r => {
            const stroke = r.tier === "detail" ? RADIUS_DETAIL_STROKE : RADIUS_COARSE_STROKE;
            const isPrimaryPlane = r.plane === "xy";
            const dash = r.tier === "coarse"
              ? isPrimaryPlane ? "8 5" : "4 6"
              : isPrimaryPlane ? undefined : "2 6";
            return (
              <path
                key={r.key}
                d={r.d}
                fill="none"
                stroke={stroke}
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
          style={{
            position: "absolute",
            left: b.centerX,
            top: b.centerY,
            transform: "translate(-50%, -50%)",
            padding: "1px 5px",
            background: "rgba(0, 0, 0, 0.7)",
            color: MODE_COLOR[b.mode] ?? "#fff",
            border: `1px solid ${MODE_COLOR[b.mode] ?? "#fff"}`,
            borderRadius: 3,
            fontFamily: "monospace",
            fontSize: 10,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
          }}
          title={b.title}
        >
          {b.label}
        </div>
      ))}
    </div>
  );
}
