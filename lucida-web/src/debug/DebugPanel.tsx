/**
 * Debug side panel — renders stats from debugStats as a tabbed panel
 * docked to the right of the canvas. Polls at ~200ms intervals for low overhead.
 *
 * When wasmSceneRef and datasetId are provided, also shows Scene Query
 * debug info: epochs, per-entity ViewQueryResult, and last ray pick.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RenderLoop } from "../renderLoop.ts";
import type { WasmScene } from "lucida-core";
import type { DatasetState } from "../types.ts";
import type { CacheTelemetry } from "../pipeline/fetch/index.ts";
import type { GeneratedStatusCountsByDataset } from "../pipeline/generatedAvailability.ts";
import type { Session } from "../session.ts";
import type { DatasetHealthStatus, DatasetSourceHealth } from "../bridge.ts";
import "./DebugPanel.css";

const POLL_INTERVAL_MS = 200;



type TabId = "render" | "scene" | "pick" | "cache" | "health" | "catalog";

interface CatalogSnap {
  assetEpoch: number;
  perDataset: Array<{
    datasetId: string;
    name: string;
    groupsWithProxy: number;
    tilesWithProxy: number;
    totalEntries: number;
    sampleEntries: Array<{ entityId: string; kinds: string[] }>;
  }>;
  proxyBytes: number;
  proxyBudget: number;
  inFlightProxyCount: number;
  pendingProxyCount: number;
}

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
  datasets: Map<string, DatasetState>;
  sessionRef?: React.RefObject<Session | null>;
  renderLoopRef?: React.RefObject<RenderLoop | null>;
  style?: React.CSSProperties;
}

type RenderLoopSnap = ReturnType<RenderLoop["getDebugSnapshot"]>;

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function statusColor(status: DatasetHealthStatus | string | null | undefined): string {
  switch (status) {
    case "healthy":
      return "#4f4";
    case "degraded":
      return "#fb4";
    case "unavailable":
      return "#f66";
    default:
      return "#888";
  }
}

/** Truncate a long id to "...lastN" form, leaving short ids untouched. */
function shortId(id: string, max = 16): string {
  if (id.length <= max) return id;
  return "..." + id.slice(-(max - 3));
}

/** Dump CPU cache contents to the console, grouped by entity → cache → tier. */
function dumpCache(cache: import("../pipeline/fetch/index.ts").CpuCache | undefined | null): void {
  if (!cache) {
    console.warn("[DebugPanel] cpuCache not available");
    return;
  }
  const entries = cache.getCacheDump();
  const proxies = cache.getProxyCacheDump();
  console.group(`[DebugPanel] cpuCache contents (${entries.length} chunks, ${proxies.length} proxies)`);
  // Group chunks by entity, then dump as a single table per entity for
  // easy scanning. console.table at the entity level keeps output dense.
  const byEntity = new Map<string, typeof entries>();
  for (const e of entries) {
    let arr = byEntity.get(e.entityId);
    if (!arr) { arr = []; byEntity.set(e.entityId, arr); }
    arr.push(e);
  }
  for (const [entityId, arr] of byEntity) {
    arr.sort((a, b) => a.level - b.level || a.chunkKey.localeCompare(b.chunkKey));
    console.groupCollapsed(`${entityId}: ${arr.length} chunks`);
    console.table(arr.map(e => ({
      chunkKey: e.chunkKey,
      cache: e.cache,
      level: e.level,
      tier: e.tier,
      bytes: e.bytes,
    })));
    console.groupEnd();
  }
  if (proxies.length > 0) {
    console.groupCollapsed(`proxies: ${proxies.length}`);
    console.table(proxies);
    console.groupEnd();
  }
  console.groupEnd();
}

