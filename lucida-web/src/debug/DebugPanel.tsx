/**
 * Debug side panel — renders stats from debugStats as a tabbed panel
 * docked to the right of the canvas. Polls at ~200ms intervals for low overhead.
 *
 * When wasmSceneRef and datasetId are provided, also shows Scene Query
 * debug info: epochs, per-entity ViewQueryResult, and last ray pick.
 */
import { useEffect, useRef, useState } from "react";
import { debugStats, type DebugStats } from "./debugStats.ts";
import type { WasmScene } from "lucida-core";
import type { ContentGraph, ImageSpec } from "../contentTypes.ts";
import { plan } from "../pipeline/planning.ts";
import type {
  PlanningSnapshot,
  EntitySnapshot,
  VisibleRegion,
  SelectionState,
  ActiveSetEntry,
  RequestPlan,
  PlanningEpochs,
} from "../pipeline/planning.ts";
import "./DebugPanel.css";

const POLL_INTERVAL_MS = 200;

type TabId = "render" | "scene" | "pick" | "planning";

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

interface DebugPanelProps {
  wasmSceneRef?: React.RefObject<WasmScene | null>;
  datasetId?: string | null;
  lastClickScreen?: [number, number] | null;
  datasets: Map<string, { sharedQueue: any; content: ContentGraph }>;
  style?: React.CSSProperties;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

export function DebugPanel({ wasmSceneRef, datasetId, lastClickScreen, datasets, style }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("render");
  const [snap, setSnap] = useState<DebugStats>({ ...debugStats });

  const [sceneSnap, setSceneSnap] = useState<SceneQuerySnap>({
    epochs: null,
    viewQuery: null,
    lastRayPick: null,
  });
  const lastRayPickRef = useRef<SceneQuerySnap["lastRayPick"]>(null);

  // Planning tab state
  const prevActiveSetRef = useRef<ActiveSetEntry[]>([]);
  const prevRequestEpochRef = useRef(0);
  const [planResult, setPlanResult] = useState<RequestPlan | null>(null);
  const [planDebugInfo, setPlanDebugInfo] = useState<{
    visibleRegion: VisibleRegion | null;
    entityCount: number;
    entityPositions: [string, [number, number]][];
  } | null>(null);

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

          // Assemble PlanningSnapshot and run plan()
          if (viewQuery && datasets.size > 0) {
            try {
              // Epochs
              const sceneEpochs = epochs ?? { content: 0, layout: 0, view: 0, selection: 0 };
              const planningEpochs: PlanningEpochs = {
                ...sceneEpochs,
                asset: 0,
                request: prevRequestEpochRef.current,
              };

              // Find dataset content graph
              const dsEntry = datasets.get(datasetId);
              const content = dsEntry?.content;

              // Build position lookup from WASM member positions
              // (composed layout placement + transform edge offsets)
              const positionByEntity = new Map<string, [number, number]>();
              try {
                const posJson = ws.member_positions(datasetId);
                const positions: Record<string, [number, number]> = JSON.parse(posJson);
                for (const [entityId, pos] of Object.entries(positions)) {
                  positionByEntity.set(entityId, pos);
                }
              } catch {
                // fallback: no positions
              }

              // Build image spec lookup
              const imageSpecById = new Map<string, ImageSpec>();
              if (content) {
                for (const img of content.images) {
                  imageSpecById.set(img.image_id, img);
                }
              }

              // Map view query entities to EntitySnapshots
              const entities: EntitySnapshot[] = viewQuery.visible_entities.map(
                (e: NonNullable<SceneQuerySnap["viewQuery"]>["visible_entities"][number]) => {
                  const imgSpec = imageSpecById.get(e.image_id);
                  const numLevels = imgSpec ? imgSpec.multiscale.levels.length : 1;
                  const levels = imgSpec ? imgSpec.multiscale.levels : [];
                  const position = positionByEntity.get(e.entity_id) ?? [0, 0] as [number, number];

                  return {
                    entityId: e.entity_id,
                    imageId: e.image_id,
                    kind: e.kind as "Image" | "Well" | "Field",
                    visible: e.visible,
                    projectedDiagonalPx: e.projected_diagonal_px,
                    projectedAreaPx2: e.projected_area_px2,
                    centroidWorld: e.centroid_world,
                    idealTargetLod: e.ideal_target_lod,
                    importance: e.importance,
                    numLevels,
                    levels,
                    position,
                  } satisfies EntitySnapshot;
                },
              );

              // Visible region
              const vrJson = ws.visible_region(datasetId);
              const vr = vrJson && vrJson !== "null" ? JSON.parse(vrJson) : null;
              const visibleRegion: VisibleRegion = vr
                ? {
                    xyBounds: vr.xy_bounds,
                    zRange: vr.z_range,
                    effectiveZoom: vr.effective_zoom,
                    sortCenter: vr.sort_center,
                    frustumPlanes: vr.frustum_planes,
                  }
                : { xyBounds: [0, 0, 1024, 1024], zRange: [0, 1], effectiveZoom: 1, sortCenter: null, frustumPlanes: null };

              // Selection state
              const mode = ws.camera_mode();

              // Visible channels: parse dataset settings for channel visibility
              let visibleChannels: number[] = [ws.c()];
              try {
                const allSettingsJson = ws.all_dataset_settings();
                const allSettings = JSON.parse(allSettingsJson);
                const dsSettings = allSettings[datasetId];
                if (dsSettings?.channel_settings && dsSettings.channel_settings.length > 0) {
                  const channels: number[] = [];
                  for (let i = 0; i < dsSettings.channel_settings.length; i++) {
                    if (dsSettings.channel_settings[i].visible) channels.push(i);
                  }
                  if (channels.length > 0) visibleChannels = channels;
                }
              } catch {
                // fallback to [ws.c()]
              }

              const selection: SelectionState = {
                t: ws.t(),
                c: ws.c(),
                z: ws.z(),
                visibleChannels,
                renderMode: mode === "slice" ? "slice" : "volume",
                interactionState: "idle",
              };

              const snapshot: PlanningSnapshot = {
                epochs: planningEpochs,
                entities,
                visibleRegion,
                selection,
                cacheState: { cached: new Map() },
                workerWantedSet: { resident: new Map() },
                previousActiveSet: prevActiveSetRef.current,
                assetCatalog: null,
              };

              const result = plan(snapshot);
              setPlanResult(result);
              setPlanDebugInfo({
                visibleRegion,
                entityCount: entities.length,
                entityPositions: entities.map(e => [e.entityId, e.position]),
              });
              prevActiveSetRef.current = result.activeSet;
              prevRequestEpochRef.current = result.epochs.request;
            } catch {
              // Planning failed, keep previous result
            }
          }
        } catch {
          // WASM not ready or dataset removed
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [wasmSceneRef, datasetId, datasets]);

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

