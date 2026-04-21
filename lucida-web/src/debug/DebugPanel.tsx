/**
 * Debug side panel — renders stats from debugStats as a tabbed panel
 * docked to the right of the canvas. Polls at ~200ms intervals for low overhead.
 *
 * When wasmSceneRef and datasetId are provided, also shows Scene Query
 * debug info: epochs, per-entity ViewQueryResult, and last ray pick.
 */
import { useEffect, useRef, useState } from "react";
import { debugStats, type DebugStats } from "./debugStats.ts";
import { DEBUG_CATEGORIES, isDebugEnabled, setDebugEnabled, type DebugCategory } from "./logging.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { WasmScene } from "lucida-core";
import type { DatasetState } from "../types.ts";
import type { CacheTelemetry } from "../pipeline/cpuCache.ts";
import type { Session } from "../session.ts";
import "./DebugPanel.css";

const POLL_INTERVAL_MS = 200;

/** Short label for a S6 WellMode in the active-set rendering. */
function modeLabel(mode: string): string {
  switch (mode) {
    case "well-as-proxy":
      return "WP";
    case "fields-with-proxy-fallback":
      return "FP";
    case "fields-with-detail":
      return "FD";
    default:
      return mode;
  }
}

/** Color for a S6 WellMode in the active-set rendering. */
function modeColor(mode: string): string {
  switch (mode) {
    case "well-as-proxy":
      return "#88f";
    case "fields-with-proxy-fallback":
      return "#fb4";
    case "fields-with-detail":
      return "#4f4";
    default:
      return "#aaa";
  }
}

type TabId = "render" | "scene" | "pick" | "planning" | "cache" | "orch" | "catalog" | "logging";

const LOGGING_CATEGORY_DESCRIPTIONS: Record<DebugCategory, string> = {
  bridge: "WebSocket send/receive and dataset-open lifecycle",
  wasm: "Scene mutations inside the Rust WASM module (scene.* events)",
  render: "Render loop lifecycle, dirty-flag attribution, throttle skips",
};

