import { DimensionControls } from "../components/DimensionControls.tsx";
import { FocalDepthControl } from "../components/FocalDepthControl.tsx";
import { Card } from "../ui/Card.tsx";
import "./DimensionBar.css";

export interface DimensionBarProps {
  viewMode: "2d" | "3d";
  z: number;
  /** Planes along Z; the Z row shows only when there is more than one. */
  dimZ: number;
  onZChange: (z: number) => void;
  c: number;
  dimC: number;
  onCChange: (c: number) => void;
  t: number;
  dimT: number;
  onTChange: (t: number) => void;
  /** Composite of every channel, rather than the one at `c`. */
  multiChannel: boolean;
  onMultiChannelToggle: () => void;
}

/** Z, channel, and time, and in 3D the focal depth, at the bottom of the canvas. */
export function DimensionBar({
  viewMode,
  z,
  dimZ,
  onZChange,
  c,
  dimC,
  onCChange,
  t,
  dimT,
  onTChange,
  multiChannel,
  onMultiChannelToggle,
}: DimensionBarProps) {
  const hasRows = dimZ > 1 || dimC > 1 || dimT > 1 || viewMode === "3d";
  if (!hasRows) return null;

  return (
    <Card padding="sm" className="dimension-controls" aria-label="Dimensions">
      <DimensionControls label="Z" value={z} max={dimZ} onChange={onZChange} disabled={viewMode === "3d"} />
      {multiChannel ? (
        dimC > 1 && (
          <div className="dim-control">
            <span className="dim-label">C</span>
            <button
              className="dim-btn dim-btn-wide"
              aria-pressed="true"
              onClick={onMultiChannelToggle}
              title="Switch to single-channel mode"
            >
              Multi
            </button>
          </div>
        )
      ) : (
        <div className="dim-control-group">
          <DimensionControls label="C" value={c} max={dimC} onChange={onCChange} />
          {dimC > 1 && (
            <button
              className="dim-btn dim-btn-wide"
              aria-pressed="false"
              onClick={onMultiChannelToggle}
              title="Switch to multi-channel composite mode"
            >
              Multi
            </button>
          )}
        </div>
      )}
      <DimensionControls label="T" value={t} max={dimT} onChange={onTChange} />
      {/* The near/far bias for where 3D chunks start loading; it means
          nothing in 2D. */}
      {viewMode === "3d" && <FocalDepthControl />}
    </Card>
  );
}
