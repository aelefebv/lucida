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
 * Slice mode only for v1. Volume projection is more involved; if you
 * need it, add a parallel `volumeWorldToScreen` and gate the overlay
 * bodies on viewMode.
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

/** Mode → color (matches the Planning tab so the visual language is consistent). */
const MODE_COLOR: Record<string, string> = {
  "well-as-proxy": "#88f",
  "fields-with-proxy-fallback": "#fb4",
  "fields-with-detail": "#4f4",
};

/** Mode → short label. */
const MODE_LABEL: Record<string, string> = {
  "well-as-proxy": "WP",
  "fields-with-proxy-fallback": "FP",
  "fields-with-detail": "FD",
};

/**
 * Slice-mode 2-D ortho projection. Inverse of the pan formula in
 * SliceViewer:
 *
 *   worldX = (cursorX_phys - halfW_phys) / zoom + centerX
 *
 * Returns CSS-px coordinates relative to the canvas's top-left.
 */
function worldToScreenSlice(
  worldX: number,
  worldY: number,
  zoom: number,
  centerX: number,
  centerY: number,
  canvasWCss: number,
  canvasHCss: number,
  dpr: number,
): { x: number; y: number } {
  const halfWPhys = (canvasWCss * dpr) / 2;
  const halfHPhys = (canvasHCss * dpr) / 2;
  const xPhys = (worldX - centerX) * zoom + halfWPhys;
  const yPhys = (worldY - centerY) * zoom + halfHPhys;
  return { x: xPhys / dpr, y: yPhys / dpr };
}

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
  // CSS px AABB (clipped to canvas).
  x: number;
  y: number;
  w: number;
  h: number;
  status: "cached" | "in-flight" | "planned";
}

