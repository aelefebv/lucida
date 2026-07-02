/**
 * Pure helpers for the label hover tooltip — kept out of `LabelTooltip.tsx` so
 * that file exports only its component (react-refresh wants component-only
 * modules). {@link LabelTooltip} renders these rows; the SliceViewer hover
 * settle builds them from `WasmScene::label_property`.
 */

/** One property row: a producer-declared key and its stringified value. */
export interface LabelTooltipRow {
  key: string;
  value: string;
}

/**
 * Flatten a `label_property` object (the parsed JSON `Map` from
 * `WasmScene::label_property`) into display rows. Nested objects/arrays are
 * `JSON.stringify`d; primitives are shown verbatim. Order follows the object's
 * own key order (producers usually author it meaningfully). A `null`/`undefined`
 * input (no such property row) yields an empty list — the tooltip then shows
 * just the id.
 */
export function labelPropertyRows(
  fields: Record<string, unknown> | null | undefined,
): LabelTooltipRow[] {
  if (!fields) return [];
  const rows: LabelTooltipRow[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    let value: string;
    if (raw === null) {
      value = "null";
    } else if (typeof raw === "object") {
      value = JSON.stringify(raw);
    } else {
      value = String(raw);
    }
    rows.push({ key, value });
  }
  return rows;
}
