/**
 * Debug HUD overlay — renders stats from debugStats as an HTML overlay
 * on top of the canvas. Polls at ~200ms intervals for low overhead.
 */
import { useEffect, useState } from "react";
import { debugStats, type DebugStats } from "./debugStats.ts";
import "./DebugOverlay.css";

const POLL_INTERVAL_MS = 200;

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

export function DebugOverlay() {
  const [snap, setSnap] = useState<DebugStats>({ ...debugStats });

  useEffect(() => {
    const id = setInterval(() => {
      setSnap({ ...debugStats, memberStats: [...debugStats.memberStats] });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

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
    </div>
  );
}
