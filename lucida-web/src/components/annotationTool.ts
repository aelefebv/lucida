/** The canvas tools: pan navigates, the others draw an annotation. */
export const TOOLS = ["pan", "point", "line", "box"] as const;
export type Tool = (typeof TOOLS)[number];
export type AnnotationKind = Exclude<Tool, "pan">;

/**
 * What a press on the canvas draws, or null when it navigates. Shift is a
 * quick override from the pan tool: it drops a point without switching.
 */
export function pressAnnotationKind(tool: Tool, shiftKey: boolean): AnnotationKind | null {
  if (tool !== "pan") return tool;
  return shiftKey ? "point" : null;
}

/** Whether a kind is drawn by dragging out a second vertex. */
export function isShapeKind(kind: AnnotationKind | null): kind is "line" | "box" {
  return kind === "line" || kind === "box";
}
