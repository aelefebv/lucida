/**
 * The canvas tools: pan navigates, move places the selected layer by hand,
 * and the others draw an annotation.
 */
export const TOOLS = ["pan", "move", "point", "line", "box"] as const;
export type Tool = (typeof TOOLS)[number];
export type AnnotationKind = Exclude<Tool, "pan" | "move">;

/**
 * What a press on the canvas draws, or null when it navigates. Shift is a
 * quick override from the pan tool: it drops a point without switching. The
 * move tool draws nothing: its outline takes the presses that move the layer,
 * and a press anywhere else navigates.
 */
export function pressAnnotationKind(tool: Tool, shiftKey: boolean): AnnotationKind | null {
  if (tool === "pan") return shiftKey ? "point" : null;
  if (tool === "move") return null;
  return tool;
}

/** Whether a tool draws with a plain press, so a finger's press draws rather than pans. */
export function drawsOnPress(tool: Tool): boolean {
  return pressAnnotationKind(tool, false) !== null;
}

/** Whether a kind is drawn by dragging out a second vertex. */
export function isShapeKind(kind: AnnotationKind | null): kind is "line" | "box" {
  return kind === "line" || kind === "box";
}
