import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DatasetManifest, DatasetKind, Entity, LayoutSpec } from "../manifestTypes.ts";
import { buildManifestIndex, entityExtent, type VoxelRect } from "../pipeline/layoutBuilders.ts";
import { usePreference } from "../theme/preferences.ts";
import { Button } from "../ui/Button.tsx";
import { PanelHeader } from "../ui/PanelHeader.tsx";
import { CanvasCard } from "./CanvasCard.tsx";
import { navigatorCardPreference } from "./canvasCards.ts";
import { groupAt, unionRects } from "./groupFraming.ts";
import { frameClock } from "../frameClock.ts";
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
  /** What the 2D view draws for this member; null when it draws nothing. */
  bounds: VoxelRect | null;
  rowIndex?: number;
  columnIndex?: number;
}

interface CollectionSelectorProps {
  collectionKind: CollectionKind;
  members: PlacedMember[];
  collectionName: string;
  onGroupClick: (bounds: VoxelRect) => void;
  /**
   * The 2D view's center in the members' coordinates, or null before there is
   * a view. Read every frame while the card shows, to mark the group the view
   * is on.
   */
  getViewCenter?: () => ArrayLike<number> | null;
  onPositioningModeToggle?: () => void;
  /**
   * `card` floats over the canvas; `panel` fills a panel, with cells sized
   * for a finger where there is room. Default `card`.
   */
  variant?: "card" | "panel";
  /** Whether the panel shows; a hidden one draws nothing. Panel only. */
  visible?: boolean;
}

/**
 * Extract CollectionKind and positioned members from a DatasetManifest.
 *
 * Non-empty `activeLayoutPlacements` take precedence over the source default
 * layout, so clicking a group frames it where the active layout put it. The
 * row/col grid stays on the collection's logical structure either way.
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

  const members: PlacedMember[] = [];
  const placements: { entity_id: string; position: [number, number] }[] | undefined =
    activeLayoutPlacements && activeLayoutPlacements.length > 0
      ? activeLayoutPlacements
      : (
          manifest.source_layouts.find((l: LayoutSpec) => l.id === manifest.default_layout_id)
          ?? manifest.source_layouts[0]
        )?.placements;

  if (placements) {
    const index = buildManifestIndex(manifest);
    const entityById = new Map<string, Entity>();
    for (const e of manifest.entities) {
      if (!entityById.has(e.id)) entityById.set(e.id, e);
    }
    for (const placement of placements) {
      const entity = entityById.get(placement.entity_id);
      if (entity) {
        const labels = entity.labels as Record<string, unknown>;
        const extent = entityExtent(index, entity.id);
        const [x, y] = placement.position;
        members.push({
          id: entity.id,
          position: placement.position,
          bounds: extent && {
            min: [x + extent.min[0], y + extent.min[1]],
            max: [x + extent.max[0], y + extent.max[1]],
          },
          rowIndex: typeof labels.row_index === "number" ? labels.row_index : undefined,
          columnIndex: typeof labels.column_index === "number" ? labels.column_index : undefined,
        });
      }
    }
  } else {
    // Fallback: use image IDs with zero position
    for (const img of manifest.images) {
      members.push({ id: img.image_id, position: [0, 0], bounds: null });
    }
  }

  return { collectionKind, members };
}

/** Cell edge in CSS pixels. Denser grids get smaller cells, so the card stays a corner of the canvas. */
function cellSize(columns: number): number {
  if (columns <= 12) return 20;
  if (columns <= 24) return 14;
  return 10;
}

/**
 * The largest cell edge in a panel: a finger's width, and the touch target
 * size where the pointer is coarse. The grid shrinks it to fit a wide
 * collection (CollectionSelector.css).
 */
const PANEL_CELL = 40;
const PANEL_CELL_CSS = `max(${PANEL_CELL}px, var(--lc-target-min))`;

const groupKey = (row: number, column: number) => `${row},${column}`;

