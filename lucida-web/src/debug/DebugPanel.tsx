/**
 * Debug side panel — renders stats from debugStats as a tabbed panel
 * docked to the right of the canvas. Polls at ~200ms intervals for low overhead.
 *
 * When wasmSceneRef and datasetId are provided, also shows Scene Query
 * debug info: epochs, per-entity ViewQueryResult, and last ray pick.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { debugStats, type DebugStats } from "./debugStats.ts";
import {
  DEBUG_CATEGORIES,
  isDebugEnabled,
  setDebugEnabled,
  type DebugCategory,
  DEBUG_OVERLAYS,
  isOverlayEnabled,
  setOverlayEnabled,
  type DebugOverlay,
} from "./logging.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { WasmScene } from "lucida-core";
import type { DatasetState } from "../types.ts";
import type { CacheTelemetry } from "../pipeline/fetch/index.ts";
import type { GeneratedStatusCountsByDataset } from "../pipeline/generatedAvailability.ts";
import type { Session } from "../session.ts";
import type { DatasetHealthStatus, DatasetSourceHealth } from "../bridge.ts";
import {
  decodeViewQuery,
  type ViewQueryBinaryResult,
} from "../pipeline/planning/viewQueryBinary.ts";
import { ConfigTab } from "./ConfigTab.tsx";
import "./DebugPanel.css";

const POLL_INTERVAL_MS = 200;

/**
 * The Cache tab's budget/fetch-limit inputs write live CpuCache config
 * (`cpuCache.updateConfig`). Like the planning knobs in ConfigTab, that
 * is a dev-build control surface; production builds render the values
 * read-only so the panel inspects without steering the fetch pipeline.
 */
const CACHE_CONFIG_EDITABLE: boolean = import.meta.env.DEV;

/** Short label for an EntityMode in the active-set rendering. */
function modeLabel(mode: string): string {
  switch (mode) {
    case "tiles-with-detail":
      return "FD";
    default:
      return mode;
  }
}

/** Color for an EntityMode in the active-set rendering. */
function modeColor(mode: string): string {
  switch (mode) {
    case "tiles-with-detail":
      return "var(--success-text)";
    default:
      return "var(--text-muted)";
  }
}

type TabId = "render" | "scene" | "pick" | "planning" | "cache" | "health" | "orch" | "config" | "logging";

const LOGGING_CATEGORY_DESCRIPTIONS: Record<DebugCategory, string> = {
  bridge: "WebSocket send/receive and dataset-open lifecycle",
  wasm: "Scene mutations inside the Rust WASM module (scene.* events)",
  render: "Render loop lifecycle, dirty-flag attribution, throttle skips",
  cache: "CPU cache backpressure, failure bursts, eviction bursts",
  orch: "TickCoordinator events — cold-state rebuild churn, upload budget exhaustion, resend storm, delivery waste",
};

const OVERLAY_DESCRIPTIONS: Record<DebugOverlay, string> = {
  groupModes: "Per-group badge over the canvas: detail/coarse chunks available from the worker or CPU cache (Davailable/wanted Cavailable/wanted).",
  chunkGrid: "LOD chunk grid for every visible tile, color-coded by status (cached / in-flight / planned). Capped at ~600 cells per tick.",
  chunkTier: "Sub-color tile chunks by displayed render tier (detail = green, coarse = yellow, missing = red). Requires chunkGrid.",
  renderRadius: "Draw the active detail/coarse render-radius boundary. 2D shows circles; 3D shows projected sphere/ellipsoid rings.",
  cachedTier: "Sub-color cached chunks by eviction tier (active = bright green, demoted = pale sage, prefetch = teal). Requires chunkGrid.",
  plannedRank: "Sub-color planned chunks by queue rank (top of queue = bright orange, bottom = dim red, gray = not in pending). Requires chunkGrid.",
};

interface SceneQuerySnap {
  epochs: { content: number; layout: number; view: number; selection: number } | null;
  viewQuery: ViewQueryBinaryResult | null;
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
      return "var(--success-text)";
    case "degraded":
      return "var(--warning-text)";
    case "unavailable":
      return "var(--danger-text)";
    default:
      return "var(--text-muted)";
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
  console.group(`[DebugPanel] cpuCache contents (${entries.length} chunks)`);
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
  console.groupEnd();
}