/** Dump pending CPU-cache requests to the console, sorted by priority. */
function dumpPending(cache: import("../pipeline/fetch/index.ts").CpuCache | undefined | null): void {
  if (!cache) {
    console.warn("[DebugPanel] cpuCache not available");
    return;
  }
  const pending = cache.getPendingDump();
  const admitted = pending.filter(p => p.admitted).length;
  console.group(
    `[DebugPanel] pending cpuCache queue (${pending.length} entries, ` +
      `${admitted} admitted / ${pending.length - admitted} backlog)`,
  );
  console.table(pending.map(p => ({
    chunkKey: p.chunkKey,
    entityId: p.entityId,
    lane: p.lane,
    priority: p.priority,
    // Backlog entries carry no admission stamp (ADR 0044); they have
    // waited at least as long as the oldest admitted entry.
    ageMs: p.ageMs === null ? "backlog" : Math.round(p.ageMs),
  })));
  console.groupEnd();
}



export function DebugPanel({ wasmSceneRef, datasetId, lastClickScreen, datasets, sessionRef, renderLoopRef, style }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("render");
  const [sceneSnap, setSceneSnap] = useState<SceneQuerySnap>({
    epochs: null,
    viewQuery: null,
    lastRayPick: null,
  });
  const lastRayPickRef = useRef<SceneQuerySnap["lastRayPick"]>(null);

  // Cache tab state
  const [cacheTelemetry, setCacheTelemetry] = useState<CacheTelemetry | null>(null);
  const [generatedStatusSnap, setGeneratedStatusSnap] = useState<GeneratedStatusCountsByDataset[]>([]);

  // Catalog tab state
  const [catalogSnap, setCatalogSnap] = useState<CatalogSnap | null>(null);

  // Server-authored dataset health tab state
  const [datasetHealthSnap, setDatasetHealthSnap] = useState<DatasetSourceHealth[]>([]);
  const [datasetHealthLoading, setDatasetHealthLoading] = useState(false);
  const [datasetHealthError, setDatasetHealthError] = useState<string | null>(null);
  const [datasetHealthUpdatedAt, setDatasetHealthUpdatedAt] = useState<number | null>(null);
  const datasetHealthRequestSeqRef = useRef(0);

  // Render loop snapshot (FPS, dirty flags, throttle, sticky max times)
  const [loopSnap, setLoopSnap] = useState<RenderLoopSnap | null>(null);

  const refreshDatasetHealth = useCallback(() => {
    const bridge = sessionRef?.current?.bridge ?? null;
    const seq = ++datasetHealthRequestSeqRef.current;
    if (!bridge) {
      setDatasetHealthError("WebSocket session not ready");
      setDatasetHealthLoading(false);
      return;
    }
    setDatasetHealthLoading(true);
    setDatasetHealthError(null);
    bridge.requestDatasetHealth(null)
      .then((rows) => {
        if (seq !== datasetHealthRequestSeqRef.current) return;
        setDatasetHealthSnap(rows);
        setDatasetHealthUpdatedAt(Date.now());
      })
      .catch((e) => {
        if (seq !== datasetHealthRequestSeqRef.current) return;
        setDatasetHealthError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (seq !== datasetHealthRequestSeqRef.current) return;
        setDatasetHealthLoading(false);
      });
  }, [sessionRef]);

  useEffect(() => {
    const id = setInterval(() => {
      // Poll render loop snapshot (FPS, dirty flags, throttle state, max times)
      const loop = renderLoopRef?.current ?? null;
      setLoopSnap(loop ? loop.getDebugSnapshot() : null);

      // Poll cache telemetry
      const cache = sessionRef?.current?.cpuCache ?? null;
      if (cache) setCacheTelemetry(cache.telemetry());
      setGeneratedStatusSnap(
        sessionRef?.current?.generatedAvailability.statusCountsByDataset() ?? [],
      );

      // Poll asset catalog (per-dataset proxy availability + cache stats)
      {
        const ws = wasmSceneRef?.current;
        if (ws) {
          try {
            const tel = cache?.telemetry();
            const perDataset: CatalogSnap["perDataset"] = [];
            for (const [dsId, dsEntry] of datasets.entries()) {
              try {
                const json = ws.get_asset_catalog(dsId);
                const cat = json ? JSON.parse(json) : { entries: [] };
                const entries: Array<{ entity_id: string; kinds: string[] }> =
                  Array.isArray(cat.entries) ? cat.entries : [];
                let groups = 0;
                let tiles = 0;
                for (const e of entries) {
                  if (e.kinds?.includes("GroupProxy3D")) groups++;
                  if (e.kinds?.includes("TileProxy3D")) tiles++;
                }
                perDataset.push({
                  datasetId: dsId,
                  name: dsEntry.manifest?.name ?? dsId,
                  groupsWithProxy: groups,
                  tilesWithProxy: tiles,
                  totalEntries: entries.length,
                  sampleEntries: entries.slice(0, 5).map(e => ({
                    entityId: e.entity_id,
                    kinds: e.kinds ?? [],
                  })),
                });
              } catch {
                // dataset not yet registered in scene state
              }
            }
            setCatalogSnap({
              assetEpoch: typeof ws.asset_epoch === "function" ? Number(ws.asset_epoch()) : 0,
              perDataset,
              proxyBytes: tel?.proxyBytes ?? 0,
              proxyBudget: tel?.proxyBudget ?? 0,
              inFlightProxyCount: tel?.inFlightProxyCount ?? 0,
              pendingProxyCount: tel?.pendingProxyCount ?? 0,
            });
          } catch {
            // ignore
          }
        }
      }

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
  }, [wasmSceneRef, datasetId, datasets, sessionRef, renderLoopRef]);

  useEffect(() => {
    if (activeTab !== "health") return;
    refreshDatasetHealth();
    const id = setInterval(refreshDatasetHealth, 5000);
    return () => clearInterval(id);
  }, [activeTab, refreshDatasetHealth, datasets.size]);

  useEffect(() => {
    return () => {
      datasetHealthRequestSeqRef.current += 1;
    };
  }, []);

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

  const tabs: { id: TabId; label: string }[] = [
    { id: "render", label: "Render" },
    { id: "scene", label: "Scene" },
    { id: "pick", label: "Pick" },
    { id: "cache", label: "Cache" },
    { id: "health", label: "Health" },
    { id: "catalog", label: "Catalog" },
  ];


  const datasetHealthCounts = datasetHealthSnap.reduce(
    (acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    },
    { healthy: 0, degraded: 0, unavailable: 0 } as Record<DatasetHealthStatus, number>,
  );

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
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span>Dirty:</span>
                {(() => {
                  // Three-state indicator: bright when currently set, dim
                  // afterglow within 500ms of being set, gray otherwise.
                  // Afterglow lets the panel surface fast set→clear flips
                  // (e.g. an interactive flip that resolves within one RAF)
                  // that would otherwise be invisible at 200ms polling.
                  const AFTERGLOW_MS = 500;
                  const interactiveRecent = loopSnap?.msSinceInteractiveDirty !== null
                    && loopSnap?.msSinceInteractiveDirty !== undefined
                    && loopSnap.msSinceInteractiveDirty < AFTERGLOW_MS;
                  const residencyRecent = loopSnap?.msSinceResidencyDirty !== null
                    && loopSnap?.msSinceResidencyDirty !== undefined
                    && loopSnap.msSinceResidencyDirty < AFTERGLOW_MS;
                  const interactiveColor = loopSnap?.interactiveDirty
                    ? "#4f4"
                    : interactiveRecent ? "#283" : "#444";
                  const residencyColor = loopSnap?.residencyDirty
                    ? "#fb4"
                    : residencyRecent ? "#963" : "#444";
                  return (
                    <>
                      <span style={{ color: interactiveColor }}>
                        {loopSnap?.interactiveDirty ? "● " : interactiveRecent ? "◐ " : "○ "}interactive
                      </span>
                      <span style={{ color: residencyColor }}>
                        {loopSnap?.residencyDirty ? "● " : residencyRecent ? "◐ " : "○ "}residency
                      </span>
                    </>
                  );
                })()}
              </div>
              {loopSnap && loopSnap.residencyDirty && loopSnap.throttleSkipsPending > 0 && (
                <div style={{ color: "#fb4" }}>
                  Throttled: {loopSnap.throttleSkipsPending} skip{loopSnap.throttleSkipsPending === 1 ? "" : "s"} pending
                </div>
              )}
            </div>

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

        {activeTab === "cache" && (
          <>
            {cacheTelemetry ? (
              <>
                {/* Budget */}
                <div className="debug-section">
                  <div className="debug-title">Budget</div>
                  {(() => {
                    const mainPct = cacheTelemetry.mainBudget > 0
                      ? Math.min(100, Math.round((cacheTelemetry.mainBytes / cacheTelemetry.mainBudget) * 100))
                      : 0;
                    const overviewPct = cacheTelemetry.overviewBudget > 0
                      ? Math.min(100, Math.round((cacheTelemetry.overviewBytes / cacheTelemetry.overviewBudget) * 100))
                      : 0;
                    return (
                      <>
                        <div>Main: {fmtBytes(cacheTelemetry.mainBytes)} / {fmtBytes(cacheTelemetry.mainBudget)} ({mainPct}%)</div>
                        <div className="debug-bar-track">
                          <div className="debug-bar-fill" style={{ width: `${mainPct}%`, background: "#4f4" }} />
                        </div>
                        <div>Overview: {fmtBytes(cacheTelemetry.overviewBytes)} / {fmtBytes(cacheTelemetry.overviewBudget)} ({overviewPct}%)</div>
                        <div className="debug-bar-track">
                          <div className="debug-bar-fill" style={{ width: `${overviewPct}%`, background: "#88f" }} />
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Dump buttons */}
                <div className="debug-section">
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => dumpCache(sessionRef?.current?.cpuCache)}>
                      Dump cache → console
                    </button>
                    <button onClick={() => dumpPending(sessionRef?.current?.cpuCache)}>
                      Dump pending → console
                    </button>
                  </div>
                </div>

                {/* Tier residency */}
                <div className="debug-section">
                  <div className="debug-title">Residency by tier</div>
                  <div className="debug-member-list">
                    {(["activeDetail", "demotedDetail", "prefetch", "overview", "proxy"] as const).map(t => {
                      const r = cacheTelemetry.tierResidency[t];
                      const evicted = cacheTelemetry.evictionsByTier[t];
                      return (
                        <div key={t} className="debug-member-row">
                          <span className="debug-member-id">{t}</span>
                          <span>{r.count}</span>
                          <span>{fmtBytes(r.bytes)}</span>
                          {evicted > 0 && (
                            <span style={{ color: "#fb4" }} title="evicted in last window">
                              -{evicted}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Fetch */}
                <div className="debug-section">
                  <div className="debug-title">Fetch</div>
                  <div>In-flight: {cacheTelemetry.inFlightCount} reqs, {fmtBytes(cacheTelemetry.inFlightBytes)}</div>
                  <div>
                    Queue: {cacheTelemetry.pendingCount}
                    {cacheTelemetry.pendingOldestAgeMs > 0 && (
                      <span style={{
                        color: cacheTelemetry.pendingOldestAgeMs > 5000 ? "#fb4" : "#888",
                        marginLeft: 6,
                      }}>
                        (oldest {fmt(cacheTelemetry.pendingOldestAgeMs / 1000, 1)}s)
                      </span>
                    )}
                  </div>
                  <div>
                    Deliverable: {cacheTelemetry.readyCount}
                    {cacheTelemetry.readyCount > 32 && (
                      <span style={{ color: "#fb4", marginLeft: 6 }}>
                        (upload backlog)
                      </span>
                    )}
                  </div>
                  <div>
                    Detail coverage: {cacheTelemetry.tierDemand.resident.detailChunks}/
                    {cacheTelemetry.tierDemand.desired.detailChunks}
                    {cacheTelemetry.tierDemand.sparseDetail && (
                      <span style={{ color: "#fb4", marginLeft: 6 }}>
                        (sparse)
                      </span>
                    )}
                  </div>
                  {cacheTelemetry.tierDemand.sparseDetail && (
                    <div style={{ color: "#fb4" }}>
                      Detail coverage is budget-limited; lower the detail LOD explicitly for broader coverage.
                    </div>
                  )}
                  <div>
                    Coarse resident: {cacheTelemetry.tierDemand.resident.coarseChunks}/
                    {cacheTelemetry.tierDemand.desired.coarseChunks}
                  </div>
                </div>

                {generatedStatusSnap.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">Generated coarse</div>
                    <div className="debug-member-list">
                      {generatedStatusSnap.map(({ datasetId: generatedDatasetId, counts }) => {
                        const dsName = datasets.get(generatedDatasetId)?.manifest.name ?? generatedDatasetId;
                        return (
                          <div key={generatedDatasetId} className="debug-member-row">
                            <span className="debug-member-id" title={generatedDatasetId}>
                              {shortId(dsName)}
                            </span>
                            <span title="ready">{counts.ready} ready</span>
                            <span title="pending">{counts.pending} pending</span>
                            <span title="unavailable">{counts.unavailable} unavailable</span>
                            <span title={`transient: ${counts.failedTransient}, permanent: ${counts.failedPermanent}`}>
                              {counts.failed} failed
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Hit Rate */}
                <div className="debug-section">
                  <div className="debug-title">Hit Rate</div>
                  <div>{fmt(cacheTelemetry.hitRate * 100, 1)}%</div>
                </div>

                {/* Eviction */}
                <div className="debug-section">
                  <div className="debug-title">Eviction</div>
                  <div>
                    Mode:{" "}
                    <span style={{
                      color: cacheTelemetry.interactionMode === "panning" ? "#4f4"
                        : cacheTelemetry.interactionMode === "scrubbing" ? "#ff4"
                        : "#888",
                    }}>
                      {cacheTelemetry.interactionMode}
                    </span>
                  </div>
                  <div>Tier order: {cacheTelemetry.evictionTierOrder.join(" > ")}</div>
                  <div>Evictions/s: {fmt(cacheTelemetry.evictionsPerSec, 1)}</div>
                </div>

                {/* Errors */}
                <div className="debug-section" style={{
                  background: (cacheTelemetry.failedChunks.transient > 0 || cacheTelemetry.failedChunks.permanent > 0) ? "#4a1111" : undefined,
                }}>
                  <div className="debug-title">Errors</div>
                  <div>
                    Transient: {cacheTelemetry.failedChunks.transient}{" "}
                    Permanent: {cacheTelemetry.failedChunks.permanent}
                  </div>
                  {cacheTelemetry.lastError && (
                    <div style={{ color: "#f88", fontSize: 10, wordBreak: "break-all" }}>
                      {cacheTelemetry.lastError}
                    </div>
                  )}
                </div>

                {/* Decode */}
                <div className="debug-section">
                  <div className="debug-title">Decode</div>
                  <div>{fmt(cacheTelemetry.decodesPerSec, 1)} chunks/s ({cacheTelemetry.decodeWorkersTotal} workers)</div>
                  <div>
                    p50: {fmt(cacheTelemetry.decodeP50Ms, 2)}ms
                    {" · "}
                    p95: {fmt(cacheTelemetry.decodeP95Ms, 2)}ms
                    {" · "}
                    avg: {fmt(cacheTelemetry.avgDecodeMs, 2)}ms
                  </div>
                </div>
              </>
            ) : (
              <div className="debug-section">
                <div style={{ color: "#666" }}>Cache data not available</div>
              </div>
            )}
          </>
        )}

        {activeTab === "health" && (
          <>
            <div className="debug-section">
              <div className="debug-title">Dataset Health</div>
              <div className="debug-config-row">
                <span>
                  {datasetHealthSnap.length} dataset{datasetHealthSnap.length === 1 ? "" : "s"}
                </span>
                <button
                  className="debug-config-toggle"
                  onClick={refreshDatasetHealth}
                  disabled={datasetHealthLoading}
                >
                  {datasetHealthLoading ? "Refreshing" : "Refresh"}
                </button>
              </div>
              {datasetHealthUpdatedAt !== null && (
                <div style={{ color: "#888", fontSize: 10 }}>
                  updated {new Date(datasetHealthUpdatedAt).toLocaleTimeString()}
                </div>
              )}
              {datasetHealthSnap.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <span style={{ color: statusColor("healthy") }}>
                    {datasetHealthCounts.healthy} healthy
                  </span>
                  {" · "}
                  <span style={{ color: statusColor("degraded") }}>
                    {datasetHealthCounts.degraded} degraded
                  </span>
                  {" · "}
                  <span style={{ color: statusColor("unavailable") }}>
                    {datasetHealthCounts.unavailable} unavailable
                  </span>
                </div>
              )}
              {datasetHealthError && (
                <div style={{ color: "#f88", marginTop: 4 }}>
                  {datasetHealthError}
                </div>
              )}
              {!datasetHealthLoading && !datasetHealthError && datasetHealthSnap.length === 0 && (
                <div style={{ color: "#666", marginTop: 4 }}>
                  No dataset health rows yet.
                </div>
              )}
            </div>

            {datasetHealthSnap.map((health) => {
              const cache = health.source_cache ?? null;
              const generated = health.generated_coarse;
              return (
                <div
                  key={health.workspace_dataset_id}
                  className="debug-section"
                  style={{
                    background: health.status === "unavailable"
                      ? "#4a1111"
                      : health.status === "degraded" ? "#3a2d12" : undefined,
                  }}
                >
                  <div className="debug-title" style={{ color: statusColor(health.status) }}>
                    {health.name}
                  </div>
                  <div style={{ color: "#888", fontSize: 10 }} title={health.workspace_dataset_id}>
                    {shortId(health.workspace_dataset_id, 28)}
                  </div>
                  <div>
                    status: <span style={{ color: statusColor(health.status) }}>{health.status}</span>
                    {health.backend && <> · backend: {health.backend}</>}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <button
                      className="debug-config-toggle"
                      onClick={() => {
                        sessionRef?.current?.bridge.sendDatasetRetry(health.workspace_dataset_id);
                        window.setTimeout(refreshDatasetHealth, 750);
                      }}
                      disabled={datasetHealthLoading}
                    >
                      Retry binding
                    </button>
                  </div>
                  {health.source_url && (
                    <div className="debug-break-anywhere" title={health.source_url}>
                      source: {health.source_url}
                    </div>
                  )}

                  <div style={{ marginTop: 5 }}>
                    binding:{" "}
                    <span style={{ color: statusColor(health.binding.status) }}>
                      {health.binding.status}
                    </span>
                    {health.binding.message && (
                      <span style={{ color: "#888" }}> ({health.binding.message})</span>
                    )}
                  </div>

                  {cache ? (
                    <div style={{ marginTop: 5 }}>
                      <div>
                        source cache: {fmtBytes(cache.current_bytes)} / {fmtBytes(cache.max_bytes)}
                        {" "}· {cache.used_percent}% · entries {cache.entry_count}
                      </div>
                      <div style={{ color: "#888" }}>
                        hits {cache.hits} · misses {cache.misses} · evictions {cache.evictions}
                        {cache.backend_errors > 0 && (
                          <span style={{ color: "#f88" }}> · backend errors {cache.backend_errors}</span>
                        )}
                      </div>
                      <div style={{ color: "#888" }}>
                        backend reads {cache.source_reads} · {cache.source_read_millis} ms
                        {cache.source_reads > 0 && (
                          <> · {Math.round(cache.source_read_millis / cache.source_reads)} ms/read</>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "#888", marginTop: 5 }}>
                      source cache: unavailable
                    </div>
                  )}

                  <div style={{ marginTop: 5 }}>
                    generated coarse:{" "}
                    <span style={{ color: statusColor(generated.status) }}>
                      {generated.status}
                    </span>
                    {" "}· levels {generated.level_count}
                  </div>
                  <div style={{ color: "#888" }}>
                    chunks {generated.ready_chunks} ready · {generated.pending_chunks} pending ·{" "}
                    {generated.failed_chunks} failed · {generated.unavailable_chunks} unavailable
                  </div>
                  {generated.message && (
                    <div style={{ color: "#888" }}>{generated.message}</div>
                  )}
                  {generated.cache && (
                    <div style={{ color: "#888", marginTop: 3 }}>
                      generated cache: {generated.cache.storage} · {fmtBytes(generated.cache.current_bytes)}
                      {generated.cache.max_bytes !== undefined && generated.cache.max_bytes !== null && (
                        <> / {fmtBytes(generated.cache.max_bytes)}</>
                      )}
                      {generated.cache.used_percent !== undefined && generated.cache.used_percent !== null && (
                        <> · {generated.cache.used_percent}%</>
                      )}
                      {" "}· evictions {generated.cache.evictions}
                      {generated.cache.root && (
                        <div className="debug-break-anywhere" title={generated.cache.root}>
                          root: {generated.cache.root}
                        </div>
                      )}
                    </div>
                  )}
                  {(generated.recent_failures ?? []).length > 0 && (
                    <div style={{ marginTop: 3 }}>
                      {(generated.recent_failures ?? []).map((failure, index) => (
                        <div key={index} style={{ color: "#f88" }} title={`${failure.image_id} ${failure.key}`}>
                          generated failure: {failure.status} L{failure.level_index} {shortId(failure.image_id, 18)}
                          {failure.message && <> · {failure.message}</>}
                        </div>
                      ))}
                    </div>
                  )}

                  {(health.messages ?? []).length > 0 && (
                    <div style={{ marginTop: 5 }}>
                      {(health.messages ?? []).map((message, index) => (
                        <div key={index} style={{ color: "#fb4" }}>
                          {message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {activeTab === "catalog" && (
          <>
            <div className="debug-section">
              <div className="debug-title">Asset Catalog</div>
              {catalogSnap ? (
                <>
                  <div>assetEpoch: {catalogSnap.assetEpoch}</div>
                  <div style={{ marginTop: 6 }}>
                    Proxy cache: {fmtBytes(catalogSnap.proxyBytes)} /{" "}
                    {fmtBytes(catalogSnap.proxyBudget)}
                  </div>
                  <div>
                    In-flight: {catalogSnap.inFlightProxyCount} (queue:{" "}
                    {catalogSnap.pendingProxyCount})
                  </div>
                </>
              ) : (
                <div style={{ color: "#666" }}>Waiting for catalog…</div>
              )}
            </div>
            {catalogSnap?.perDataset.map(ds => (
              <div key={ds.datasetId} className="debug-section">
                <div className="debug-title">{ds.name}</div>
                <div style={{ color: "#888", fontSize: 11 }}>
                  {ds.datasetId}
                </div>
                <div style={{ marginTop: 4 }}>
                  GroupProxy3D:{" "}
                  <span style={{ color: ds.groupsWithProxy > 0 ? "#6f6" : "#666" }}>
                    {ds.groupsWithProxy}
                  </span>{" "}
                  · TileProxy3D:{" "}
                  <span style={{ color: ds.tilesWithProxy > 0 ? "#6f6" : "#666" }}>
                    {ds.tilesWithProxy}
                  </span>{" "}
                  · total entries: {ds.totalEntries}
                </div>
                {ds.sampleEntries.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#aaa" }}>
                    <div style={{ color: "#888" }}>sample entries:</div>
                    {ds.sampleEntries.map((e, i) => (
                      <div
                        key={i}
                        style={{
                          fontFamily: "monospace",
                          paddingLeft: 8,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {e.entityId}: [{e.kinds.join(", ")}]
                      </div>
                    ))}
                    {ds.totalEntries > ds.sampleEntries.length && (
                      <div style={{ color: "#666", paddingLeft: 8 }}>
                        … {ds.totalEntries - ds.sampleEntries.length} more
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {catalogSnap && catalogSnap.perDataset.length === 0 && (
              <div className="debug-section">
                <div style={{ color: "#666" }}>
                  No datasets registered yet.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
