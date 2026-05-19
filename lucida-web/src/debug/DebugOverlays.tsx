/**
 * Debug overlay layer. Sits absolutely-positioned above the canvas with
 * pointer-events: none, so it never steals interaction from the viewer.
 * Reads from existing scene + orchestrator + cache state — no new
 * production-side state added for it to work.
 *
 * Two overlays, each gated by its own toggle in the Logging tab:
 *  - wellModes: per-well badge with detail/coarse worker-delivered coverage
 *  - chunkGrid: LOD chunk grid for every visible field, colored by
 *    status. Capped at MAX_CHUNK_RECTS per tick as a backstop for
 *    pathological cases.
 *
 * Both modes (slice + volume) share the same projection pipeline:
 *
 *   voxel coords  →  world coords  →  WasmScene.project_to_screen
 *
 * The middle step differs by mode. Slice: world == voxel + field
 * position offset (camera projects voxel space directly). Volume: world
 * == field model matrix * (voxel / fullVoxel), which maps the field's
 * unit cube into normalized world space and bakes in the Y-flip and
 * physical-extent normalization the renderer applies.
 */
import { useEffect, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { CpuCache } from "../pipeline/fetch/index.ts";
import type {
  CacheStateSnapshot,
  ChunkRequest,
  RequestPlan,
} from "../pipeline/planning/index.ts";
import {
  DEBUG_OVERLAYS,
  isOverlayEnabled,
  onOverlaysChanged,
  type DebugOverlay,
} from "./logging.ts";

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
  "well-as-proxy": "#88f",
  "fields-with-proxy-fallback": "#fb4",
  "fields-with-detail": "#4f4",
  "render-detail": "#4f4",
  "render-coarse": "#6cf",
  "render-waiting": "#fb4",
};

const MODE_LABEL: Record<string, string> = {
  "well-as-proxy": "WP",
  "fields-with-proxy-fallback": "FP",
  "fields-with-detail": "FD",
};

interface WellBadge {
  key: string;
  centerX: number;
  centerY: number;
  mode: string;
  label: string;
  title: string;
}

type OverlayTier = "detail" | "coarse";

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