  const tabs: { id: TabId; label: string }[] = [
    { id: "render", label: "Render" },
    { id: "scene", label: "Scene" },
    { id: "pick", label: "Pick" },
    { id: "planning", label: "Planning" },
  ];

  return (
    <div className="debug-panel" style={style}>
      <div className="debug-tab-bar">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`debug-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="debug-tab-content">
        {activeTab === "render" && (
          <>
            <div className="debug-section">
              <div className="debug-title">Render</div>
              <div>Mode: {snap.mode || "\u2014"}</div>
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
          </>
        )}

        {activeTab === "scene" && (
          <>
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

            {!sceneSnap.epochs && !sceneSnap.viewQuery && (
              <div className="debug-section">
                <div style={{ color: "#666" }}>No scene data available</div>
              </div>
            )}
          </>
        )}

        {activeTab === "pick" && (
          <>
            {sceneSnap.lastRayPick ? (
              <div className="debug-section">
                <div className="debug-title">Ray Pick</div>
                <div>entity: {sceneSnap.lastRayPick.entity_id}</div>
                <div>
                  pos: [{sceneSnap.lastRayPick.world_position.map(v => fmt(v, 1)).join(", ")}]
                </div>
                <div>dist: {fmt(sceneSnap.lastRayPick.distance, 2)}</div>
              </div>
            ) : (
              <div className="debug-section">
                <div style={{ color: "#666" }}>Click viewport to pick</div>
              </div>
            )}
          </>
        )}

        {activeTab === "planning" && (
          <>
            {planResult ? (
              <>
                {/* Active Set */}
                {(() => {
                  const detail = planResult.activeSet.filter(e => e.representation === "detail");
                  const overview = planResult.activeSet.filter(e => e.representation === "overview");
                  return (
                    <div className="debug-section">
                      <div className="debug-title">
                        Active Set ({detail.length} detail / {overview.length} overview)
                      </div>
                      <div className="debug-member-list">
                        {planResult.activeSet.slice(0, 15).map((e) => (
                          <div key={e.entityId} className="debug-member-row">
                            <span className="debug-member-id" title={e.entityId}>
                              {e.entityId.length > 12 ? "..." + e.entityId.slice(-10) : e.entityId}
                            </span>
                            <span>{e.representation === "detail" ? "D" : "O"}</span>
                            <span>L{e.targetLod}</span>
                            <span>s{e.seedDetailLod}</span>
                            <span title={`range: ${e.detailOwnedLodRange[0]}-${e.detailOwnedLodRange[1]}`}>
                              {e.detailOwnedLodRange[0]}-{e.detailOwnedLodRange[1]}
                            </span>
                          </div>
                        ))}
                        {planResult.activeSet.length > 15 && (
                          <div className="debug-more">+{planResult.activeSet.length - 15} more</div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Requests by Lane */}
                {(() => {
                  const detail = planResult.requests.filter(r => r.lane === "detail").length;
                  const runway = planResult.requests.filter(r => r.lane === "runway").length;
                  const overview = planResult.requests.filter(r => r.lane === "overview").length;
                  return (
                    <div className="debug-section">
                      <div className="debug-title">Requests: {planResult.requests.length} total</div>
                      <div>detail: {detail}</div>
                      <div>runway: {runway}</div>
                      <div>overview: {overview}</div>
                    </div>
                  );
                })()}

                {/* Top Requests */}
                {planResult.requests.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">Top Requests</div>
                    <div className="debug-member-list">
                      {planResult.requests.slice(0, 10).map((r, i) => (
                        <div key={`${r.entityId}:${r.chunkKey}:${i}`} className="debug-member-row">
                          <span className="debug-member-id" title={r.chunkKey}>
                            {r.chunkKey}
                          </span>
                          <span>{r.lane === "detail" ? "D" : r.lane === "runway" ? "R" : "O"}</span>
                          <span>p{fmt(r.priority, 0)}</span>
                          <span className="debug-member-id" title={r.entityId}>
                            {r.entityId.length > 12 ? "..." + r.entityId.slice(-10) : r.entityId}
                          </span>
                        </div>
                      ))}
                      {planResult.requests.length > 10 && (
                        <div className="debug-more">+{planResult.requests.length - 10} more</div>
                      )}
                    </div>
                  </div>
                )}
                {/* VisibleRegion debug */}
                {planDebugInfo?.visibleRegion && (
                  <div className="debug-section">
                    <div className="debug-title">VisibleRegion</div>
                    <div>xy: [{planDebugInfo.visibleRegion.xyBounds.map(v => fmt(v, 0)).join(", ")}]</div>
                    <div>z: [{planDebugInfo.visibleRegion.zRange.join(", ")}]</div>
                    <div>zoom: {fmt(planDebugInfo.visibleRegion.effectiveZoom, 4)}</div>
                    <div>frustum: {planDebugInfo.visibleRegion.frustumPlanes ? `${planDebugInfo.visibleRegion.frustumPlanes.length} planes` : "null"}</div>
                    {planDebugInfo.visibleRegion.frustumPlanes && (
                      <div style={{ fontSize: 9, color: "#777" }}>
                        {planDebugInfo.visibleRegion.frustumPlanes.map((p, i) => (
                          <div key={i}>p{i}: [{p.map(v => v.toExponential(2)).join(", ")}]</div>
                        ))}
                      </div>
                    )}
                    <div>sort: {planDebugInfo.visibleRegion.sortCenter ? `[${planDebugInfo.visibleRegion.sortCenter.map(v => fmt(v, 0)).join(", ")}]` : "null"}</div>
                  </div>
                )}
              </>
            ) : (
              <div className="debug-section">
                <div style={{ color: "#666" }}>Waiting for data...</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
