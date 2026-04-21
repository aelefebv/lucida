/**
 * Debug overlay layer. Sits absolutely-positioned above the canvas with
 * pointer-events: none, so it never steals interaction from the viewer.
 * Reads from existing scene + orchestrator + cache state — no new
 * production-side state added for it to work.
 *
 * Two overlays, each gated by its own toggle in the Logging tab:
 *  - wellModes: per-well badge with promotion mode + LOD
 *  - chunkGrid: LOD chunk grid for the focal entity, colored by status
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
import type { DatasetState } from "../types.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { CpuCache } from "../pipeline/cpuCache.ts";
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
  lod: number | null;
}

interface ChunkRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: "cached" | "in-flight" | "planned";
}

const STATUS_COLOR: Record<ChunkRect["status"], string> = {
  cached: "rgba(80, 220, 120, 0.30)",
  "in-flight": "rgba(240, 200, 70, 0.35)",
  planned: "rgba(240, 90, 90, 0.30)",
};

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
    const ux = vx / frame.fullVoxel[0];
    const uy = vy / frame.fullVoxel[1];
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
  const [enabled, setEnabled] = useState<Record<DebugOverlay, boolean>>(() => ({
    wellModes: isOverlayEnabled("wellModes"),
    chunkGrid: isOverlayEnabled("chunkGrid"),
  }));
  useEffect(() => {
    const sync = () => setEnabled({
      wellModes: isOverlayEnabled("wellModes"),
      chunkGrid: isOverlayEnabled("chunkGrid"),
    });
    return onOverlaysChanged(sync);
  }, []);

  const anyEnabled = DEBUG_OVERLAYS.some(o => enabled[o]);

  const [badges, setBadges] = useState<WellBadge[]>([]);
  const [chunks, setChunks] = useState<ChunkRect[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    if (!anyEnabled) {
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

      const orch = renderLoopRef.current?.getOrchestrator();
      const plans = orch?.getLastPlans();

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
          fullVoxel: [lvl0Shape[4], lvl0Shape[3], lvl0Shape[2]],
          model,
        };
      };

      // ---- Well badges ----
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

          // Per-well aggregator carrying world centroids of fields.
          const wells = new Map<string, {
            mode: string;
            lod: number | null;
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
              agg = { mode, lod, worldCentroids: [] };
              wells.set(wellId, agg);
            }
            agg.worldCentroids.push(worldCenter);
          };

          for (const entry of plan.activeSet) {
            if (entry.mode === "well-as-proxy") {
              for (const ent of ds.manifest.entities) {
                if (ent.parent === entry.entityId && ent.kind === "Field") {
                  const img = ds.manifest.images.find(i => i.image_id === ent.id)
                    ?? ds.manifest.images[0];
                  if (img) addField(entry.entityId, ent.id, img.image_id, entry.mode, entry.targetLod);
                }
              }
            } else {
              const wellId = parentByEntity.get(entry.entityId) ?? entry.entityId;
              addField(wellId, entry.entityId, entry.imageId, entry.mode, entry.targetLod);
            }
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
              mode: agg.mode,
              label: MODE_LABEL[agg.mode] ?? agg.mode,
              lod: agg.lod,
            });
          }
        }
        setBadges(out);
      } else if (badges.length > 0) {
        setBadges([]);
      }

      // ---- Chunk grid for focal entity ----
      if (enabled.chunkGrid && plans && cpuCache) {
        const out: ChunkRect[] = [];
        const cssCenter = { x: canvasWCss / 2, y: canvasHCss / 2 };
        for (const [dsId, plan] of plans) {
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

          // Focal entity = visible field-mode entry whose projected
          // world centroid is nearest the canvas center. Skip entities
          // that fail to project (behind camera in 3D).
          let focal: typeof plan.activeSet[number] | null = null;
          let focalDist = Infinity;
          let focalFrame: FieldFrame | null = null;
          for (const entry of plan.activeSet) {
            if (entry.mode === "well-as-proxy") continue;
            const pos = positions[entry.entityId];
            const img = imgById.get(entry.imageId);
            const lvl0 = img?.multiscale.levels[0];
            if (!pos || !lvl0) continue;
            const frame = getFrame(dsId, entry.imageId, lvl0.shape);
            frame.pos = pos;
            const wc = fieldWorldCenter(frame);
            const sp = projectWorld(ws, wc[0], wc[1], wc[2], dpr);
            if (!sp) continue;
            const d = (sp.x - cssCenter.x) ** 2 + (sp.y - cssCenter.y) ** 2;
            if (d < focalDist) {
              focalDist = d;
              focal = entry;
              focalFrame = frame;
            }
          }
          if (!focal || !focalFrame) continue;

          const img = imgById.get(focal.imageId);
          if (!img) continue;
          const lvl0 = img.multiscale.levels[0];
          const lvl = img.multiscale.levels[focal.targetLod];
          if (!lvl0 || !lvl) continue;

          const fullX = lvl0.shape[4];
          const fullY = lvl0.shape[3];
          const fullZ = lvl0.shape[2];
          const lvlX = lvl.shape[4];
          const lvlY = lvl.shape[3];
          const lvlZ = lvl.shape[2];
          const chunkPxX = lvl.chunk_shape[4];
          const chunkPxY = lvl.chunk_shape[3];
          const chunkPxZ = lvl.chunk_shape[2];
          const scaleX = fullX / lvlX;
          const scaleY = fullY / lvlY;
          const scaleZ = fullZ / lvlZ;
          const chunkWorldX = chunkPxX * scaleX;
          const chunkWorldY = chunkPxY * scaleY;
          const chunkWorldZ = chunkPxZ * scaleZ;
          const maxCol = Math.ceil(lvlX / chunkPxX);
          const maxRow = Math.ceil(lvlY / chunkPxY);
          const maxZ = Math.ceil(lvlZ / chunkPxZ);

          // Restrict iteration via the visible region from WASM. In 2D
          // this is voxel coords (matches focalFrame.pos); in 3D it's
          // voxel coords too — visible_region is derived in voxel space
          // for both modes, just with different culling logic upstream.
          let vrJson: string | null = null;
          try {
            vrJson = ws.visible_region(dsId);
          } catch {
            vrJson = null;
          }
          let xyBounds: [number, number, number, number] = [
            focalFrame.pos[0],
            focalFrame.pos[1],
            focalFrame.pos[0] + fullX,
            focalFrame.pos[1] + fullY,
          ];
          let zRange: [number, number] = [0, fullZ];
          if (vrJson && vrJson !== "null") {
            try {
              const vr = JSON.parse(vrJson);
              xyBounds = vr.xy_bounds;
              zRange = vr.z_range;
            } catch {
              // keep defaults
            }
          }
          const localMinX = xyBounds[0] - focalFrame.pos[0];
          const localMaxX = xyBounds[2] - focalFrame.pos[0];
          const localMinY = xyBounds[1] - focalFrame.pos[1];
          const localMaxY = xyBounds[3] - focalFrame.pos[1];
          if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) continue;

          const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
          const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
          const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
          const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));
          const zStart = Math.max(0, Math.floor(zRange[0] / chunkWorldZ));
          const zEnd = Math.min(maxZ, Math.max(0, Math.ceil(zRange[1] / chunkWorldZ)));

          const snap = cpuCache.snapshot();
          const cachedSet = snap.cached.get(focal.entityId);
          const inFlightSet = snap.inFlight.get(focal.entityId);
          const t = ws.t();
          const c = ws.c();

          for (let iz = zStart; iz < zEnd; iz++) {
            if (out.length >= MAX_CHUNK_RECTS) break;
            for (let row = rowStart; row < rowEnd; row++) {
              if (out.length >= MAX_CHUNK_RECTS) break;
              for (let col = colStart; col < colEnd; col++) {
                if (out.length >= MAX_CHUNK_RECTS) break;
                const key = `${focal.targetLod}/${t}/${c}/${iz}/${row}/${col}`;
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
                const rect = projectVoxelAabb(ws, focalFrame, vMin, vMax, dpr);
                if (!rect) continue;
                if (rect.x + rect.w < xMin || rect.y + rect.h < yMin || rect.x > xMax || rect.y > yMax) {
                  continue;
                }
                let status: ChunkRect["status"] = "planned";
                if (cachedSet?.has(key)) status = "cached";
                else if (inFlightSet?.has(key)) status = "in-flight";
                out.push({
                  key: `${dsId}/${focal.entityId}/${key}`,
                  x: rect.x,
                  y: rect.y,
                  w: rect.w,
                  h: rect.h,
                  status,
                });
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
      {enabled.chunkGrid && chunks.map(c => (
        <div
          key={c.key}
          style={{
            position: "absolute",
            left: c.x,
            top: c.y,
            width: c.w,
            height: c.h,
            background: STATUS_COLOR[c.status],
            border: "1px solid rgba(255, 255, 255, 0.22)",
            boxSizing: "border-box",
          }}
        />
      ))}
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
        >
          {b.label}{b.lod !== null && ` L${b.lod}`}
        </div>
      ))}
    </div>
  );
}
