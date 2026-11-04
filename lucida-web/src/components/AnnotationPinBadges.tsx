/**
 * Pin marker adornments shared by the 2D and 3D overlays. Both render as
 * children of the pin's wrapper, so reprojection, dimming, and the open-thread
 * z-lift carry them along.
 */
import type { Annotation } from "./annotationDocument.ts";
import { offContextLabel } from "./annotationContext.ts";

/** Comment-count pill, shown only when the pin has comments. Clicking toggles
 * the thread, like clicking the dot. */
export function CommentCountBadge({
  count,
  onToggleThread,
}: {
  count: number;
  onToggleThread: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div
      aria-label={`${count} comment${count === 1 ? "" : "s"}`}
      onClick={onToggleThread}
      style={{
        position: "absolute",
        top: -14,
        left: 4,
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        borderRadius: 8,
        backgroundColor: "#1f6feb",
        color: "white",
        fontSize: 11,
        lineHeight: "16px",
        textAlign: "center",
        fontWeight: 600,
        boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
        pointerEvents: "auto",
        cursor: "pointer",
      }}
    >
      {count}
    </div>
  );
}

/** Locator label for a pin on another Z/T/C; the caller gates on
 * `isOffContext`. Informational only: the marker still opens its thread. */
export function OffContextHelptext({ pin }: { pin: Annotation }) {
  return (
    <div
      data-testid={`annot-offcontext-${pin.id}`}
      title={`This pin lives on ${offContextLabel(pin)} — navigate there to edit it in place`}
      style={{
        position: "absolute",
        left: 10,
        top: -10,
        fontSize: 10,
        fontFamily: "monospace",
        color: "white",
        backgroundColor: "rgba(0,0,0,0.7)",
        padding: "1px 4px",
        borderRadius: 3,
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      {offContextLabel(pin)}
    </div>
  );
}
