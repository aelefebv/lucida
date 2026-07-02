/**
 * Hover tooltip for a picked segmentation label — a small DOM overlay pinned
 * near the cursor showing `"<label name> #<id>"` and the label's
 * `image-label.properties` rows for that id.
 *
 * Pure presentational: the SliceViewer's debounced hover-settle does the pick +
 * sample + `WasmScene::label_property` and hands the resolved content here. It is
 * only rendered when there is something to show (a non-zero id on an effectively
 * visible label), so an empty/hidden pick renders nothing at all.
 *
 * Positioned in CSS pixels relative to the canvas wrapper (the same
 * absolute-in-`position:relative` overlay convention as
 * {@link AnnotationDraftOverlay}). `pointer-events: none` so it never steals the
 * pan/annotation gestures beneath it.
 */
import type { LabelTooltipRow } from "./labelTooltip.ts";

interface Props {
  /** Cursor X in CSS px, relative to the canvas wrapper. */
  x: number;
  /** Cursor Y in CSS px, relative to the canvas wrapper. */
  y: number;
  /** The label overlay's name (may be empty → shown as a positional fallback). */
  name: string;
  /** The picked integer id (always non-zero when the tooltip is shown). */
  value: number;
  /** Property key/value rows for this id (empty when the id declares none). */
  rows: LabelTooltipRow[];
  /** Optional colour swatch (CSS colour) from the label LUT — nice-to-have. */
  swatch?: string;
}

// Offset from the cursor so the pointer doesn't sit on top of the text.
const CURSOR_OFFSET = 14;

export function LabelTooltip({ x, y, name, value, rows, swatch }: Props) {
  const title = `${name && name.length > 0 ? name : "label"} #${value}`;
  return (
    <div
      // Marks the tooltip for tests / playtest inspection.
      data-testid="label-tooltip"
      style={{
        position: "absolute",
        left: x + CURSOR_OFFSET,
        top: y + CURSOR_OFFSET,
        maxWidth: 260,
        padding: "6px 8px",
        borderRadius: 6,
        background: "rgba(20, 20, 24, 0.92)",
        color: "#f2f2f4",
        font: "12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
        pointerEvents: "none",
        zIndex: 12,
        // Keep it off the very edge when the cursor nears the right/bottom.
        transform: "translateZ(0)",
        whiteSpace: "nowrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        {swatch && (
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: 2,
              background: swatch,
              border: "1px solid rgba(255,255,255,0.35)",
              flex: "0 0 auto",
            }}
          />
        )}
        <span data-testid="label-tooltip-title">{title}</span>
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 4, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8, rowGap: 1 }}>
          {rows.map((row) => (
            <div key={row.key} style={{ display: "contents" }}>
              <span style={{ color: "#a8a8b0" }}>{row.key}</span>
              <span style={{ textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
