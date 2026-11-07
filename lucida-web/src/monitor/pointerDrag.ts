/**
 * A pointer drag tracked on the document, from a pointerdown until the
 * pointer lifts. The dock's resize handle and the timeline's brush both read
 * the pointer this way rather than on the element that started the drag, so
 * a pointer that leaves the element mid-drag still moves it and still ends
 * it where it lifts.
 */
export function trackPointerDrag(
  doc: Document,
  onMove: (event: PointerEvent) => void,
  onUp: (event: PointerEvent) => void,
): void {
  const up = (event: PointerEvent): void => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerup", up);
    onUp(event);
  };
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", up);
}
