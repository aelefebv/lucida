/**
 * The boxes of the floating controls in the slots of the canvas stage
 * (CanvasStage.tsx) that holds `inside`, in client coordinates, so a layer
 * over the canvas can keep clear of them. A hidden control's box is empty.
 */
export function floatingControlBoxes(inside: Element): DOMRect[] {
  const stage = inside.closest(".lc-canvas-stage");
  if (!stage) return [];
  const boxes: DOMRect[] = [];
  // A control that lets the pointer through, as the tool palette does while
  // it fills its slot to measure the room it has, is only as large as the
  // parts of it that take the pointer.
  const visit = (control: Element) => {
    if (getComputedStyle(control).pointerEvents !== "none") {
      boxes.push(control.getBoundingClientRect());
      return;
    }
    for (const part of control.children) visit(part);
  };
  for (const control of stage.querySelectorAll(".lc-canvas-slot > *")) visit(control);
  return boxes;
}
