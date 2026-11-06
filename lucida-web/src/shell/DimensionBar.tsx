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
  t: number;
  dimT: number;
  onTChange: (t: number) => void;
}

/**
 * Z and time, and in 3D the focal depth, at the bottom of the canvas.
 * Channels live in the layer panel, where they composite and solo.
 */
export function DimensionBar({
  viewMode,
  z,
  dimZ,
  onZChange,
  t,
  dimT,
  onTChange,
}: DimensionBarProps) {
  const hasRows = dimZ > 1 || dimT > 1 || viewMode === "3d";
  if (!hasRows) return null;

  return (
    <Card padding="sm" className="dimension-controls" aria-label="Dimensions">
      <DimensionControls label="Z" value={z} max={dimZ} onChange={onZChange} disabled={viewMode === "3d"} />
      <DimensionControls label="T" value={t} max={dimT} onChange={onTChange} />
      {/* The near/far bias for where 3D chunks start loading; it means
          nothing in 2D. */}
      {viewMode === "3d" && <FocalDepthControl />}
    </Card>
  );
}
