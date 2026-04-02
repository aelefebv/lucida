import { useMemo } from "react";
import type { DatasetMember } from "../types.ts";

/** Plate metadata from `DatasetKind::Plate`, as serialized by serde. */
export interface PlateKind {
  rows: string[];
  columns: string[];
  wells: { path: string; row_index: number; column_index: number }[];
  positioning_mode: "stage" | "grid";
  has_stage_positions: boolean;
}

interface PlateSelectorProps {
  plateKind: PlateKind;
  members: DatasetMember[];
  plateName: string;
  onWellClick: (centerX: number, centerY: number) => void;
  onPositioningModeToggle?: () => void;
}

const CELL_SIZE = 24;
const CELL_GAP = 2;
const PADDING = 8;
const HEADER_HEIGHT = 20;
const TOGGLE_HEIGHT = 24;

export function PlateSelector({
  plateKind,
  members,
  plateName,
  onWellClick,
  onPositioningModeToggle,
}: PlateSelectorProps) {
  // Build a set of populated wells and a lookup from well path to member positions.
  // A well is populated if any member's storePrefix starts with the well path.
  const wellMemberMap = useMemo(() => {
    const map = new Map<string, DatasetMember[]>();
    for (const well of plateKind.wells) {
      const wellMembers = members.filter(
        (m) => m.storePrefix !== null && m.storePrefix.startsWith(well.path)
      );
      if (wellMembers.length > 0) {
        map.set(`${well.row_index},${well.column_index}`, wellMembers);
      }
    }
    return map;
  }, [plateKind.wells, members]);

  // Build a well lookup by (row, col) for grid rendering
  const wellPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const well of plateKind.wells) {
      map.set(`${well.row_index},${well.column_index}`, well.path);
    }
    return map;
  }, [plateKind.wells]);

  const handleWellClick = (rowIdx: number, colIdx: number) => {
    const key = `${rowIdx},${colIdx}`;
    const wellMembers = wellMemberMap.get(key);
    if (!wellMembers || wellMembers.length === 0) return;

    // Compute center as the average position of all members in this well
    let sumX = 0;
    let sumY = 0;
    for (const m of wellMembers) {
      sumX += m.position[0];
      sumY += m.position[1];
    }
    const centerX = sumX / wellMembers.length;
    const centerY = sumY / wellMembers.length;

    onWellClick(centerX, centerY);
  };

  const gridWidth =
    CELL_SIZE +
    CELL_GAP +
    plateKind.columns.length * (CELL_SIZE + CELL_GAP) -
    CELL_GAP;
  const panelWidth = Math.max(gridWidth + PADDING * 2, 100);
  const showToggle =
    plateKind.has_stage_positions && onPositioningModeToggle != null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: 16,
        zIndex: 10,
        background: "rgba(0, 0, 0, 0.7)",
        borderRadius: 6,
        padding: PADDING,
        color: "white",
        fontSize: 11,
        fontFamily: "system-ui, -apple-system, sans-serif",
        userSelect: "none",
        backdropFilter: "blur(4px)",
        border: "1px solid rgba(255, 255, 255, 0.1)",
        width: panelWidth,
      }}
    >
      {/* Plate name */}
      <div
        style={{
          height: HEADER_HEIGHT,
          lineHeight: `${HEADER_HEIGHT}px`,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: 600,
          marginBottom: 4,
          opacity: 0.8,
        }}
      >
        {plateName}
      </div>

      {/* Column headers */}
      <div
        style={{
          display: "flex",
          marginLeft: CELL_SIZE + CELL_GAP,
          marginBottom: 1,
        }}
      >
        {plateKind.columns.map((col) => (
          <div
            key={col}
            style={{
              width: CELL_SIZE,
              marginRight: CELL_GAP,
              textAlign: "center",
              fontSize: 9,
              opacity: 0.5,
            }}
          >
            {col}
          </div>
        ))}
      </div>

      {/* Grid rows */}
      {plateKind.rows.map((rowName, rowIdx) => (
        <div
          key={rowName}
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: CELL_GAP,
          }}
        >
          {/* Row label */}
          <div
            style={{
              width: CELL_SIZE,
              marginRight: CELL_GAP,
              textAlign: "center",
              fontSize: 9,
              opacity: 0.5,
            }}
          >
            {rowName}
          </div>

          {/* Well cells */}
          {plateKind.columns.map((_colName, colIdx) => {
            const key = `${rowIdx},${colIdx}`;
            const populated = wellMemberMap.has(key);
            const wellExists = wellPathMap.has(key);

            return (
              <button
                key={colIdx}
                disabled={!populated}
                onClick={() => populated && handleWellClick(rowIdx, colIdx)}
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  marginRight: CELL_GAP,
                  padding: 0,
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  borderRadius: 3,
                  background: populated
                    ? "rgba(255, 255, 255, 0.12)"
                    : "rgba(255, 255, 255, 0.03)",
                  color: populated
                    ? "rgba(255, 255, 255, 0.8)"
                    : "rgba(255, 255, 255, 0.2)",
                  fontSize: 8,
                  cursor: populated ? "pointer" : "default",
                  display: wellExists ? "flex" : "none",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.1s",
                  ...(populated
                    ? {}
                    : ({ pointerEvents: "none" } as const)),
                }}
                onMouseEnter={(e) => {
                  if (populated) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(100, 108, 255, 0.35)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (populated) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(255, 255, 255, 0.12)";
                  }
                }}
              >
                {populated
                  ? `${plateKind.rows[rowIdx]}${plateKind.columns[colIdx]}`
                  : ""}
              </button>
            );
          })}
        </div>
      ))}

      {/* Positioning toggle */}
      {showToggle && (
        <button
          onClick={onPositioningModeToggle}
          style={{
            marginTop: 4,
            width: "100%",
            height: TOGGLE_HEIGHT,
            padding: "0 8px",
            border: "1px solid rgba(255, 255, 255, 0.15)",
            borderRadius: 3,
            background: "rgba(255, 255, 255, 0.08)",
            color: "rgba(255, 255, 255, 0.7)",
            fontSize: 10,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(100, 108, 255, 0.25)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "rgba(255, 255, 255, 0.08)";
          }}
        >
          {plateKind.positioning_mode === "stage" ? "Stage" : "Grid"}
          {" \u2194 "}
          {plateKind.positioning_mode === "stage" ? "Grid" : "Stage"}
        </button>
      )}
    </div>
  );
}