/** Dump pending CPU-cache requests to the console, sorted by priority. */
function dumpPending(cache: import("../pipeline/fetch/index.ts").CpuCache | undefined | null): void {
  if (!cache) {
    console.warn("[DebugPanel] cpuCache not available");
    return;
  }
  const pending = cache.getPendingDump();
  console.group(`[DebugPanel] pending cpuCache queue (${pending.length} entries)`);
  console.table(pending.map(p => ({
    chunkKey: p.chunkKey,
    entityId: p.entityId,
    lane: p.lane,
    priority: p.priority,
    ageMs: Math.round(p.ageMs),
  })));
  console.groupEnd();
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
        <div style={{ color: "var(--text-muted)" }}>
          No planning data yet. Open a dataset to populate.
        </div>
      </div>
    );
  }

  const dumpPlans = () => {
    const coord = renderLoopRef?.current?.getTickCoordinator();
    if (!coord) {
      console.warn("[DebugPanel] tickCoordinator not available");
      return;
    }
    const plans = coord.getLastPlans();
    console.group("[DebugPanel] last plans");
    for (const [dsId, plan] of plans) {
      const lanes: Record<string, typeof plan.requests> = {
        minimap: [],
        detail: [],
        coarse: [],
        prefetch: [],
      };
      for (const r of plan.requests) lanes[r.lane].push(r);
      console.group(
        `${dsId}: ${plan.requests.length} chunks (${lanes.minimap.length} M / ${lanes.detail.length} D / ${lanes.coarse.length} C / ${lanes.prefetch.length} P)`,
      );
      for (const lane of ["minimap", "detail", "coarse", "prefetch"] as const) {
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
      console.groupEnd();
    }
    console.groupEnd();
  };

  const dumpActiveSets = () => {
    const coord = renderLoopRef?.current?.getTickCoordinator();
    if (!coord) {
      console.warn("[DebugPanel] tickCoordinator not available");
      return;
    }
    const plans = coord.getLastPlans();
    console.group("[DebugPanel] last active sets");
    // ActiveSetEntry is a discriminated union; each variant exposes a
    // different tile shape. Render the table with per-variant
    // defaults so the columns line up across rows.
    for (const [dsId, plan] of plans) {
      console.groupCollapsed(`${dsId}: ${plan.activeSet.length} entries`);
      console.table(
        plan.activeSet.map(e => {
          if (e.kind === "invisible") {
            return {
              entityId: e.entityId,
              kind: e.kind,
              mode: "",
              targetLod: e.coarsestLod,
              range: `${e.coarsestLod}-${e.coarsestLod}`,
            };
          }
          return {
            entityId: e.entityId,
            kind: e.kind,
            mode: e.mode,
            targetLod: e.targetLod,
            range: `${e.detailOwnedLodRange[0]}-${e.detailOwnedLodRange[1]}`,
          };
        }),
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

function PlanningDatasetSection({
  p,
  name,
}: {
  p: import("./debugStats.ts").PlanningDatasetDebug;
  name: string;
}) {
  const groupsTotal =
    p.groupsByMode.tilesWithDetail + p.groupsByMode.invisible;
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
          <span style={{ color: "var(--warning-text)" }}>M:{p.lanes.minimap}</span>{" "}
          <span style={{ color: "var(--success-text)" }}>D:{p.lanes.detail}</span>{" "}
          <span style={{ color: "var(--info-text)" }}>C:{p.lanes.coarse}</span>{" "}
          <span style={{ color: "var(--warning-text)" }}>P:{p.lanes.prefetch}</span>{" "}
          <span style={{ color: "var(--text-muted)" }}>· total chunks:{p.totalChunks}</span>
        </div>
      </div>

      {groupsTotal > 0 && (
        <div className="debug-section">
          <div className="debug-title">Groups by mode ({groupsTotal} groups)</div>
          <div>
            <span style={{ color: modeColor("tiles-with-detail") }}>
              detail: {p.groupsByMode.tilesWithDetail}
            </span>
            {" "}· invisible: {p.groupsByMode.invisible}
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
                <span style={{ color: row.planned > 0 ? "var(--success-text)" : "var(--text-muted)" }}>
                  {row.planned}
                </span>
                <span style={{ color: "var(--accent)" }}>{row.cached}</span>
                <span style={{ color: row.inFlight > 0 ? "var(--warning-text)" : "var(--text-muted)" }}>
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
            <span style={{ color: "var(--text-muted)" }}>
              ({p.focalEntity.kind}
              {p.focalEntity.parentGroupId && (
                <>
                  {" / parent "}
                  <span title={p.focalEntity.parentGroupId}>
                    {shortId(p.focalEntity.parentGroupId, 18)}
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
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
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
  const [generatedStatusSnap, setGeneratedStatusSnap] = useState<GeneratedStatusCountsByDataset[]>([]);

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
      setSnap({ ...debugStats, memberStats: [...debugStats.memberStats] });

      // Poll render loop snapshot (FPS, dirty flags, throttle state, max times)
      const loop = renderLoopRef?.current ?? null;
      setLoopSnap(loop ? loop.getDebugSnapshot() : null);

      // Poll cache telemetry
      const cache = sessionRef?.current?.cpuCache ?? null;
      if (cache) setCacheTelemetry(cache.telemetry());
      setGeneratedStatusSnap(
        sessionRef?.current?.generatedAvailability.statusCountsByDataset() ?? [],
      );

      // Poll scene query data if available
      const ws = wasmSceneRef?.current;
      if (ws && datasetId) {
        try {
          const epochsJson = ws.epochs();
          const epochs = epochsJson ? JSON.parse(epochsJson) : null;
          const viewQuery = decodeViewQuery(ws.view_query(datasetId));
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

  const budgetPct = snap.uploadBudgetTotal > 0
    ? Math.round((snap.uploadBytesUsed / snap.uploadBudgetTotal) * 100)
    : 0;

  const tabs: { id: TabId; label: string }[] = [
    { id: "render", label: "Render" },
    { id: "scene", label: "Scene" },
    { id: "pick", label: "Pick" },
    { id: "planning", label: "Planning" },
    { id: "cache", label: "Cache" },
    { id: "health", label: "Health" },
    { id: "orch", label: "Orch" },
    { id: "config", label: "Config" },
    { id: "logging", label: "Logging" },
  ];

  const [loggingTick, setLoggingTick] = useState(0);
  const toggleCategory = (cat: DebugCategory) => {
    setDebugEnabled(cat, !isDebugEnabled(cat));
    setLoggingTick(t => t + 1);
  };
  const toggleOverlay = (name: DebugOverlay) => {
    setOverlayEnabled(name, !isOverlayEnabled(name));
    setLoggingTick(t => t + 1);
  };

  // Cold-state header pulse: bright orange while a rebuild was within the
  // last poll interval, dim after that, gray when idle. The 500ms afterglow
  // ensures fast rebuilds aren't lost between 200ms polls. The parent
  // already polls at the same cadence, so the performance.now() read here
  // is just a derived view of state recency, not a fresh signal source.
  const coldStatePulse = (() => {
    const at = snap.orch?.coldState?.lastRebuildAt ?? 0;
    if (at === 0) return { color: "var(--border-strong)", glyph: "○" };
    // eslint-disable-next-line react-hooks/purity
    const ms = performance.now() - at;
    if (ms < 200) return { color: "var(--warning-text)", glyph: "●" };
    if (ms < 500) return { color: "var(--warning-text)", glyph: "◐" };
    return { color: "var(--border-strong)", glyph: "○" };
  })();

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
              <div>Mode: {snap.mode || "\u2014"}</div>
              <div>
                FPS: {loopSnap?.fps ?? "—"}
                {loopSnap?.msSinceLastRender !== null && loopSnap?.msSinceLastRender !== undefined && (
                  <span style={{ color: "var(--text-muted)" }}> (last render {loopSnap.msSinceLastRender}ms ago)</span>
                )}
              </div>
              <div>
                Frame: {fmt(snap.frameTimeMs, 1)}ms
                {loopSnap && <span style={{ color: "var(--text-muted)" }}> (max {fmt(loopSnap.maxFrameMs, 1)})</span>}
              </div>
              <div>
                Plan: {fmt(snap.planTimeMs, 1)}ms
                {loopSnap && <span style={{ color: "var(--text-muted)" }}> (max {fmt(loopSnap.maxPlanMs, 1)})</span>}
              </div>
              <div>
                Upload: {fmt(snap.uploadTimeMs, 1)}ms
                {loopSnap && <span style={{ color: "var(--text-muted)" }}> (max {fmt(loopSnap.maxUploadMs, 1)})</span>}
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
                    ? "var(--success-text)"
                    : interactiveRecent ? "var(--success-surface)" : "var(--border-strong)";
                  const residencyColor = loopSnap?.residencyDirty
                    ? "var(--warning-text)"
                    : residencyRecent ? "var(--warning-text)" : "var(--border-strong)";
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
                <div style={{ color: "var(--warning-text)" }}>
                  Throttled: {loopSnap.throttleSkipsPending} skip{loopSnap.throttleSkipsPending === 1 ? "" : "s"} pending
                </div>
              )}
            </div>

            <div className="debug-section">
              <div className="debug-title">Passes</div>
              <div>
                Total: {snap.renderPasses.total}
                {loopSnap && loopSnap.maxPasses > snap.renderPasses.total && (
                  <span style={{ color: "var(--text-muted)" }}> (max {loopSnap.maxPasses})</span>
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
              // Rows arrive pre-filtered to members with pending requests
              // and pre-capped (DEBUG_MEMBER_ROW_CAP); the uncapped active
              // population is the scalar `memberStatsActiveTotal`.
              const active = snap.memberStats
                .map(m => ({ ...m, gap: m.chunksNeeded - m.chunksSent }))
                .sort((a, b) => b.gap - a.gap);
              if (active.length === 0) return null;
              const worstGap = active[0].gap;
              return (
                <div className="debug-section">
                  <div className="debug-title">Per-Member ({snap.memberStatsActiveTotal} active, sorted by gap)</div>
                  <div className="debug-member-list">
                    {active.slice(0, 12).map((m, i) => (
                      <div
                        key={m.id}
                        className="debug-member-row"
                        style={i === 0 && worstGap > 0 ? { color: "var(--warning-text)" } : undefined}
                      >
                        <span className="debug-member-id" title={m.id}>
                          {m.id.length > 16 ? "..." + m.id.slice(-14) : m.id}
                        </span>
                        <span>L{m.level}/{m.numLevels - 1}</span>
                        <span>{m.chunksSent}/{m.chunksNeeded}</span>
                      </div>
                    ))}
                    {snap.memberStatsActiveTotal > 12 && (
                      <div className="debug-more">+{snap.memberStatsActiveTotal - 12} more</div>
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
                <div style={{ color: "var(--text-muted)" }}>No scene data available</div>
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
                <div style={{ color: "var(--text-muted)" }}>Click viewport to pick</div>
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
                          <div className="debug-bar-fill" style={{ width: `${mainPct}%`, background: "var(--success-text)" }} />
                        </div>
                        <div>Overview: {fmtBytes(cacheTelemetry.overviewBytes)} / {fmtBytes(cacheTelemetry.overviewBudget)} ({overviewPct}%)</div>
                        <div className="debug-bar-track">
                          <div className="debug-bar-fill" style={{ width: `${overviewPct}%`, background: "var(--accent)" }} />
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
                    {(["activeDetail", "demotedDetail", "prefetch", "overview"] as const).map(t => {
                      const r = cacheTelemetry.tierResidency[t];
                      const evicted = cacheTelemetry.evictionsByTier[t];
                      return (
                        <div key={t} className="debug-member-row">
                          <span className="debug-member-id">{t}</span>
                          <span>{r.count}</span>
                          <span>{fmtBytes(r.bytes)}</span>
                          {evicted > 0 && (
                            <span style={{ color: "var(--warning-text)" }} title="evicted in last window">
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
                        color: cacheTelemetry.pendingOldestAgeMs > 5000 ? "var(--warning-text)" : "var(--text-muted)",
                        marginLeft: 6,
                      }}>
                        (oldest {fmt(cacheTelemetry.pendingOldestAgeMs / 1000, 1)}s)
                      </span>
                    )}
                  </div>
                  <div>
                    Deliverable: {cacheTelemetry.readyCount}
                    {cacheTelemetry.readyCount > 32 && (
                      <span style={{ color: "var(--warning-text)", marginLeft: 6 }}>
                        (upload backlog)
                      </span>
                    )}
                  </div>
                  <div>
                    Detail coverage: {cacheTelemetry.tierDemand.resident.detailChunks}/
                    {cacheTelemetry.tierDemand.desired.detailChunks}
                    {cacheTelemetry.tierDemand.sparseDetail && (
                      <span style={{ color: "var(--warning-text)", marginLeft: 6 }}>
                        (sparse)
                      </span>
                    )}
                  </div>
                  {cacheTelemetry.tierDemand.sparseDetail && (
                    <div style={{ color: "var(--warning-text)" }}>
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
                      color: cacheTelemetry.interactionMode === "panning" ? "var(--success-text)"
                        : cacheTelemetry.interactionMode === "scrubbing" ? "var(--warning-text)"
                        : "var(--text-muted)",
                    }}>
                      {cacheTelemetry.interactionMode}
                    </span>
                  </div>
                  <div>Tier order: {cacheTelemetry.evictionTierOrder.join(" > ")}</div>
                  <div>Evictions/s: {fmt(cacheTelemetry.evictionsPerSec, 1)}</div>
                </div>

                {/* Errors */}
                <div className="debug-section" style={{
                  background: (cacheTelemetry.failedChunks.transient > 0 || cacheTelemetry.failedChunks.permanent > 0) ? "var(--danger-surface)" : undefined,
                }}>
                  <div className="debug-title">Errors</div>
                  <div>
                    Transient: {cacheTelemetry.failedChunks.transient}{" "}
                    Permanent: {cacheTelemetry.failedChunks.permanent}
                  </div>
                  {cacheTelemetry.lastError && (
                    <div style={{ color: "var(--danger-text)", fontSize: 10, wordBreak: "break-all" }}>
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

                {/* Config */}
                <div className="debug-section">
                  <div className="debug-title">Config</div>
                  {!CACHE_CONFIG_EDITABLE && (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 6 }} role="note">
                      Read-only in this build: live cache budgets shown for
                      inspection; editing is a dev-build capability.
                    </div>
                  )}
                  <div className="debug-config-row">
                    <span>Main budget (MB)</span>
                    <input
                      className="debug-config-input"
                      type="number"
                      value={Math.round(cacheTelemetry.mainBudget / (1024 * 1024))}
                      disabled={!CACHE_CONFIG_EDITABLE}
                      onChange={e => {
                        if (!CACHE_CONFIG_EDITABLE) return;
                        const mb = Number(e.target.value);
                        if (mb > 0) sessionRef?.current?.cpuCache.updateConfig({ mainBudgetBytes: mb * 1024 * 1024 });
                      }}
                    />
                  </div>
                  <div className="debug-config-row">
                    <span>Overview budget (MB)</span>
                    <input
                      className="debug-config-input"
                      type="number"
                      value={Math.round(cacheTelemetry.overviewBudget / (1024 * 1024))}
                      disabled={!CACHE_CONFIG_EDITABLE}
                      onChange={e => {
                        if (!CACHE_CONFIG_EDITABLE) return;
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
                      disabled={!CACHE_CONFIG_EDITABLE}
                      onChange={e => {
                        if (!CACHE_CONFIG_EDITABLE) return;
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
                      disabled={!CACHE_CONFIG_EDITABLE}
                      onChange={e => {
                        if (!CACHE_CONFIG_EDITABLE) return;
                        const mb = Number(e.target.value);
                        if (mb > 0) sessionRef?.current?.cpuCache.updateConfig({ maxBytesInFlight: mb * 1024 * 1024 });
                      }}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="debug-section">
                <div style={{ color: "var(--text-muted)" }}>Cache data not available</div>
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
                  <div className="debug-section" style={{ background: "var(--danger-surface)" }}>
                    <div className="debug-warn" style={{ fontSize: 12 }}>
                      MIXED LEVELS IN needed[]
                    </div>
                    <div style={{ fontSize: 10, color: "var(--danger-text)" }}>
                      Upload path uses needed[0].level for atlas config.
                      Chunks at other levels will render at wrong scale or be dropped.
                    </div>
                  </div>
                )}

                {/* Cold state — epoch fast-path stats, rebuild rate,
                    per-epoch cause attribution, and rebuild timing. The
                    pulse next to the title is a visceral activity
                    indicator (one bright frame per rebuild + 500ms
                    afterglow) so frequency is readable at a glance. */}
                <div className="debug-section">
                  <div
                    className="debug-title"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <span>Cold State</span>
                    <span
                      title="Pulses on every full plan/rebuild tick"
                      style={{
                        color: coldStatePulse.color,
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {coldStatePulse.glyph}
                    </span>
                  </div>
                  <div>
                    {snap.orch.epochCacheHit ? (
                      <span style={{ color: "var(--success-text)" }}>HIT (plan skipped)</span>
                    ) : (
                      <span style={{ color: "var(--warning-text)" }}>MISS (re-planned)</span>
                    )}
                  </div>
                  {(() => {
                    const cs = snap.orch.coldState;
                    if (!cs || cs.rebuilds + cs.cacheHits === 0) {
                      return <div style={{ color: "var(--text-muted)", marginTop: 4 }}>no events yet</div>;
                    }
                    const total = cs.rebuilds + cs.cacheHits;
                    const cumPct = (cs.cacheHits / total) * 100;
                    const winPct = Number.isNaN(cs.hitRate) ? null : cs.hitRate * 100;
                    return (
                      <>
                        <div style={{ marginTop: 4 }}>
                          Total: {cs.rebuilds} rebuilds · {cs.cacheHits} hits ({fmt(cumPct, 0)}%)
                        </div>
                        <div>
                          Last 1s: {cs.rebuildsLastSecond} rebuilds · {cs.hitsLastSecond} hits
                          {winPct !== null && (
                            <span style={{ color: "var(--text-muted)" }}> ({fmt(winPct, 0)}% hits)</span>
                          )}
                        </div>
                        {cs.rebuildsLastSecond > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ color: "var(--text-muted)" }}>Causes (1s): </span>
                            {(() => {
                              const entries = (Object.entries(cs.causeLastSecond) as [
                                keyof typeof cs.causeLastSecond, number,
                              ][])
                                .filter(([, n]) => n > 0)
                                .sort((a, b) => b[1] - a[1]);
                              if (entries.length === 0) {
                                return <span style={{ color: "var(--text-muted)" }}>—</span>;
                              }
                              return entries.map(([k, n], i) => (
                                <span key={k} style={{ marginRight: 6 }}>
                                  <span style={{
                                    color: k === "view" ? "var(--text-muted)" : "var(--warning-text)",
                                  }}>
                                    {k}:{n}
                                  </span>
                                  {i < entries.length - 1 && " "}
                                </span>
                              ));
                            })()}
                          </div>
                        )}
                        {cs.lastRebuildMs !== null && (
                          <div style={{ marginTop: 4 }}>
                            Build: {fmt(cs.lastRebuildMs, 1)}ms
                            {cs.rebuildP50Ms !== null && (
                              <span style={{ color: "var(--text-muted)" }}>
                                {" "}· p50 {fmt(cs.rebuildP50Ms, 1)}ms · p95{" "}
                                {fmt(cs.rebuildP95Ms ?? 0, 1)}ms
                              </span>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>

                {/* Upload (CPU → GPU) — per-tick + rolling. Per-tick
                    answers "what just happened?"; rolling answers "is
                    the upload path keeping up?". Resend ratio > 50%
                    means atlas thrashing; filter ratio > 50% means
                    decoded chunks aren't wanted by the GPU. */}
                {snap.upload.tick && (
                  <div className="debug-section" style={{
                    background: snap.upload.tick.budgetExhausted ? "var(--warning-surface)" : undefined,
                  }}>
                    <div className="debug-title">Upload (CPU → GPU)</div>
                    {(() => {
                      const t = snap.upload.tick;
                      const considered = t.drainedChunks;
                      const uploaded = t.uploadedChunks;
                      const skipBits = [
                        t.skippedPrefetch > 0 && `prefetch:${t.skippedPrefetch}`,
                        t.skippedWrongLod > 0 && `wrongLod:${t.skippedWrongLod}`,
                        t.skippedAlreadySent > 0 && `alreadySent:${t.skippedAlreadySent}`,
                        t.skippedNoMeta > 0 && `noMeta:${t.skippedNoMeta}`,
                      ].filter(Boolean) as string[];
                      const resendUploads = t.resendChunkUploads;
                      const bytePct = t.bytesBudget > 0
                        ? Math.min(100, Math.round((t.bytesUploaded / t.bytesBudget) * 100))
                        : 0;
                      return (
                        <>
                          <div>
                            Considered: {considered}
                          </div>
                          <div>
                            <span style={{ color: "var(--success-text)" }}>Uploaded: {uploaded}</span>
                          </div>
                          {skipBits.length > 0 && (
                            <div style={{ color: "var(--warning-text)", fontSize: 11 }}>
                              skipped: {skipBits.join(" · ")}
                            </div>
                          )}
                          <div style={{ marginTop: 4 }}>
                            Bytes: {fmtBytes(t.bytesUploaded)} / {fmtBytes(t.bytesBudget)} ({bytePct}%)
                            {t.budgetExhausted && (
                              <span style={{ color: "var(--danger-text)", marginLeft: 6 }}>EXHAUSTED</span>
                            )}
                          </div>
                          <div className="debug-bar-track">
                            <div className="debug-bar-fill" style={{
                              width: `${bytePct}%`,
                              background: t.budgetExhausted ? "var(--danger-text)" : "var(--success-text)",
                            }} />
                          </div>
                          {(resendUploads > 0
                            || t.resendChunksConsidered > 0) && (
                            <div style={{ marginTop: 4, fontSize: 11 }}>
                              <span style={{ color: "var(--text-muted)" }}>resend: </span>
                              <span style={{ color: resendUploads > 0 ? "var(--warning-text)" : "var(--text-muted)" }}>
                                {resendUploads} uploaded
                              </span>{" "}
                              <span style={{ color: "var(--text-muted)" }}>
                                ({t.resendChunksConsidered} considered)
                              </span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Upload — rolling stats */}
                {snap.upload.rolling && (
                  <div className="debug-section">
                    <div className="debug-title">Upload (rolling 1s)</div>
                    {(() => {
                      const r = snap.upload.rolling;
                      const fmtRatio = (n: number) =>
                        Number.isNaN(n) ? "—" : `${(n * 100).toFixed(0)}%`;
                      const resendBad = !Number.isNaN(r.resendRatio) && r.resendRatio > 0.5;
                      const filterBad = !Number.isNaN(r.filterRatio) && r.filterRatio > 0.5;
                      return (
                        <>
                          <div>
                            {fmtBytes(r.bytesPerSec)}/s · {r.uploadsPerSec} uploads/s
                          </div>
                          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                            {r.chunkUploadsPerSec} chunks/s
                          </div>
                          <div>
                            <span style={{ color: resendBad ? "var(--warning-text)" : "var(--text-muted)" }}>
                              resend: {fmtRatio(r.resendRatio)}
                            </span>
                            {" · "}
                            <span style={{ color: filterBad ? "var(--warning-text)" : "var(--text-muted)" }}>
                              filtered: {fmtRatio(r.filterRatio)}
                            </span>
                          </div>
                          {r.uploadSizeP50 !== null && (
                            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                              size p50: {fmtBytes(r.uploadSizeP50)}
                              {" · "}
                              p95: {fmtBytes(r.uploadSizeP95 ?? 0)}
                            </div>
                          )}
                          {r.budgetExhaustedTicksLastSecond > 0 && (
                            <div style={{ color: "var(--warning-text)", fontSize: 11 }}>
                              budget exhausted: {r.budgetExhaustedTicksLastSecond} tick(s) in last 1s
                            </div>
                          )}
                          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>
                            total: {fmtBytes(r.totalBytes)} ·{" "}
                            {r.totalUploads.toLocaleString()} uploads
                          </div>
                        </>
                      );
                    })()}
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
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
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
                            background: overlapStatus === "NONE" ? "var(--danger-surface)" : undefined,
                          }}>
                            <span className="debug-member-id" title={e.entityId}>
                              {e.entityId.length > 12 ? "..." + e.entityId.slice(-10) : e.entityId}
                            </span>
                            <span>pos:[{e.position[0]},{e.position[1]}]</span>
                            <span>full:[{e.fullShape ? e.fullShape.join(",") : "?"}]</span>
                            <span style={{ color: e.cachedKeys > 0 ? "var(--warning-text)" : "var(--text-muted)" }}>
                              cache:{e.cachedKeys}
                            </span>
                            <span style={{ color: overlapStatus === "NONE" ? "var(--danger-text)" : "var(--success-text)" }}>
                              {overlapStatus}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Active Set — mode tallies come from the uncapped
                    counters; the row list itself is capped upstream. */}
                {snap.orch.activeSet.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">
                      Active Set (
                      {snap.orch.activeSetModeCounts.tilesDetail} tiles-detail /
                      {" "}{snap.orch.activeSetModeCounts.invisible} invisible)
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
                      {snap.orch.activeSetTotal > 10 && (
                        <div className="debug-more">+{snap.orch.activeSetTotal - 10} more</div>
                      )}
                    </div>
                  </div>
                )}

                {/* Request summary by lane and level */}
                <div className="debug-section">
                  <div className="debug-title">Requests</div>
                  <div>
                    <span style={{ color: "var(--success-text)" }}>detail: {snap.orch.laneCount.detail}</span>
                    {" "}
                    <span style={{ color: "var(--info-text)" }}>coarse: {snap.orch.laneCount.coarse}</span>
                    {" "}
                    <span style={{ color: "var(--warning-text)" }}>prefetch: {snap.orch.laneCount.prefetch}</span>
                    {" "}
                    <span style={{ color: "var(--warning-text)" }}>minimap: {snap.orch.laneCount.minimap}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ color: "var(--text-muted)" }}>By level: </span>
                    {Object.entries(snap.orch.chunksByLevel)
                      .sort(([a], [b]) => Number(a) - Number(b))
                      .map(([lvl, count]) => (
                        <span key={lvl} style={{ marginRight: 8 }}>L{lvl}:{count}</span>
                      ))}
                  </div>
                </div>

                {/* Per-member adapter output */}
                {snap.orch.members.length > 0 && (
                  <div className="debug-section">
                    <div className="debug-title">Members (adapter output, {snap.orch.membersTotal} total)</div>
                    <div className="debug-member-list">
                      {snap.orch.members.slice(0, 10).map((m, i) => (
                        <div key={`${m.imageId}-${i}`} className="debug-member-row" style={{
                          background: m.mixedLevels ? "var(--danger-surface)" : undefined,
                        }}>
                          <span className="debug-member-id" title={m.imageId}>
                            {m.imageId.length > 14 ? "..." + m.imageId.slice(-12) : m.imageId}
                          </span>
                          <span>uploadL{m.uploadLevel ?? "?"}</span>
                          <span>n:{m.neededCount} p:{m.prefetchCount}</span>
                          <span title={`Levels: ${JSON.stringify(m.chunksByLevel)}`}>
                            {Object.entries(m.chunksByLevel).map(([l, c]) => `L${l}:${c}`).join(" ")}
                          </span>
                          {m.mixedLevels && <span style={{ color: "var(--danger-text)" }}>MIX</span>}
                        </div>
                      ))}
                      {snap.orch.membersTotal > 10 && (
                        <div className="debug-more">+{snap.orch.membersTotal - 10} more</div>
                      )}
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
                            color: r.lane === "detail" ? "var(--success-text)" : r.lane === "coarse" ? "var(--info-text)" : r.lane === "prefetch" ? "var(--warning-text)" : "var(--accent)",
                            width: 14,
                          }}>
                            {r.lane === "detail" ? "D" : r.lane === "coarse" ? "C" : r.lane === "prefetch" ? "P" : "O"}
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
                <div style={{ color: "var(--text-muted)" }}>Enable debug (D key) and load a dataset</div>
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
                <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
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
                <div style={{ color: "var(--danger-text)", marginTop: 4 }}>
                  {datasetHealthError}
                </div>
              )}
              {!datasetHealthLoading && !datasetHealthError && datasetHealthSnap.length === 0 && (
                <div style={{ color: "var(--text-muted)", marginTop: 4 }}>
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
                      ? "var(--danger-surface)"
                      : health.status === "degraded" ? "var(--warning-surface)" : undefined,
                  }}
                >
                  <div className="debug-title" style={{ color: statusColor(health.status) }}>
                    {health.name}
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 10 }} title={health.workspace_dataset_id}>
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
                      <span style={{ color: "var(--text-muted)" }}> ({health.binding.message})</span>
                    )}
                  </div>

                  {cache ? (
                    <div style={{ marginTop: 5 }}>
                      <div>
                        source cache: {fmtBytes(cache.current_bytes)} / {fmtBytes(cache.max_bytes)}
                        {" "}· {cache.used_percent}% · entries {cache.entry_count}
                      </div>
                      <div style={{ color: "var(--text-muted)" }}>
                        hits {cache.hits} · misses {cache.misses} · evictions {cache.evictions}
                        {cache.backend_errors > 0 && (
                          <span style={{ color: "var(--danger-text)" }}> · backend errors {cache.backend_errors}</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: "var(--text-muted)", marginTop: 5 }}>
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
                  <div style={{ color: "var(--text-muted)" }}>
                    chunks {generated.ready_chunks} ready · {generated.pending_chunks} pending ·{" "}
                    {generated.failed_chunks} failed · {generated.unavailable_chunks} unavailable
                  </div>
                  {generated.message && (
                    <div style={{ color: "var(--text-muted)" }}>{generated.message}</div>
                  )}
                  {generated.cache && (
                    <div style={{ color: "var(--text-muted)", marginTop: 3 }}>
                      generated cache: {generated.cache.storage} · {fmtBytes(generated.cache.current_bytes)} charged
                      {generated.cache.max_bytes !== undefined && generated.cache.max_bytes !== null && (
                        <> / {fmtBytes(generated.cache.max_bytes)}</>
                      )}
                      {generated.cache.used_percent !== undefined && generated.cache.used_percent !== null && (
                        <> · {generated.cache.used_percent}%</>
                      )}
                      {generated.cache.max_entries !== undefined && generated.cache.max_entries !== null && (
                        <> · entries {generated.cache.entry_count ?? 0} / {generated.cache.max_entries}
                          {generated.cache.entry_used_percent !== undefined && generated.cache.entry_used_percent !== null && (
                            <> ({generated.cache.entry_used_percent}%)</>
                          )}
                        </>
                      )}
                      {" "}· evictions {generated.cache.evictions}
                      {generated.cache.accounting_healthy === false && (
                        <span style={{ color: "var(--danger-text)" }}> · accounting unavailable; writes disabled</span>
                      )}
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
                        <div key={index} style={{ color: "var(--danger-text)" }} title={`${failure.image_id} ${failure.key}`}>
                          generated failure: {failure.status} L{failure.level_index} {shortId(failure.image_id, 18)}
                          {failure.message && <> · {failure.message}</>}
                        </div>
                      ))}
                    </div>
                  )}

                  {(health.messages ?? []).length > 0 && (
                    <div style={{ marginTop: 5 }}>
                      {(health.messages ?? []).map((message, index) => (
                        <div key={index} style={{ color: "var(--warning-text)" }}>
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

        {activeTab === "planning" && (
          <PlanningTabBody
            planning={snap.planning}
            datasets={datasets}
            renderLoopRef={renderLoopRef}
          />
        )}
        {activeTab === "config" && <ConfigTab />}

        {activeTab === "logging" && (
          <>
            <div className="debug-section" key={`cats-${loggingTick}`}>
              <div className="debug-title">Categories</div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 6 }}>
                Toggles persist in localStorage.debug. Most events fire after the
                page boots; for startup events, enable then reload.
              </div>
              {DEBUG_CATEGORIES.map(cat => {
                const on = isDebugEnabled(cat);
                return (
                  <label
                    key={cat}
                    aria-label={`Toggle ${cat} logging`}
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
                      <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                        {LOGGING_CATEGORY_DESCRIPTIONS[cat]}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="debug-section" key={`ovs-${loggingTick}`}>
              <div className="debug-title">Overlays</div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 6 }}>
                Visual layers drawn over the canvas. Slice + volume modes both work.
              </div>
              {DEBUG_OVERLAYS.map(name => {
                const on = isOverlayEnabled(name);
                return (
                  <label
                    key={name}
                    aria-label={`Toggle ${name} overlay`}
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
                      onChange={() => toggleOverlay(name)}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontFamily: "monospace" }}>{name}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                        {OVERLAY_DESCRIPTIONS[name]}
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
