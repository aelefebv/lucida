import { useMemo } from "react";
import type { DatasetManifest, DatasetKind, Entity, LayoutSpec } from "../manifestTypes.ts";
import "./CollectionSelector.css";

export interface CollectionKind {
  rows: string[];
  columns: string[];
  positioning_mode: string;
  has_explicit_positions: boolean;
}

interface PlacedMember {
  id: string;
  position: [number, number];
  rowIndex?: number;
  columnIndex?: number;
}

interface CollectionSelectorProps {
  collectionKind: CollectionKind;
  members: PlacedMember[];
  collectionName: string;
  onGroupClick: (centerX: number, centerY: number) => void;
  onPositioningModeToggle?: () => void;
}

/**
 * Extract CollectionKind and positioned members from a DatasetManifest.
 *
 * `activeLayoutPlacements`, when provided and non-empty, takes precedence
 * over the source default layout. Use this to make click-to-pan reflect
 * the currently active (possibly browser-authored) layout — the visual
 * row/col grid stays anchored to the collection's logical structure either way.
 *
 * Returns null if the dataset is not a collection.
 */
// Co-located with the CollectionSelector component that consumes it; the
// fast-refresh ergonomics cost is small vs splitting to a sibling.
// eslint-disable-next-line react-refresh/only-export-components
export function extractCollectionData(
  manifest: DatasetManifest,
  activeLayoutPlacements?: { entity_id: string; position: [number, number] }[] | null,
): { collectionKind: CollectionKind; members: PlacedMember[] } | null {
  if (manifest.kind === "Single") return null;
  if (typeof manifest.kind !== "object" || !("Collection" in manifest.kind)) return null;

  const collection = (manifest.kind as Exclude<DatasetKind, "Single">).Collection;
  const collectionKind: CollectionKind = {
    rows: collection.rows,
    columns: collection.columns,
    positioning_mode: collection.positioning_mode,
    has_explicit_positions: collection.has_explicit_positions,
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

  return { collectionKind, members };
}

const CELL_SIZE = 24;
const CELL_GAP = 2;
const PADDING = 8;
const BORDER_WIDTH = 1;
const HEADER_HEIGHT = 20;
const TOGGLE_HEIGHT = 24;

export function CollectionSelector({
  collectionKind,
  members,
  collectionName,
  onGroupClick,
  onPositioningModeToggle,
}: CollectionSelectorProps) {
  // Build a set of populated groups by matching entity IDs to group-like entities.
  // A group is populated if any member belongs to it (entity parent or label-based).
  const groupMemberMap = useMemo(() => {
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

  // Build a group lookup by (row, col) for grid rendering
  const groupPathMap = useMemo(() => {
    const map = new Map<string, string>();
    for (let r = 0; r < collectionKind.rows.length; r++) {
      for (let c = 0; c < collectionKind.columns.length; c++) {
        map.set(`${r},${c}`, `${collectionKind.rows[r]}/${collectionKind.columns[c]}`);
      }
    }
    return map;
  }, [collectionKind.rows, collectionKind.columns]);

  const handleGroupClick = (rowIdx: number, colIdx: number) => {
    const key = `${rowIdx},${colIdx}`;
    const groupMembers = groupMemberMap.get(key);
    if (!groupMembers || groupMembers.length === 0) return;

    // Compute center as the average position of all members in this group
    let sumX = 0;
    let sumY = 0;
    for (const m of groupMembers) {
      sumX += m.position[0];
      sumY += m.position[1];
    }
    const centerX = sumX / groupMembers.length;
    const centerY = sumY / groupMembers.length;

    onGroupClick(centerX, centerY);
  };

  const gridWidth =
    CELL_SIZE +
    CELL_GAP +
    collectionKind.columns.length * (CELL_SIZE + CELL_GAP) -
    CELL_GAP;
  // This is a border-box width: keep the unconstrained grid free of a
  // two-pixel incidental scrollbar while still letting the owner cap it.
  const panelWidth = Math.max(
    gridWidth + PADDING * 2 + BORDER_WIDTH * 2,
    100,
  );
  const showToggle =
    collectionKind.has_explicit_positions && onPositioningModeToggle != null;

  return (
    <div
      className="collection-selector-panel"
      data-floating-safe-region
      data-testid="collection-selector"
      role="region"
      aria-label={`${collectionName} collection navigation`}
      style={{
        background: "var(--overlay-panel)",
        borderRadius: 6,
        padding: PADDING,
        color: "white",
        fontSize: 11,
        fontFamily: "system-ui, -apple-system, sans-serif",
        userSelect: "none",
        backdropFilter: "blur(4px)",
        border: `${BORDER_WIDTH}px solid var(--border-translucent)`,
        boxSizing: "border-box",
        width: panelWidth,
        maxWidth: "100%",
        maxHeight: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Collection name */}
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
        {collectionName}
      </div>

      <div
        className="collection-selector-grid-scroll"
        data-testid="collection-selector-grid-scroll"
        data-overlay-scrollport
        role="group"
        aria-label="Collection positions"
        style={{ overflow: "auto", minWidth: 0, minHeight: 0 }}
      >
        {/* Column headers */}
        <div
          style={{
            display: "flex",
            marginLeft: CELL_SIZE + CELL_GAP,
            marginBottom: 1,
            width: gridWidth - CELL_SIZE - CELL_GAP,
          }}
        >
          {collectionKind.columns.map((col, colIdx) => (
            <div
              key={col}
              style={{
                flex: `0 0 ${CELL_SIZE}px`,
                marginRight: colIdx === collectionKind.columns.length - 1 ? 0 : CELL_GAP,
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
        {collectionKind.rows.map((rowName, rowIdx) => (
          <div
            key={rowName}
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: CELL_GAP,
              width: gridWidth,
            }}
          >
            {/* Row label */}
            <div
              style={{
                flex: `0 0 ${CELL_SIZE}px`,
                marginRight: CELL_GAP,
                textAlign: "center",
                fontSize: 9,
                opacity: 0.5,
              }}
            >
              {rowName}
            </div>

            {/* Group cells */}
            {collectionKind.columns.map((_colName, colIdx) => {
            const key = `${rowIdx},${colIdx}`;
            const populated = groupMemberMap.has(key);
            const groupExists = groupPathMap.has(key);

            return (
              <button
                key={colIdx}
                disabled={!populated}
                onClick={() => populated && handleGroupClick(rowIdx, colIdx)}
                aria-label={`Go to ${collectionKind.rows[rowIdx]}${collectionKind.columns[colIdx]}`}
                data-testid={`collection-cell-${rowIdx}-${colIdx}`}
                style={{
                  flex: `0 0 ${CELL_SIZE}px`,
                  height: CELL_SIZE,
                  marginRight: colIdx === collectionKind.columns.length - 1 ? 0 : CELL_GAP,
                  padding: 0,
                  border: "1px solid var(--border-translucent)",
                  borderRadius: 3,
                  background: populated
                    ? "var(--overlay-fill-hover)"
                    : "var(--surface-1)",
                  color: populated
                    ? "var(--focus-ring)"
                    : "var(--border-strong)",
                  fontSize: 8,
                  cursor: populated ? "pointer" : "default",
                  display: "flex",
                  visibility: groupExists ? "visible" : "hidden",
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
                      "var(--accent-surface)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (populated) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "var(--overlay-fill-hover)";
                  }
                }}
              >
                {populated
                  ? `${collectionKind.rows[rowIdx]}${collectionKind.columns[colIdx]}`
                  : ""}
              </button>
            );
            })}
          </div>
        ))}
      </div>

      {/* Positioning toggle */}
      {showToggle && (
        <button
          onClick={onPositioningModeToggle}
          style={{
            marginTop: 4,
            width: "100%",
            height: TOGGLE_HEIGHT,
            padding: "0 8px",
            border: "1px solid var(--border-translucent)",
            borderRadius: 3,
            background: "var(--overlay-fill-subtle)",
            color: "var(--text-secondary)",
            fontSize: 10,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "var(--accent-selection)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              "var(--overlay-fill-subtle)";
          }}
        >
          {collectionKind.positioning_mode === "Explicit" ? "Explicit positions" : "Grid layout"}
          {" \u2194 "}
          {collectionKind.positioning_mode === "Explicit" ? "Grid layout" : "Explicit positions"}
        </button>
      )}
    </div>
  );
}
