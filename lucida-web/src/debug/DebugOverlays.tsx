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
 * Works in both slice and volume modes via the unified
 * `WasmScene.project_to_screen` (camera handles the mode-specific
 * projection internally).
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
/**
 * Hard cap on chunk-grid rectangles per tick. Volume mode can enumerate
 * thousands of cells from large LOD-0 entities; the overlay is meant for
 * a glance, not a complete inventory. Slice-mode plans tend to stay well
 * under this.
 */
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
  centerX: number; // CSS px
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
 * Project a world-space point to CSS-pixel screen coordinates via the
 * unified WASM camera projection. Returns null if the point is behind
 * the camera (3D modes only) — slice mode never returns null.
 */
function projectWorld(
  ws: WasmScene,
  x: number,
  y: number,
  z: number,
  dpr: number,
): { x: number; y: number } | null {
  const arr = ws.project_to_screen(x, y, z);
  if (arr.length === 0) return null;
  return { x: arr[0] / dpr, y: arr[1] / dpr };
}

/**
 * Project the 8 corners of a world-space AABB and reduce to a screen-
 * space AABB. Returns null when no corner survived projection.
 */
function projectAabb(
  ws: WasmScene,
  min: [number, number, number],
  max: [number, number, number],
  dpr: number,
): { x: number; y: number; w: number; h: number } | null {
  let sxMin = Infinity;
  let syMin = Infinity;
  let sxMax = -Infinity;
  let syMax = -Infinity;
  let any = false;
  for (let i = 0; i < 8; i++) {
    const cx = i & 1 ? max[0] : min[0];
    const cy = (i >> 1) & 1 ? max[1] : min[1];
    const cz = (i >> 2) & 1 ? max[2] : min[2];
    const p = projectWorld(ws, cx, cy, cz, dpr);
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
  // Mirror the localStorage flags into React state so toggles re-render us.
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

      const orch = renderLoopRef.current?.getOrchestrator();
      const plans = orch?.getLastPlans();

      // Off-screen culling margin (CSS px). Generous so a badge sitting
      // near a hidden corner still shows.
      const xMin = -64;
      const yMin = -32;
      const xMax = canvasWCss + 64;
      const yMax = canvasHCss + 32;

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

          // Per-well aggregator. `fields` carries each field's xy
          // position + (x, y, z) extent — needed to compute the well's
          // 3D centroid in the unified projection.
          const wells = new Map<string, {
            mode: string;
            lod: number | null;
            fields: Array<{ pos: [number, number]; size: [number, number, number] }>;
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
            let agg = wells.get(wellId);
            if (!agg) {
              agg = { mode, lod, fields: [] };
              wells.set(wellId, agg);
            }
            agg.fields.push({
              pos,
              size: [lvl0.shape[4], lvl0.shape[3], lvl0.shape[2]],
            });
          };

          for (const entry of plan.activeSet) {
            if (entry.mode === "well-as-proxy") {
              // Synthesize via constituent fields (well isn't in
              // derived.members so it has no position itself).
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
            if (agg.fields.length === 0) continue;
            let sumX = 0;
            let sumY = 0;
            let sumZ = 0;
            for (const f of agg.fields) {
              sumX += f.pos[0] + f.size[0] / 2;
              sumY += f.pos[1] + f.size[1] / 2;
              sumZ += f.size[2] / 2;
            }
            const wcx = sumX / agg.fields.length;
            const wcy = sumY / agg.fields.length;
            const wcz = sumZ / agg.fields.length;
            const screen = projectWorld(ws, wcx, wcy, wcz, dpr);
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

          // Focal entity = visible field-mode entry whose 3D centroid
          // projects nearest to the canvas center. Skip entities that
          // failed to project (behind camera in 3D).
          let focal: typeof plan.activeSet[number] | null = null;
          let focalDist = Infinity;
          const cssCenter = { x: canvasWCss / 2, y: canvasHCss / 2 };
          for (const entry of plan.activeSet) {
            if (entry.mode === "well-as-proxy") continue;
            const pos = positions[entry.entityId];
            const img = imgById.get(entry.imageId);
            const lvl0 = img?.multiscale.levels[0];
            if (!pos || !lvl0) continue;
            const ecx = pos[0] + lvl0.shape[4] / 2;
            const ecy = pos[1] + lvl0.shape[3] / 2;
            const ecz = lvl0.shape[2] / 2;
            const sp = projectWorld(ws, ecx, ecy, ecz, dpr);
            if (!sp) continue;
            const d = (sp.x - cssCenter.x) ** 2 + (sp.y - cssCenter.y) ** 2;
            if (d < focalDist) {
              focalDist = d;
              focal = entry;
            }
          }
          if (!focal) continue;

          const pos = positions[focal.entityId];
          const img = imgById.get(focal.imageId);
          if (!pos || !img) continue;
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

          // Restrict iteration to the visible region reported by WASM.
          // This is the same region the planner uses for cell
          // enumeration, so we won't miss visible cells but will skip
          // the rest of the grid (essential in 3D, where a single LOD
          // can have thousands of cells).
          let vrJson: string | null = null;
          try {
            vrJson = ws.visible_region(dsId);
          } catch {
            vrJson = null;
          }
          let xyBounds: [number, number, number, number] = [0, 0, fullX, fullY];
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
          const localMinX = xyBounds[0] - pos[0];
          const localMaxX = xyBounds[2] - pos[0];
          const localMinY = xyBounds[1] - pos[1];
          const localMaxY = xyBounds[3] - pos[1];
          if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) continue;

          const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
          const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
          const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
          const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));
          // In slice mode the visible z range is a single slice; in
          // volume the planner gives the full z extent.
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
                const minWorld: [number, number, number] = [
                  pos[0] + col * chunkWorldX,
                  pos[1] + row * chunkWorldY,
                  iz * chunkWorldZ,
                ];
                const maxWorld: [number, number, number] = [
                  pos[0] + (col + 1) * chunkWorldX,
                  pos[1] + (row + 1) * chunkWorldY,
                  (iz + 1) * chunkWorldZ,
                ];
                const rect = projectAabb(ws, minWorld, maxWorld, dpr);
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
    // We deliberately depend on `enabled` so flipping a toggle restarts
    // the interval (and clears stale state via the early-out above).
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