interface CatalogSnap {
  assetEpoch: number;
  perDataset: Array<{
    datasetId: string;
    name: string;
    wellsWithProxy: number;
    fieldsWithProxy: number;
    totalEntries: number;
    sampleEntries: Array<{ entityId: string; kinds: string[] }>;
  }>;
  proxyBytes: number;
  proxyBudget: number;
  inFlightProxyCount: number;
  proxyQueueDepth: number;
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

/** Truncate a long id to "...lastN" form, leaving short ids untouched. */
function shortId(id: string, max = 16): string {
  if (id.length <= max) return id;
  return "..." + id.slice(-(max - 3));
}

/** Body of the Planning tab — split out so the inline JSX stays readable. */
function PlanningTabBody({
  planning,
  datasets,
  renderLoopRef,
}: {
  planning: DebugStats["planning"];
  datasets: Map<string, DatasetState>;
  renderLoopRef: React.RefObject<RenderLoop | null> | undefined;
}) {
  const entries = Object.values(planning.byDataset);
  if (entries.length === 0) {
    return (
      <div className="debug-section">
        <div style={{ color: "#666" }}>
          No planning data yet. Open a dataset to populate.
        </div>
      </div>
    );
  }

  const dumpPlans = () => {
    const orch = renderLoopRef?.current?.getOrchestrator();
    if (!orch) {
      console.warn("[DebugPanel] orchestrator not available");
      return;
    }
    const plans = orch.getLastPlans();
    console.group("[DebugPanel] last plans");
    for (const [dsId, plan] of plans) {
      const lanes: Record<string, typeof plan.requests> = {
        detail: [],
        runway: [],
        overview: [],
      };
      for (const r of plan.requests) lanes[r.lane].push(r);
      console.group(
        `${dsId}: ${plan.requests.length} chunks (${lanes.detail.length} D / ${lanes.runway.length} R / ${lanes.overview.length} O), ${plan.proxyRequests.length} proxies`,
      );
      for (const lane of ["detail", "runway", "overview"] as const) {
        if (lanes[lane].length === 0) continue;
        console.groupCollapsed(`${lane}: ${lanes[lane].length}`);
        console.table(
          lanes[lane].slice(0, 50).map(r => ({
            chunkKey: r.chunkKey,
            level: r.level,
            entityId: r.entityId,
            priority: r.priority,
          })),
        );
        if (lanes[lane].length > 50) {
          console.log(`(+${lanes[lane].length - 50} more)`);
        }
        console.groupEnd();
      }
      if (plan.proxyRequests.length > 0) {
        console.groupCollapsed(`proxies: ${plan.proxyRequests.length}`);
        console.table(plan.proxyRequests.slice(0, 50));
        console.groupEnd();
      }
      console.groupEnd();
    }
    console.groupEnd();
  };

  const dumpActiveSets = () => {
    const orch = renderLoopRef?.current?.getOrchestrator();
    if (!orch) {
      console.warn("[DebugPanel] orchestrator not available");
      return;
    }
    const plans = orch.getLastPlans();
    console.group("[DebugPanel] last active sets");
    for (const [dsId, plan] of plans) {
      console.groupCollapsed(`${dsId}: ${plan.activeSet.length} entries`);
      console.table(
        plan.activeSet.map(e => ({
          entityId: e.entityId,
          mode: e.mode,
          targetLod: e.targetLod,
          range: `${e.detailOwnedLodRange[0]}-${e.detailOwnedLodRange[1]}`,
          proxyKind: e.proxyKind ?? "",
          proxyAvailable: e.proxyAvailable,
          wellProxyAvailable: e.wellProxyAvailable,
        })),
      );
      console.groupEnd();
    }
    console.groupEnd();
  };

  return (
    <>
      <div className="debug-section">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={dumpPlans}>Dump plans → console</button>
          <button onClick={dumpActiveSets}>Dump active sets → console</button>
        </div>
      </div>
      {entries.map(p => (
        <PlanningDatasetSection
          key={p.datasetId}
          p={p}
          name={datasets.get(p.datasetId)?.manifest?.name ?? p.datasetId}
        />
      ))}
    </>
  );
}

/** One per-dataset section in the Planning tab. */
function PlanningDatasetSection({
  p,
  name,
}: {
  p: import("./debugStats.ts").PlanningDatasetDebug;
  name: string;
}) {
  const wellsTotal =
    p.wellsByMode.wellAsProxy +
    p.wellsByMode.fieldsWithProxyFallback +
    p.wellsByMode.fieldsWithDetail;
  const cull = p.culling;
  // Avoid divide-by-zero when no cells were considered (no visible
  // entities at all). Show the percentage retained at each stage so
  // "is culling actually doing work?" is answerable at a glance.
  const pct = (n: number) =>
    cull.considered > 0 ? `${((n / cull.considered) * 100).toFixed(0)}%` : "—";

  return (
    <>
      <div className="debug-section">
        <div className="debug-title" title={p.datasetId}>
          {name}
        </div>
        <div>
          <span style={{ color: "#4f4" }}>D:{p.lanes.detail}</span>{" "}
          <span style={{ color: "#ff4" }}>R:{p.lanes.runway}</span>{" "}
          <span style={{ color: "#88f" }}>O:{p.lanes.overview}</span>{" "}
          <span style={{ color: "#aaa" }}>· proxies:{p.proxyCount}</span>{" "}
          <span style={{ color: "#aaa" }}>· total chunks:{p.totalChunks}</span>
        </div>
        {p.catalogDegradations > 0 && (
          <div style={{ color: "#fb4", marginTop: 4 }}>
            ⚠ catalog degradations this plan: {p.catalogDegradations}
          </div>
        )}
      </div>

      {wellsTotal > 0 && (
        <div className="debug-section">
          <div className="debug-title">Wells by mode ({wellsTotal} wells)</div>
          <div>
            <span style={{ color: modeColor("well-as-proxy") }}>
              well-proxy: {p.wellsByMode.wellAsProxy}
            </span>{" "}
            ·{" "}
            <span style={{ color: modeColor("fields-with-proxy-fallback") }}>
              fallback: {p.wellsByMode.fieldsWithProxyFallback}
            </span>{" "}
            ·{" "}
            <span style={{ color: modeColor("fields-with-detail") }}>
              detail: {p.wellsByMode.fieldsWithDetail}
            </span>
          </div>
        </div>
      )}

      {p.lodBreakdown.length > 0 && (
        <div className="debug-section">
          <div className="debug-title">Per-LOD (planned / cached / in-flight)</div>
          <div className="debug-member-list">
            {p.lodBreakdown.map(row => (
              <div key={row.level} className="debug-member-row">
                <span className="debug-member-id">L{row.level}</span>
                <span style={{ color: row.planned > 0 ? "#4f4" : "#666" }}>
                  {row.planned}
                </span>
                <span style={{ color: "#88f" }}>{row.cached}</span>
                <span style={{ color: row.inFlight > 0 ? "#ff4" : "#666" }}>
                  {row.inFlight}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="debug-section">
        <div className="debug-title">Frustum culling</div>
        <div style={{ fontSize: 11 }}>
          considered: {cull.considered}
          {" → "}
          xy: {cull.afterXyBounds} ({pct(cull.afterXyBounds)})
          {" → "}
          z: {cull.afterZRange} ({pct(cull.afterZRange)})
          {" → "}
          frustum: {cull.afterFrustum} ({pct(cull.afterFrustum)})
        </div>
      </div>

      {p.focalEntity && (
        <div className="debug-section">
          <div className="debug-title">Focal entity</div>
          <div title={p.focalEntity.entityId}>
            <span className="debug-member-id">{shortId(p.focalEntity.entityId, 24)}</span>{" "}
            <span style={{ color: "#888" }}>
              ({p.focalEntity.kind}
              {p.focalEntity.parentWellId && (
                <>
                  {" / parent "}
                  <span title={p.focalEntity.parentWellId}>
                    {shortId(p.focalEntity.parentWellId, 18)}
                  </span>
                </>
              )}
              )
            </span>
          </div>
          <div style={{ marginTop: 4 }}>
            mode:{" "}
            <span style={{ color: modeColor(p.focalEntity.mode) }}>
              {modeLabel(p.focalEntity.mode)}
            </span>{" "}
            <span style={{ color: "#888", fontSize: 10 }}>
              ({p.focalEntity.modeReason})
            </span>
          </div>
          <div>
            diag: {fmt(p.focalEntity.projectedDiagonalPx, 1)}px · area:{" "}
            {fmt(p.focalEntity.projectedAreaPx2, 0)}px² · imp:{" "}
            {fmt(p.focalEntity.importance, 2)}
          </div>
          <div>
            target L{p.focalEntity.idealTargetLod} · range{" "}
            {p.focalEntity.detailOwnedRange[0]}-{p.focalEntity.detailOwnedRange[1]}{" "}
            · chunks: {p.focalEntity.chunkCount}
            {p.focalEntity.topPriority !== null && (
              <> · top p{fmt(p.focalEntity.topPriority, 0)}</>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function DebugPanel({ wasmSceneRef, datasetId, lastClickScreen, datasets, sessionRef, renderLoopRef, style }: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("render");
  const [snap, setSnap] = useState<DebugStats>({ ...debugStats });

  const [sceneSnap, setSceneSnap] = useState<SceneQuerySnap>({
    epochs: null,
    viewQuery: null,
    lastRayPick: null,
  });
  const lastRayPickRef = useRef<SceneQuerySnap["lastRayPick"]>(null);

  // Cache tab state
  const [cacheTelemetry, setCacheTelemetry] = useState<CacheTelemetry | null>(null);

  // Catalog tab state
  const [catalogSnap, setCatalogSnap] = useState<CatalogSnap | null>(null);

  // Render loop snapshot (FPS, dirty flags, throttle, sticky max times)
  const [loopSnap, setLoopSnap] = useState<RenderLoopSnap | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setSnap({ ...debugStats, memberStats: [...debugStats.memberStats] });

      // Poll render loop snapshot (FPS, dirty flags, throttle state, max times)
      const loop = renderLoopRef?.current ?? null;
      setLoopSnap(loop ? loop.getDebugSnapshot() : null);

      // Poll cache telemetry
      const cache = sessionRef?.current?.cpuCache ?? null;
      if (cache) setCacheTelemetry(cache.telemetry());

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
                let wells = 0;
                let fields = 0;
                for (const e of entries) {
                  if (e.kinds?.includes("WellProxy3D")) wells++;
                  if (e.kinds?.includes("FieldProxy3D")) fields++;
                }
                perDataset.push({
                  datasetId: dsId,
                  name: dsEntry.manifest?.name ?? dsId,
                  wellsWithProxy: wells,
                  fieldsWithProxy: fields,
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
              proxyQueueDepth: tel?.proxyQueueDepth ?? 0,
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
    { id: "cache", label: "Cache" },
    { id: "orch", label: "Orch" },
    { id: "catalog", label: "Catalog" },
    { id: "logging", label: "Logging" },
  ];

  const [loggingTick, setLoggingTick] = useState(0);
  const toggleCategory = (cat: DebugCategory) => {
    setDebugEnabled(cat, !isDebugEnabled(cat));
    setLoggingTick(t => t + 1);
  };

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
              <div>
                FPS: {loopSnap?.fps ?? "—"}
                {loopSnap?.msSinceLastRender !== null && loopSnap?.msSinceLastRender !== undefined && (
                  <span style={{ color: "#888" }}> (last render {loopSnap.msSinceLastRender}ms ago)</span>
                )}
              </div>
              <div>
                Frame: {fmt(snap.frameTimeMs, 1)}ms
                {loopSnap && <span style={{ color: "#888" }}> (max {fmt(loopSnap.maxFrameMs, 1)})</span>}
              </div>
              <div>
                Plan: {fmt(snap.planTimeMs, 1)}ms
                {loopSnap && <span style={{ color: "#888" }}> (max {fmt(loopSnap.maxPlanMs, 1)})</span>}
              </div>
              <div>
                Upload: {fmt(snap.uploadTimeMs, 1)}ms
                {loopSnap && <span style={{ color: "#888" }}> (max {fmt(loopSnap.maxUploadMs, 1)})</span>}
              </div>
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

            <div className="debug-section">
              <div className="debug-title">Passes</div>
              <div>
                Total: {snap.renderPasses.total}
                {loopSnap && loopSnap.maxPasses > snap.renderPasses.total && (
                  <span style={{ color: "#888" }}> (max {loopSnap.maxPasses})</span>
                )}
              </div>
              {Object.entries(snap.renderPasses.byDataset).length > 0 && (
                <div className="debug-member-list">
                  {Object.entries(snap.renderPasses.byDataset)
                    .sort((a, b) => b[1] - a[1])
                    .map(([dsId, count]) => (
                      <div key={dsId} className="debug-member-row">
                        <span className="debug-member-id" title={dsId}>
                          {dsId.length > 16 ? "..." + dsId.slice(-14) : dsId}
                        </span>
                        <span>{count}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="debug-section">
              <div className="debug-title">LOD</div>
              <div>Level: {snap.selectedLevel} / {snap.numLevels - 1}</div>
              <div>eff_zoom: {fmt(snap.effectiveZoom, 2)}</div>
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
              const active = snap.memberStats
                .filter(m => m.chunksNeeded > 0)
                .map(m => ({ ...m, gap: m.chunksNeeded - m.chunksSent }))
                .sort((a, b) => b.gap - a.gap);
              if (active.length === 0) return null;
              const worstGap = active[0].gap;
              return (
                <div className="debug-section">
                  <div className="debug-title">Per-Member ({active.length} active, sorted by gap)</div>
                  <div className="debug-member-list">
                    {active.slice(0, 12).map((m, i) => (
                      <div
                        key={m.id}
                        className="debug-member-row"
                        style={i === 0 && worstGap > 0 ? { color: "#fb4" } : undefined}
                      >
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

        {activeTab === "cache" && (
          <>
            {cacheTelemetry ? (
              <>
                {/* Budget */}
                <div className="debug-section">
                  <div className="debug-title">Budget</div>
                  {(() => {
                    const detailPct = cacheTelemetry.detailBudget > 0
                      ? Math.min(100, Math.round((cacheTelemetry.detailBytes / cacheTelemetry.detailBudget) * 100))
                      : 0;
                    const overviewPct = cacheTelemetry.overviewBudget > 0
                      ? Math.min(100, Math.round((cacheTelemetry.overviewBytes / cacheTelemetry.overviewBudget) * 100))
                      : 0;
                    return (
                      <>
                        <div>Detail: {fmtBytes(cacheTelemetry.detailBytes)} / {fmtBytes(cacheTelemetry.detailBudget)} ({detailPct}%)</div>
                        <div className="debug-bar-track">
                          <div className="debug-bar-fill" style={{ width: `${detailPct}%`, background: "#4f4" }} />
                        </div>
                        <div>Overview: {fmtBytes(cacheTelemetry.overviewBytes)} / {fmtBytes(cacheTelemetry.overviewBudget)} ({overviewPct}%)</div>
                        <div className="debug-bar-track">
                          <div className="debug-bar-fill" style={{ width: `${overviewPct}%`, background: "#88f" }} />
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Fetch */}
                <div className="debug-section">
                  <div className="debug-title">Fetch</div>
                  <div>In-flight: {cacheTelemetry.inFlightCount} reqs, {fmtBytes(cacheTelemetry.inFlightBytes)}</div>
                  <div>Queue: {cacheTelemetry.queueDepth}</div>
                </div>

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
                  <div>Avg: {fmt(cacheTelemetry.avgDecodeMs, 2)}ms</div>
                </div>

                {/* Config */}
                <div className="debug-section">
                  <div className="debug-title">Config</div>
                  <div className="debug-config-row">
                    <span>Detail budget (MB)</span>
                    <input
                      className="debug-config-input"
                      type="number"
                      value={Math.round(cacheTelemetry.detailBudget / (1024 * 1024))}
                      onChange={e => {
                        const mb = Number(e.target.value);
                        if (mb > 0) sessionRef?.current?.cpuCache.updateConfig({ detailBudgetBytes: mb * 1024 * 1024 });
                      }}
                    />
                  </div>
                  <div className="debug-config-row">
                    <span>Overview budget (MB)</span>
                    <input
                      className="debug-config-input"
                      type="number"
                      value={Math.round(cacheTelemetry.overviewBudget / (1024 * 1024))}
                      onChange={e => {
                        const mb = Number(e.target.value);
                        if (mb > 0) sessionRef?.current?.cpuCache.updateConfig({ overviewBudgetBytes: mb * 1024 * 1024 });
                      }}
                    />
                  </div>
                  <div className="debug-config-row">
                    <span>Max fetches</span>
                    <input
                      className="debug-config-input"
                      type="number"
                      value={cacheTelemetry.maxConcurrentFetches}
                      onChange={e => {
                        const v = Number(e.target.value);
                        if (v > 0) sessionRef?.current?.cpuCache.updateConfig({ maxConcurrentFetches: v });
                      }}
                    />
                  </div>
                  <div className="debug-config-row">
                    <span>Max in-flight (MB)</span>
                    <input
                      className="debug-config-input"
                      type="number"
                      value={Math.round(cacheTelemetry.maxBytesInFlight / (1024 * 1024))}
                      onChange={e => {
                        const mb = Number(e.target.value);
                        if (mb > 0) sessionRef?.current?.cpuCache.updateConfig({ maxBytesInFlight: mb * 1024 * 1024 });
                      }}
                    />
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

        {activeTab === "orch" && (
          <>
            {snap.orch ? (
              <>
                {/* Mixed levels warning */}
                {snap.orch.hasMixedLevels && (
                  <div className="debug-section" style={{ background: "#4a1111" }}>
                    <div className="debug-warn" style={{ fontSize: 12 }}>
                      MIXED LEVELS IN needed[]
                    </div>
                    <div style={{ fontSize: 10, color: "#f88" }}>
                      Upload path uses needed[0].level for atlas config.
                      Chunks at other levels will render at wrong scale or be dropped.
                    </div>
                  </div>
                )}

                {/* Epoch cache status */}
                <div className="debug-section">
                  <div className="debug-title">Orchestrator</div>
                  <div>Epoch cache: {snap.orch.epochCacheHit ? "HIT (plan skipped)" : "MISS (re-planned)"}</div>
                </div>

                {/* Upload path debug */}
                {snap.uploadDebug && (
                  <div className="debug-section" style={{
                    background: snap.uploadDebug.chunksCacheMiss > 0 ? "#4a3311" : undefined,
                  }}>
                    <div className="debug-title">Upload Path</div>
                    <div>stateKey: {snap.uploadDebug.stateKey}</div>
                    <div>prevStateKey: {snap.uploadDebug.prevStateKey}</div>
                    <div>atlas config sent: {snap.uploadDebug.atlasConfigSent ? "YES" : "no"}</div>
                    <div>
                      chunks: {snap.uploadDebug.chunksAttempted} attempted,{" "}
                      <span style={{ color: "#4f4" }}>{snap.uploadDebug.chunksUploaded} uploaded</span>,{" "}
                      <span style={{ color: "#ff4" }}>{snap.uploadDebug.chunksSentSkip} sent-skip</span>,{" "}
                      <span style={{ color: snap.uploadDebug.chunksCacheMiss > 0 ? "#f44" : "#888" }}>
                        {snap.uploadDebug.chunksCacheMiss} cache-miss
                      </span>
                    </div>
                  </div>
                )}

                {/* Coordinate diagnostic */}
                {snap.orch.visibleRegion && (
                  <div className="debug-section">
                    <div className="debug-title">Visible Region</div>
                    <div>xy: [{snap.orch.visibleRegion.xyBounds.map(v => fmt(v, 0)).join(", ")}]</div>
                    <div>z: [{snap.orch.visibleRegion.zRange.join(", ")}]</div>
                    <div>zoom: {fmt(snap.orch.visibleRegion.effectiveZoom, 4)}</div>
                  </div>
                )}

                {snap.orch.entityDiag.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">Entity Coords (overlap check)</div>
                    <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4 }}>
                      Overlap needs: region.xy offset by pos falls within [0, fullShape]
                    </div>
                    <div className="debug-member-list">
                      {snap.orch.entityDiag.map((e) => {
                        const vr = snap.orch!.visibleRegion;
                        let overlapStatus = "?";
                        if (vr && e.fullShape) {
                          const localMinX = vr.xyBounds[0] - e.position[0];
                          const localMinY = vr.xyBounds[1] - e.position[1];
                          const localMaxX = vr.xyBounds[2] - e.position[0];
                          const localMaxY = vr.xyBounds[3] - e.position[1];
                          const overlaps = localMaxX > 0 && localMaxY > 0
                            && localMinX < e.fullShape[0] && localMinY < e.fullShape[1];
                          overlapStatus = overlaps ? "OK" : "NONE";
                        }
                        return (
                          <div key={e.entityId} className="debug-member-row" style={{
                            background: overlapStatus === "NONE" ? "#4a1111" : undefined,
                          }}>
                            <span className="debug-member-id" title={e.entityId}>
                              {e.entityId.length > 12 ? "..." + e.entityId.slice(-10) : e.entityId}
                            </span>
                            <span>pos:[{e.position[0]},{e.position[1]}]</span>
                            <span>full:[{e.fullShape ? e.fullShape.join(",") : "?"}]</span>
                            <span style={{ color: e.cachedKeys > 0 ? "#ff4" : "#888" }}>
                              cache:{e.cachedKeys}
                            </span>
                            <span style={{ color: overlapStatus === "NONE" ? "#f44" : "#4f4" }}>
                              {overlapStatus}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Active Set */}
                {snap.orch.activeSet.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">
                      Active Set (
                      {snap.orch.activeSet.filter(e => e.mode === "well-as-proxy").length} well-proxy /
                      {" "}{snap.orch.activeSet.filter(e => e.mode === "fields-with-proxy-fallback").length} fields+proxy /
                      {" "}{snap.orch.activeSet.filter(e => e.mode === "fields-with-detail").length} fields-detail)
                    </div>
                    <div className="debug-member-list">
                      {snap.orch.activeSet.slice(0, 10).map((e) => (
                        <div key={e.entityId} className="debug-member-row">
                          <span className="debug-member-id" title={e.entityId}>
                            {e.entityId.length > 12 ? "..." + e.entityId.slice(-10) : e.entityId}
                          </span>
                          <span style={{ color: modeColor(e.mode) }}>{modeLabel(e.mode)}</span>
                          <span>target L{e.targetLod}</span>
                          <span>range {e.detailOwnedLodRange[0]}-{e.detailOwnedLodRange[1]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Request summary by lane and level */}
                <div className="debug-section">
                  <div className="debug-title">Requests</div>
                  <div>
                    <span style={{ color: "#4f4" }}>detail: {snap.orch.laneCount.detail}</span>
                    {" "}
                    <span style={{ color: "#ff4" }}>runway: {snap.orch.laneCount.runway}</span>
                    {" "}
                    <span style={{ color: "#88f" }}>overview: {snap.orch.laneCount.overview}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: "#aaa" }}>By level: </span>
                    {Object.entries(snap.orch.levelCount)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([lvl, count]) => (
                        <span key={lvl} style={{ marginRight: 8 }}>L{lvl}:{count}</span>
                      ))}
                  </div>
                </div>

                {/* Per-member adapter output */}
                {snap.orch.members.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">Members (adapter output)</div>
                    <div className="debug-member-list">
                      {snap.orch.members.slice(0, 10).map((m, i) => (
                        <div key={`${m.imageId}-${i}`} className="debug-member-row" style={{
                          background: m.mixedLevels ? "#4a1111" : undefined,
                        }}>
                          <span className="debug-member-id" title={m.imageId}>
                            {m.imageId.length > 14 ? "..." + m.imageId.slice(-12) : m.imageId}
                          </span>
                          <span>uploadL{m.uploadLevel ?? "?"}</span>
                          <span>n:{m.neededCount} p:{m.prefetchCount}</span>
                          <span title={`Levels: ${JSON.stringify(m.levelCounts)}`}>
                            {Object.entries(m.levelCounts).map(([l, c]) => `L${l}:${c}`).join(" ")}
                          </span>
                          {m.mixedLevels && <span style={{ color: "#f44" }}>MIX</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top requests */}
                {snap.orch.topRequests.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">Top Requests</div>
                    <div className="debug-member-list">
                      {snap.orch.topRequests.map((r, i) => (
                        <div key={`${r.chunkKey}-${i}`} className="debug-member-row">
                          <span style={{
                            color: r.lane === "detail" ? "#4f4" : r.lane === "runway" ? "#ff4" : "#88f",
                            width: 14,
                          }}>
                            {r.lane === "detail" ? "D" : r.lane === "runway" ? "R" : "O"}
                          </span>
                          <span>L{r.level}</span>
                          <span className="debug-member-id" title={r.chunkKey}>
                            {r.chunkKey}
                          </span>
                          <span>p{fmt(r.priority, 0)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="debug-section">
                <div style={{ color: "#666" }}>Enable debug (D key) and load a dataset</div>
              </div>
            )}
          </>
        )}

        {activeTab === "planning" && (
          <PlanningTabBody
            planning={snap.planning}
            datasets={datasets}
            renderLoopRef={renderLoopRef}
          />
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
                    {catalogSnap.proxyQueueDepth})
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
                  WellProxy3D:{" "}
                  <span style={{ color: ds.wellsWithProxy > 0 ? "#6f6" : "#666" }}>
                    {ds.wellsWithProxy}
                  </span>{" "}
                  · FieldProxy3D:{" "}
                  <span style={{ color: ds.fieldsWithProxy > 0 ? "#6f6" : "#666" }}>
                    {ds.fieldsWithProxy}
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

        {activeTab === "logging" && (
          <>
            <div className="debug-section" key={loggingTick}>
              <div className="debug-title">Categories</div>
              <div style={{ color: "#888", fontSize: "0.75rem", marginBottom: 6 }}>
                Toggles persist in localStorage.debug. Most events fire after the
                page boots; for startup events, enable then reload.
              </div>
              {DEBUG_CATEGORIES.map(cat => {
                const on = isDebugEnabled(cat);
                return (
                  <label
                    key={cat}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "4px 0",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleCategory(cat)}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontFamily: "monospace" }}>{cat}</div>
                      <div style={{ color: "#888", fontSize: "0.75rem" }}>
                        {LOGGING_CATEGORY_DESCRIPTIONS[cat]}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