const STATUS_COLOR: Record<ChunkRect["status"], string> = {
  cached: "rgba(80, 220, 120, 0.35)",
  "in-flight": "rgba(240, 200, 70, 0.4)",
  planned: "rgba(240, 90, 90, 0.35)",
};

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
    if (!anyEnabled || viewMode !== "2d") {
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
      const zoom = ws.zoom();
      const centerArr = ws.center();
      const cx = centerArr[0];
      const cy = centerArr[1];

      const orch = renderLoopRef.current?.getOrchestrator();
      const plans = orch?.getLastPlans();

      // ---- Well badges ----
      if (enabled.wellModes && plans) {
        const out: WellBadge[] = [];
        for (const [dsId, plan] of plans) {
          const ds = datasets.get(dsId);
          if (!ds) continue;
          // Look up parents from manifest so we can group field entries
          // by well (planning's active set carries entityId + mode but
          // no parent reference).
          const parentByEntity = new Map<string, string | null>();
          for (const ent of ds.manifest.entities) {
            parentByEntity.set(ent.id, ent.parent ?? null);
          }
          // Position per entity (fields only; wells aren't in derived.members).
          let positions: Record<string, [number, number]> = {};
          try {
            positions = JSON.parse(ws.member_positions(dsId));
          } catch {
            positions = {};
          }

          // Per-well aggregator: {wellId, mode, lod, fieldPositions[]}.
          const wells = new Map<string, {
            mode: string;
            lod: number | null;
            fields: Array<{ pos: [number, number]; size: [number, number] }>;
          }>();

          // Build image lookup so we can fetch each field's level0 size.
          const imgById = new Map(ds.manifest.images.map(i => [i.image_id, i]));

          for (const entry of plan.activeSet) {
            // Find well id: well-as-proxy entry IS the well; field-mode
            // entry's well is its parentId.
            let wellId: string;
            if (entry.mode === "well-as-proxy") {
              wellId = entry.entityId;
            } else {
              const parent = parentByEntity.get(entry.entityId);
              if (!parent) {
                // Image-only entity: treat as its own "well" so single
                // datasets get a badge too.
                wellId = entry.entityId;
              } else {
                wellId = parent;
              }
            }

            let agg = wells.get(wellId);
            if (!agg) {
              agg = { mode: entry.mode, lod: entry.targetLod, fields: [] };
              wells.set(wellId, agg);
            }
            // For field entries, contribute the field's footprint.
            if (entry.mode !== "well-as-proxy") {
              const pos = positions[entry.entityId];
              const img = imgById.get(entry.imageId);
              const lvl0 = img?.multiscale.levels[0];
              if (pos && lvl0) {
                agg.fields.push({
                  pos,
                  size: [lvl0.shape[4], lvl0.shape[3]],
                });
              }
            } else {
              // For well-as-proxy: union of constituent field positions
              // (fields share the well as parent in the manifest).
              for (const ent of ds.manifest.entities) {
                if (ent.parent === wellId && ent.kind === "Field") {
                  // Find the field's image & position. Manifest entities
                  // carry images via the manifest images array; we look
                  // up by entity id.
                  const pos = positions[ent.id];
                  // The field's image_id matches the entity (typical
                  // plate convention); fall back to first image if not.
                  const img = ds.manifest.images.find(i => i.image_id === ent.id) ?? ds.manifest.images[0];
                  const lvl0 = img?.multiscale.levels[0];
                  if (pos && lvl0) {
                    agg.fields.push({
                      pos,
                      size: [lvl0.shape[4], lvl0.shape[3]],
                    });
                  }
                }
              }
            }
          }

          // Project each well.
          for (const [wellId, agg] of wells) {
            if (agg.fields.length === 0) continue;
            // Centroid in voxel space.
            let sumX = 0;
            let sumY = 0;
            for (const f of agg.fields) {
              sumX += f.pos[0] + f.size[0] / 2;
              sumY += f.pos[1] + f.size[1] / 2;
            }
            const wcx = sumX / agg.fields.length;
            const wcy = sumY / agg.fields.length;
            const screen = worldToScreenSlice(
              wcx, wcy, zoom, cx, cy, canvasWCss, canvasHCss, dpr,
            );
            // Cull off-screen (with a generous margin so badges hovering
            // at the edge still show).
            if (screen.x < -40 || screen.y < -20 || screen.x > canvasWCss + 40 || screen.y > canvasHCss + 20) {
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
          const ds = datasets.get(dsId);
          if (!ds) continue;
          // Pick the first focal-eligible entity in the active set:
          // visible field-mode entry whose centroid is closest to the
          // viewport center. Same logic as the orchestrator's focal
          // entity calc, but on the active-set instead of EntitySnapshot
          // (the overlay doesn't have view_query on hand).
          let positions: Record<string, [number, number]> = {};
          try {
            positions = JSON.parse(ws.member_positions(dsId));
          } catch {
            positions = {};
          }
          const imgById = new Map(ds.manifest.images.map(i => [i.image_id, i]));
          let focal: typeof plan.activeSet[number] | null = null;
          let focalDist = Infinity;
          for (const entry of plan.activeSet) {
            if (entry.mode === "well-as-proxy") continue;
            const pos = positions[entry.entityId];
            const img = imgById.get(entry.imageId);
            const lvl0 = img?.multiscale.levels[0];
            if (!pos || !lvl0) continue;
            const ecx = pos[0] + lvl0.shape[4] / 2;
            const ecy = pos[1] + lvl0.shape[3] / 2;
            const d = (ecx - cx) ** 2 + (ecy - cy) ** 2;
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
          const lvlX = lvl.shape[4];
          const lvlY = lvl.shape[3];
          const chunkPxX = lvl.chunk_shape[4];
          const chunkPxY = lvl.chunk_shape[3];
          const scaleX = fullX / lvlX;
          const scaleY = fullY / lvlY;
          const chunkWorldX = chunkPxX * scaleX;
          const chunkWorldY = chunkPxY * scaleY;
          const maxCol = Math.ceil(lvlX / chunkPxX);
          const maxRow = Math.ceil(lvlY / chunkPxY);

          // World-space bounds of the visible canvas — invert the
          // pan formula at the canvas corners.
          const halfWPhys = (canvasWCss * dpr) / 2;
          const halfHPhys = (canvasHCss * dpr) / 2;
          const wMinX = -halfWPhys / zoom + cx;
          const wMaxX = halfWPhys / zoom + cx;
          const wMinY = -halfHPhys / zoom + cy;
          const wMaxY = halfHPhys / zoom + cy;
          const localMinX = wMinX - pos[0];
          const localMaxX = wMaxX - pos[0];
          const localMinY = wMinY - pos[1];
          const localMaxY = wMaxY - pos[1];
          if (localMaxX <= 0 || localMaxY <= 0 || localMinX >= fullX || localMinY >= fullY) continue;

          const colStart = Math.max(0, Math.floor(localMinX / chunkWorldX));
          const colEnd = Math.min(maxCol, Math.max(0, Math.ceil(localMaxX / chunkWorldX)));
          const rowStart = Math.max(0, Math.floor(localMinY / chunkWorldY));
          const rowEnd = Math.min(maxRow, Math.max(0, Math.ceil(localMaxY / chunkWorldY)));

          // Cache snapshot keyed by entity id; slice (z) constrained to
          // current scene z. Only one z per slice mode.
          const snap = cpuCache.snapshot();
          const cachedSet = snap.cached.get(focal.entityId);
          const inFlightSet = snap.inFlight.get(focal.entityId);
          const t = ws.t();
          const c = ws.c();
          // z chunk index for the current slice.
          const lvlZ = lvl.shape[2];
          const chunkPxZ = lvl.chunk_shape[2];
          const fullZ = lvl0.shape[2];
          const scaleZ = fullZ / lvlZ;
          const z = ws.z();
          const iz = Math.floor(z / (chunkPxZ * scaleZ));

          for (let row = rowStart; row < rowEnd; row++) {
            for (let col = colStart; col < colEnd; col++) {
              const key = `${focal.targetLod}/${t}/${c}/${iz}/${row}/${col}`;
              const cellWorldMinX = pos[0] + col * chunkWorldX;
              const cellWorldMaxX = pos[0] + (col + 1) * chunkWorldX;
              const cellWorldMinY = pos[1] + row * chunkWorldY;
              const cellWorldMaxY = pos[1] + (row + 1) * chunkWorldY;
              const tl = worldToScreenSlice(cellWorldMinX, cellWorldMinY, zoom, cx, cy, canvasWCss, canvasHCss, dpr);
              const br = worldToScreenSlice(cellWorldMaxX, cellWorldMaxY, zoom, cx, cy, canvasWCss, canvasHCss, dpr);
              let status: ChunkRect["status"] = "planned";
              if (cachedSet?.has(key)) status = "cached";
              else if (inFlightSet?.has(key)) status = "in-flight";
              out.push({
                key: `${dsId}/${focal.entityId}/${key}`,
                x: tl.x,
                y: tl.y,
                w: br.x - tl.x,
                h: br.y - tl.y,
                status,
              });
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

  if (viewMode !== "2d" || !anyEnabled) return null;

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
            border: "1px solid rgba(255, 255, 255, 0.25)",
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