export interface WellTierCoverage {
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

const SOLID_CACHED = "rgba(80, 220, 120, 0.30)";
const SOLID_IN_FLIGHT = "rgba(240, 200, 70, 0.35)";
const SOLID_PLANNED = "rgba(240, 90, 90, 0.30)";

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

function emptyWellTierCoverage(): WellTierCoverage {
  return {
    detail: emptyTierCoverageCounts(),
    coarse: emptyTierCoverageCounts(),
  };
}

function overlayTierForRequest(req: ChunkRequest): OverlayTier | null {
  if (req.lane === "detail") return "detail";
  if (req.lane === "coarse" || req.lane === "overview") return "coarse";
  return null;
}

export function buildWellTierCoverage(
  plan: Pick<RequestPlan, "requests">,
  parentByEntity: ReadonlyMap<string, string | null>,
  cpuCache: Pick<CpuCache, "deliveryState"> | null,
  cacheSnap: CacheStateSnapshot | null,
): Map<string, WellTierCoverage> {
  const out = new Map<string, WellTierCoverage>();
  for (const req of plan.requests) {
    const tier = overlayTierForRequest(req);
    if (!tier) continue;

    const wellId = parentByEntity.get(req.entityId) ?? req.entityId;
    let coverage = out.get(wellId);
    if (!coverage) {
      coverage = emptyWellTierCoverage();
      out.set(wellId, coverage);
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
    if (ready || cpuCache?.deliveryState.wasChunkSent(req.imageId, req.c, req.chunkKey)) {
      counts.shown++;
    }
  }
  return out;
}

export function formatTierCoverageLabel(
  coverage: WellTierCoverage,
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

export function tierCoverageMode(
  coverage: WellTierCoverage,
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

export function formatTierCoverageTitle(
  coverage: WellTierCoverage,
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

/**
 * Per-field projection frame. `model === null` means 2D (slice mode):
 * voxel + position is world. `model !== null` means 3D: voxel /
 * fullVoxel goes through the model matrix to get world.
 */
interface FieldFrame {
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

/** Convert field-local voxel coords to world coords for the active mode. */
function voxelToWorld(
  frame: FieldFrame,
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

/** Field's world-space centroid (the (0.5, 0.5, 0.5) point of its unit cube). */
function fieldWorldCenter(frame: FieldFrame): [number, number, number] {
  return voxelToWorld(
    frame,
    frame.fullVoxel[0] / 2,
    frame.fullVoxel[1] / 2,
    frame.fullVoxel[2] / 2,
  );
}

/**
 * Project a field-local voxel-space AABB to a screen-space AABB by
 * projecting all 8 corners and reducing.
 */
function projectVoxelAabb(
  ws: WasmScene,
  frame: FieldFrame,
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

  const anyEnabled = DEBUG_OVERLAYS.some(o => enabled[o]);

  const [badges, setBadges] = useState<WellBadge[]>([]);
  const [chunks, setChunks] = useState<ChunkRect[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    if (!anyEnabled) {
      // Reset to empty when overlays are toggled off — no external state
      // to subscribe to, the toggle IS the state change we react to.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBadges([]);
      setChunks([]);
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

      const coord = renderLoopRef.current?.getTickCoordinator();
      const plans = coord?.getLastPlans();

      // Off-screen culling margin (CSS px).
      const xMin = -64;
      const yMin = -32;
      const xMax = canvasWCss + 64;
      const yMax = canvasHCss + 32;

      // Per-tick model-matrix cache; one WASM call per (dsId, imageId)
      // even when many overlays / wells reference the same field.
      const modelCache = new Map<string, Float32Array | null>();
      const getFrame = (dsId: string, imageId: string, lvl0Shape: number[]): FieldFrame => {
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

      // Well badges
      if (enabled.wellModes && plans) {
        const out: WellBadge[] = [];
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
          const coverageByWell = buildWellTierCoverage(
            plan,
            parentByEntity,
            cpuCache,
            cacheSnap,
          );

          // Per-well aggregator carrying world centroids of fields.
          const wells = new Map<string, {
            mode: string;
            lod: number | null;
            coverage: WellTierCoverage;
            worldCentroids: Array<[number, number, number]>;
          }>();

          const addField = (
            wellId: string,
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
            const worldCenter = fieldWorldCenter(frame);
            let agg = wells.get(wellId);
            if (!agg) {
              agg = {
                mode,
                lod,
                coverage: coverageByWell.get(wellId) ?? emptyWellTierCoverage(),
                worldCentroids: [],
              };
              wells.set(wellId, agg);
            }
            agg.worldCentroids.push(worldCenter);
          };

          for (const entry of plan.activeSet) {
            if (entry.kind === "well-as-proxy") {
              for (const ent of ds.manifest.entities) {
                if (ent.parent === entry.entityId && ent.kind === "Field") {
                  const img = ds.manifest.images.find(i => i.image_id === ent.id)
                    ?? ds.manifest.images[0];
                  // well-as-proxy entries have no LOD bookkeeping —
                  // surface `null` so the badge skips the LOD label.
                  if (img) addField(entry.entityId, ent.id, img.image_id, "well-as-proxy", null);
                }
              }
            } else if (entry.kind === "field") {
              const wellId = parentByEntity.get(entry.entityId) ?? entry.entityId;
              addField(wellId, entry.entityId, entry.imageId, entry.mode, entry.targetLod);
            }
            // entry.kind === "invisible" — skipped (not rendered as a
            // well badge; invisibles never had a promotion mode).
          }

          for (const [wellId, agg] of wells) {
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
              key: `${dsId}/${wellId}`,
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

      // Chunk grid for every visible field-mode entry.
      // (well-as-proxy entries don't iterate chunks — they're served by
      // a single proxy asset.)
      if (enabled.chunkGrid && plans && cpuCache) {
        const out: ChunkRect[] = [];
        const t = ws.t();
        const c = ws.c();
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
        // Same idea for proxies, used by the WP-well rendering path.
        const pendingProxies = cpuCache.getPendingProxySnapshot();
        const proxyRankByKey = new Map<string, number>();
        for (let i = 0; i < pendingProxies.length; i++) {
          const r = pendingProxies[i];
          proxyRankByKey.set(`${r.datasetId}|${r.entityId}|${r.kind}|${r.t}|${r.c}`, i);
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

          // Per-dataset visible region — drives clipping for every
          // field. visible_region is in dataset (plate) voxel coords;
          // we subtract each field's pos to get field-local bounds.
          let vrJson: string | null = null;
          try {
            vrJson = ws.visible_region(dsId);
          } catch {
            vrJson = null;
          }
          let xyBounds: [number, number, number, number] | null = null;
          let zRange: [number, number] | null = null;
          if (vrJson && vrJson !== "null") {
            try {
              const vr = JSON.parse(vrJson);
              xyBounds = vr.xy_bounds;
              zRange = vr.z_range;
            } catch {
              xyBounds = null;
              zRange = null;
            }
          }

          for (const entry of plan.activeSet) {
            if (out.length >= MAX_CHUNK_RECTS) break outer;

            // Invisible entries don't contribute chunks or proxies —
            // skip them entirely. They live in their own variant;
            // reading mode/imageId/targetLod here would otherwise be
            // a type error.
            if (entry.kind === "invisible") continue;

            // Well-as-proxy: there's no chunk grid because the well is
            // served by a single proxy asset. Render one rect per well
            // colored by proxy status, so plates at WP zoom still
            // surface load progress.
            if (entry.kind === "well-as-proxy") {
              const cached = cpuCache.getCachedProxy(dsId, entry.entityId, "WellProxy3D", t, c);
              const inFlight = cpuCache.isProxyInFlight(dsId, entry.entityId, "WellProxy3D", t, c);
              let status: ChunkRect["status"] = "planned";
              let priorityRank: number | undefined;
              if (cached) {
                status = "cached";
              } else if (inFlight) {
                status = "in-flight";
              } else if (enabled.plannedRank) {
                priorityRank = proxyRankByKey.get(`${dsId}|${entry.entityId}|WellProxy3D|${t}|${c}`);
              }

              // Union of constituent fields' world AABBs gives the
              // well's world AABB in either mode (in 3D each field has
              // its own model matrix, so we union after voxelToWorld).
              let minX = Infinity, minY = Infinity, minZ = Infinity;
              let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
              let any = false;
              for (const ent of ds.manifest.entities) {
                if (ent.parent !== entry.entityId || ent.kind !== "Field") continue;
                const fieldImg = ds.manifest.images.find(i => i.image_id === ent.id)
                  ?? ds.manifest.images[0];
                if (!fieldImg) continue;
                const fpos = positions[ent.id];
                if (!fpos) continue;
                const flvl0 = fieldImg.multiscale.levels[0];
                if (!flvl0) continue;
                const fframe = getFrame(dsId, ent.id, flvl0.shape);
                fframe.pos = fpos;
                for (let i = 0; i < 8; i++) {
                  const vx = i & 1 ? fframe.fullVoxel[0] : 0;
                  const vy = (i >> 1) & 1 ? fframe.fullVoxel[1] : 0;
                  const vz = (i >> 2) & 1 ? fframe.fullVoxel[2] : 0;
                  const [wx, wy, wz] = voxelToWorld(fframe, vx, vy, vz);
                  if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
                  if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
                  if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
                  any = true;
                }
              }
              if (!any) continue;
              let sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
              let projected = false;
              for (let i = 0; i < 8; i++) {
                const wx = i & 1 ? maxX : minX;
                const wy = (i >> 1) & 1 ? maxY : minY;
                const wz = (i >> 2) & 1 ? maxZ : minZ;
                const p = projectWorld(ws, wx, wy, wz, dpr);
                if (!p) continue;
                projected = true;
                if (p.x < sxMin) sxMin = p.x;
                if (p.y < syMin) syMin = p.y;
                if (p.x > sxMax) sxMax = p.x;
                if (p.y > syMax) syMax = p.y;
              }
              if (!projected) continue;
              if (sxMax < xMin || syMax < yMin || sxMin > xMax || syMin > yMax) continue;
              out.push({
                key: `${dsId}/${entry.entityId}/well-proxy`,
                x: sxMin,
                y: syMin,
                w: sxMax - sxMin,
                h: syMax - syMin,
                status,
                priorityRank,
              });
              continue;
            }
            const pos = positions[entry.entityId];
            const img = imgById.get(entry.imageId);
            if (!pos || !img) continue;
            const lvl0 = img.multiscale.levels[0];
            const lvl = img.multiscale.levels[entry.targetLod];
            if (!lvl0 || !lvl) continue;

            const frame = getFrame(dsId, entry.imageId, lvl0.shape);
            frame.pos = pos;

            const fullX = lvl0.shape[Axis.X];
            const fullY = lvl0.shape[Axis.Y];
            const fullZ = lvl0.shape[Axis.Z];
            const lvlX = lvl.shape[Axis.X];
            const lvlY = lvl.shape[Axis.Y];
            const lvlZ = lvl.shape[Axis.Z];
            const chunkPxX = lvl.chunk_shape[Axis.X];
            const chunkPxY = lvl.chunk_shape[Axis.Y];
            const chunkPxZ = lvl.chunk_shape[Axis.Z];
            const scaleX = fullX / lvlX;
            const scaleY = fullY / lvlY;
            const scaleZ = fullZ / lvlZ;
            const chunkWorldX = chunkPxX * scaleX;
            const chunkWorldY = chunkPxY * scaleY;
            const chunkWorldZ = chunkPxZ * scaleZ;
            const maxCol = Math.ceil(lvlX / chunkPxX);
            const maxRow = Math.ceil(lvlY / chunkPxY);
            const maxZ = Math.ceil(lvlZ / chunkPxZ);

            // Default: this field's full extent.
            const fieldXyBounds: [number, number, number, number] =
              xyBounds ?? [pos[0], pos[1], pos[0] + fullX, pos[1] + fullY];
            const fieldZRange: [number, number] = zRange ?? [0, fullZ];

            const localMinX = fieldXyBounds[0] - pos[0];
            const localMaxX = fieldXyBounds[2] - pos[0];
            const localMinY = fieldXyBounds[1] - pos[1];
            const localMaxY = fieldXyBounds[3] - pos[1];
            if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) continue;

            const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
            const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
            const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
            const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));
            const zStart = Math.max(0, Math.floor(fieldZRange[0] / chunkWorldZ));
            const zEnd = Math.min(maxZ, Math.max(0, Math.ceil(fieldZRange[1] / chunkWorldZ)));

            const cachedSet = snap.cached.get(entry.entityId);
            const inFlightSet = snap.inFlight.get(entry.entityId);

            for (let iz = zStart; iz < zEnd; iz++) {
              if (out.length >= MAX_CHUNK_RECTS) break;
              for (let row = rowStart; row < rowEnd; row++) {
                if (out.length >= MAX_CHUNK_RECTS) break;
                for (let col = colStart; col < colEnd; col++) {
                  if (out.length >= MAX_CHUNK_RECTS) break;
                  const key = `${entry.targetLod}/${t}/${c}/${iz}/${row}/${col}`;
                  const vMin: [number, number, number] = [
                    col * chunkWorldX,
                    row * chunkWorldY,
                    iz * chunkWorldZ,
                  ];
                  const vMax: [number, number, number] = [
                    (col + 1) * chunkWorldX,
                    (row + 1) * chunkWorldY,
                    (iz + 1) * chunkWorldZ,
                  ];
                  const rect = projectVoxelAabb(ws, frame, vMin, vMax, dpr);
                  if (!rect) continue;
                  if (rect.x + rect.w < xMin || rect.y + rect.h < yMin || rect.x > xMax || rect.y > yMax) {
                    continue;
                  }
                  let status: ChunkRect["status"] = "planned";
                  let priorityRank: number | undefined;
                  let tier: import("../pipeline/fetch/index.ts").EvictionTier | null | undefined;
                  if (cachedSet?.has(key)) {
                    status = "cached";
                    if (enabled.cachedTier) {
                      tier = cpuCache.getCachedChunkTier(entry.entityId, key);
                    }
                  } else if (inFlightSet?.has(key)) {
                    status = "in-flight";
                  } else if (enabled.plannedRank) {
                    priorityRank = rankByKey.get(`${entry.entityId}/${key}`);
                  }
                  out.push({
                    key: `${dsId}/${entry.entityId}/${key}`,
                    x: rect.x,
                    y: rect.y,
                    w: rect.w,
                    h: rect.h,
                    status,
                    priorityRank,
                    tier,
                  });
                }
              }
            }
          }
        }
        setChunks(out);
      } else if (chunks.length > 0) {
        setChunks([]);
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, viewMode, datasets, cpuCache, wasmSceneRef, canvasRef, renderLoopRef]);

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
        const bg =
          c.status === "cached"
            ? enabled.cachedTier ? cachedColor(c.tier) : SOLID_CACHED
            : c.status === "in-flight"
              ? SOLID_IN_FLIGHT
              : enabled.plannedRank ? plannedColor(c.priorityRank) : SOLID_PLANNED;
        const tooltip = c.status === "cached"
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
      {enabled.wellModes && badges.map(b => (
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