export function CollectionSelector({
  collectionKind,
  members,
  collectionName,
  onGroupClick,
  getViewCenter,
  onPositioningModeToggle,
  variant = "card",
  visible = true,
}: CollectionSelectorProps) {
  const { rows, columns } = collectionKind;
  const [cardState] = usePreference(navigatorCardPreference);
  const panel = variant === "panel";

  // Members by the group their row and column labels put them in.
  const groupMembers = useMemo(() => {
    const map = new Map<string, PlacedMember[]>();
    for (const member of members) {
      if (member.rowIndex != null && member.columnIndex != null) {
        const key = groupKey(member.rowIndex, member.columnIndex);
        const existing = map.get(key) ?? [];
        existing.push(member);
        map.set(key, existing);
      }
    }
    return map;
  }, [members]);

  // What a click frames and what the view center is tested against. Groups
  // outside the grid have no cell to mark, so they are left out.
  const groups = useMemo(() => {
    const out: { key: string; name: string; bounds: VoxelRect }[] = [];
    rows.forEach((row, r) =>
      columns.forEach((column, c) => {
        const key = groupKey(r, c);
        const bounds = unionRects((groupMembers.get(key) ?? []).map((m) => m.bounds));
        if (bounds) out.push({ key, name: `${row}${column}`, bounds });
      }),
    );
    return out;
  }, [rows, columns, groupMembers]);

  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const getViewCenterRef = useRef(getViewCenter);
  useEffect(() => {
    getViewCenterRef.current = getViewCenter;
  });

  // The camera moves without a React render, so the mark follows it on the
  // frame clock and re-renders only when the group changes.
  const watching = (panel ? visible : cardState !== "hidden") && getViewCenter !== undefined;
  useEffect(() => {
    if (!watching) return;
    let lastX = NaN;
    let lastY = NaN;
    return frameClock.subscribe(() => {
      const center = getViewCenterRef.current?.();
      if (center && center.length >= 2 && (center[0] !== lastX || center[1] !== lastY)) {
        lastX = center[0];
        lastY = center[1];
        setCurrentKey(groupAt(groups, [lastX, lastY]));
      }
    });
  }, [watching, groups]);

  const handleGroupClick = (key: string) => {
    const bounds = groups.find((g) => g.key === key)?.bounds;
    if (bounds) onGroupClick(bounds);
  };

  const current = currentKey === null ? undefined : groups.find((g) => g.key === currentKey);
  const cell = panel ? PANEL_CELL : cellSize(columns.length);
  // Below 14px a column number is wider than its cell, so every other one shows.
  const labelStep = cell < 14 ? 2 : 1;
  const gridStyle = {
    "--navigator-columns": columns.length,
    "--navigator-cell": panel ? PANEL_CELL_CSS : `${cell}px`,
    "--navigator-gap": cell < 14 ? "2px" : "var(--lc-space-1)",
  } as CSSProperties;
  const showToggle = collectionKind.has_explicit_positions && onPositioningModeToggle != null;
  const explicit = collectionKind.positioning_mode === "Explicit";

  const body = (
    <>
      <div className="lc-navigator-grid" role="group" aria-label="Groups" style={gridStyle}>
        <span aria-hidden="true" />
        {columns.map((column, c) => (
          <span key={`column-${c}`} className="lc-navigator-axis" aria-hidden="true">
            {c % labelStep === 0 ? column : ""}
          </span>
        ))}
        {rows.map((row, r) => (
          <Fragment key={`row-${r}`}>
            <span className="lc-navigator-axis" data-axis="row" aria-hidden="true">
              {row}
            </span>
            {columns.map((column, c) => {
              const key = groupKey(r, c);
              const name = `${row}${column}`;
              return (
                <button
                  key={key}
                  type="button"
                  className="lc-navigator-cell"
                  aria-label={name}
                  title={name}
                  aria-current={key === currentKey ? "location" : undefined}
                  disabled={!groupMembers.has(key)}
                  onClick={() => handleGroupClick(key)}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      {showToggle && (
        <Button size="sm" onPress={onPositioningModeToggle} className="lc-navigator-toggle">
          {explicit ? "Explicit positions" : "Grid layout"}
          {" ↔ "}
          {explicit ? "Grid layout" : "Explicit positions"}
        </Button>
      )}
    </>
  );

  if (panel) {
    if (!visible) return null;
    return (
      <div className="lc-navigator-panel">
        <PanelHeader title={collectionName} meta={current?.name} />
        <div className="lc-navigator-panel-body">{body}</div>
      </div>
    );
  }
  return (
    <CanvasCard
      title={collectionName}
      meta={current?.name}
      label="Collection selector"
      preference={navigatorCardPreference}
      padding="sm"
    >
      {body}
    </CanvasCard>
  );
}

