/**
 * Pin marker adornments shared by the 2D and 3D overlays. Both render as
 * children of the pin's wrapper, so reprojection, dimming, and the open-thread
 * z-lift carry them along.
 */
import type { Annotation } from "./annotationDocument.ts";
import { offContextLabel } from "./annotationContext.ts";
import "./AnnotationOverlay.css";

/** Comment-count pill, shown only when the pin has comments. Clicking toggles
 * the thread, like clicking the dot. The marker's name carries the count, so
 * the pill is a wider pointer target and hidden from assistive technology. */
export function CommentCountBadge({
  count,
  onToggleThread,
}: {
  count: number;
  onToggleThread: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div className="lc-annotation-count" aria-hidden="true" onClick={onToggleThread}>
      {count}
    </div>
  );
}

/** Locator label for a pin on another Z/T/C; the caller gates on
 * `isOffContext`. Informational only: the marker still opens its thread. */
export function OffContextHelptext({ pin }: { pin: Annotation }) {
  return (
    <div
      className="lc-annotation-locator"
      data-testid={`annot-offcontext-${pin.id}`}
      title={`This pin lives on ${offContextLabel(pin)} — navigate there to edit it in place`}
    >
      {offContextLabel(pin)}
    </div>
  );
}
