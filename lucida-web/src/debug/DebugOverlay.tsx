/**
 * Debug HUD overlay — renders stats from debugStats as an HTML overlay
 * on top of the canvas. Polls at ~200ms intervals for low overhead.
 *
 * When wasmSceneRef and datasetId are provided, also shows Scene Query
 * debug info: epochs, per-entity ViewQueryResult, and last ray pick.
 */
import { useEffect, useRef, useState } from "react";
import { debugStats, type DebugStats } from "./debugStats.ts";
import type { WasmScene } from "lucida-core";
import "./DebugOverlay.css";

const POLL_INTERVAL_MS = 200;

interface SceneQuerySnap {
  epochs: { content: number; layout: number; view: number; selection: number } | null;
  viewQuery: {
    epochs: { content: number; layout: number; view: number; selection: number };
    visible_entities: Array<{
      entity_id: string;
      image_id: string;
      kind: string;
      visible: boolean;
      projected_diagonal_px: number;
      projected_area_px2: number;
      centroid_world: [number, number, number];
      ideal_target_lod: number;
      importance: number;
    }>;
  } | null;
  lastRayPick: {
    entity_id: string;
    image_id: string;
    world_position: [number, number, number];
    distance: number;
  } | null;
}

interface Props {
  wasmSceneRef?: React.RefObject<WasmScene | null>;
  datasetId?: string | null;
  lastClickScreen?: [number, number] | null;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

export function DebugOverlay({ wasmSceneRef, datasetId, lastClickScreen }: Props) {
  const [snap, setSnap] = useState<DebugStats>({ ...debugStats });

  const [sceneSnap, setSceneSnap] = useState<SceneQuerySnap>({
    epochs: null,
    viewQuery: null,
    lastRayPick: null,
  });
  const lastRayPickRef = useRef<SceneQuerySnap["lastRayPick"]>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setSnap({ ...debugStats, memberStats: [...debugStats.memberStats] });

      // Poll scene query data if available
      const ws = wasmSceneRef?.current;
      if (ws && datasetId) {
        try {
          const epochsJson = ws.epochs();
          const epochs = epochsJson ? JSON.parse(epochsJson) : null;
          const vqJson = ws.view_query(datasetId);
          const viewQuery = vqJson && vqJson !== "null" ? JSON.parse(vqJson) : null;
          setSceneSnap({ epochs, viewQuery, lastRayPick: lastRayPickRef.current });
        } catch {
          // WASM not ready or dataset removed
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [wasmSceneRef, datasetId]);

  // Ray pick on click
  useEffect(() => {
    if (!lastClickScreen || !wasmSceneRef?.current || !datasetId) return;
    const ws = wasmSceneRef.current;
    try {
      const hitJson = ws.ray_pick(datasetId, lastClickScreen[0], lastClickScreen[1]);
      const hit = hitJson && hitJson !== "null" ? JSON.parse(hitJson) : null;
      lastRayPickRef.current = hit;
      setSceneSnap(prev => ({ ...prev, lastRayPick: hit }));
    } catch {
      // ignore
    }
  }, [lastClickScreen, wasmSceneRef, datasetId]);

  const budgetPct = snap.uploadBudgetTotal > 0
    ? Math.round((snap.uploadBytesUsed / snap.uploadBudgetTotal) * 100)
    : 0;

  return (
    <div className="debug-overlay">
      <div className="debug-section">
        <div className="debug-title">Render</div>
        <div>Mode: {snap.mode || "—"}</div>
        <div>Frame: {fmt(snap.frameTimeMs, 1)}ms</div>
        <div>Plan: {fmt(snap.planTimeMs, 1)}ms</div>
        <div>Upload: {fmt(snap.uploadTimeMs, 1)}ms</div>
        <div>Passes: {snap.renderPassCount}</div>
      </div>

      <div className="debug-section">
        <div className="debug-title">LOD</div>
        <div>Level: {snap.selectedLevel} / {snap.numLevels - 1}</div>
        <div>eff_zoom: {fmt(snap.effectiveZoom, 2)}</div>
        <div>zoom/vox: {fmt(snap.zoomPerVoxel, 4)}</div>
      </div>

      <div className="debug-section">
        <div className="debug-title">Upload</div>
        <div>
          Budget: {fmtBytes(snap.uploadBytesUsed)} / {fmtBytes(snap.uploadBudgetTotal)}
          {" "}({budgetPct}%)
        </div>
        {snap.budgetExhausted && <div className="debug-warn">EXHAUSTED</div>}
      </div>

      <div className="debug-section">
        <div className="debug-title">Members</div>
        <div>Visible: {snap.visibleMembers} / {snap.totalMembers}</div>
        <div>Channels: {snap.activeChannels}</div>
        <div>Cache: {snap.planCacheHits}h / {snap.planCacheMisses}m</div>
      </div>

      {snap.memberStats.length > 0 && (() => {
        const active = snap.memberStats.filter(m => m.chunksNeeded > 0);
        if (active.length === 0) return null;
        return (
          <div className="debug-section">
            <div className="debug-title">Per-Member ({active.length} active)</div>
            <div className="debug-member-list">
              {active.slice(0, 12).map((m) => (
                <div key={m.id} className="debug-member-row">
                  <span className="debug-member-id" title={m.id}>
                    {m.id.length > 16 ? "..." + m.id.slice(-14) : m.id}
                  </span>
                  <span>L{m.level}/{m.numLevels - 1}</span>
                  <span>{m.chunksSent}/{m.chunksNeeded}</span>
                </div>
              ))}
              {active.length > 12 && (
                <div className="debug-more">+{active.length - 12} more</div>
              )}
            </div>
          </div>
        );
      })()}

      {sceneSnap.epochs && (
        <div className="debug-section">
          <div className="debug-title">Epochs</div>
          <div>content: {sceneSnap.epochs.content}  layout: {sceneSnap.epochs.layout}</div>
          <div>view: {sceneSnap.epochs.view}  selection: {sceneSnap.epochs.selection}</div>
        </div>
      )}

      {sceneSnap.viewQuery && (
        <div className="debug-section">
          <div className="debug-title">
            View Query ({sceneSnap.viewQuery.visible_entities.filter(e => e.visible).length} / {sceneSnap.viewQuery.visible_entities.length} visible)
          </div>
          <div className="debug-member-list">
            {sceneSnap.viewQuery.visible_entities.slice(0, 12).map((e) => (
              <div key={e.entity_id} className="debug-member-row">
                <span className="debug-member-id" title={e.entity_id}>
                  {e.entity_id.length > 12 ? "..." + e.entity_id.slice(-10) : e.entity_id}
                </span>
                <span>{e.visible ? "V" : "-"}</span>
                <span>L{e.ideal_target_lod}</span>
                <span>{fmt(e.projected_diagonal_px, 0)}px</span>
                <span title={`importance: ${fmt(e.importance, 1)}`}>
                  i{fmt(e.importance, 0)}
                </span>
              </div>
            ))}
            {sceneSnap.viewQuery.visible_entities.length > 12 && (
              <div className="debug-more">
                +{sceneSnap.viewQuery.visible_entities.length - 12} more
              </div>
            )}
          </div>
        </div>
      )}

      {sceneSnap.lastRayPick && (
        <div className="debug-section">
          <div className="debug-title">Ray Pick</div>
          <div>entity: {sceneSnap.lastRayPick.entity_id}</div>
          <div>
            pos: [{sceneSnap.lastRayPick.world_position.map(v => fmt(v, 1)).join(", ")}]
          </div>
          <div>dist: {fmt(sceneSnap.lastRayPick.distance, 2)}</div>
        </div>
      )}

    </div>
  );
}
