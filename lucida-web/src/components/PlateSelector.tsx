import { useMemo } from "react";
import type { DatasetManifest, DatasetKind, Entity, LayoutSpec } from "../manifestTypes.ts";

/** Plate metadata extracted from DatasetKind::Plate. */
export interface PlateKind {
  rows: string[];
  columns: string[];
  positioning_mode: string;
  has_stage_positions: boolean;
}

/** A positioned member for the plate grid. */
interface PlacedMember {
  id: string;
  position: [number, number];
  rowIndex?: number;
  columnIndex?: number;
}

interface PlateSelectorProps {
  plateKind: PlateKind;
  members: PlacedMember[];
  plateName: string;
  onWellClick: (centerX: number, centerY: number) => void;
  onPositioningModeToggle?: () => void;
}

/**
 * Extract PlateKind and positioned members from a DatasetManifest.
 *
 * `activeLayoutPlacements`, when provided and non-empty, takes precedence
 * over the source default layout. Use this to make click-to-pan reflect
 * the currently active (possibly browser-authored) layout — the visual
 * row/col grid stays anchored to the plate's logical structure either way.
 *
 * Returns null if the dataset is not a plate.
 */
// Co-located with the PlateSelector component that consumes it; the
// fast-refresh ergonomics cost is small vs splitting to a sibling.
// eslint-disable-next-line react-refresh/only-export-components
export function extractPlateData(
  manifest: DatasetManifest,
  activeLayoutPlacements?: { entity_id: string; position: [number, number] }[] | null,
): { plateKind: PlateKind; members: PlacedMember[] } | null {
  if (manifest.kind === "Single") return null;
  if (typeof manifest.kind !== "object" || !("Plate" in manifest.kind)) return null;

  const plate = (manifest.kind as Exclude<DatasetKind, "Single">).Plate;
  const plateKind: PlateKind = {
    rows: plate.rows,
    columns: plate.columns,
    positioning_mode: plate.positioning_mode,
    has_stage_positions: plate.has_stage_positions,
  };

  // Derive members from entities + the supplied placements (or fall back
  // to the source default layout if none provided).
  const members: PlacedMember[] = [];
  const placements: { entity_id: string; position: [number, number] }[] | undefined =
    activeLayoutPlacements && activeLayoutPlacements.length > 0
      ? activeLayoutPlacements
      : (
          manifest.source_layouts.find((l: LayoutSpec) => l.id === manifest.default_layout_id)
          ?? manifest.source_layouts[0]
        )?.placements;

  if (placements) {
    for (const placement of placements) {
      const entity = manifest.entities.find((e: Entity) => e.id === placement.entity_id);
      if (entity) {
        const labels = entity.labels as Record<string, unknown>;
        members.push({
          id: entity.id,
          position: placement.position,
          rowIndex: typeof labels.row_index === "number" ? labels.row_index : undefined,
          columnIndex: typeof labels.column_index === "number" ? labels.column_index : undefined,
        });
      }
    }
  } else {
    // Fallback: use image IDs with zero position
    for (const img of manifest.images) {
      members.push({ id: img.image_id, position: [0, 0] });
    }
  }

  return { plateKind, members };
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
  // Build a set of populated wells by matching entity IDs to well-like entities.
  // A well is populated if any member belongs to it (entity parent or label-based).
  const wellMemberMap = useMemo(() => {
    const map = new Map<string, PlacedMember[]>();
    for (const member of members) {
      if (member.rowIndex != null && member.columnIndex != null) {
        const key = `${member.rowIndex},${member.columnIndex}`;
        const existing = map.get(key) ?? [];
        existing.push(member);
        map.set(key, existing);
      }
    }
    return map;
  }, [members]);

  // Build a well lookup by (row, col) for grid rendering
  const wellPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (let r = 0; r < plateKind.rows.length; r++) {
      for (let c = 0; c < plateKind.columns.length; c++) {
        map.set(`${r},${c}`, `${plateKind.rows[r]}/${plateKind.columns[c]}`);
      }
    }
    return map;
  }, [plateKind.rows, plateKind.columns]);

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
                  display: "flex",
                  visibility: wellExists ? "visible" : "hidden",
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
