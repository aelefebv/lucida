/**
 * The small DOM adornments every pin marker carries, shared by the 2D
 * ({@link AnnotationOverlay}) and 3D ({@link AnnotationOverlay3D}) overlays so
 * a pin reads identically in both views:
 *
 * - {@link CommentCountBadge} — the notification-style pill showing how many
 *   comments a pin's thread holds (rendered only when there is at least one).
 *   Clicking it toggles the thread, exactly like clicking the dot.
 * - {@link OffContextHelptext} — the locator label on a pin that lives on a
 *   different Z/T/C than the current view (issue #779), naming where it
 *   actually lives in the exact contract form `slice <z> · t=<t> · ch=<c>`,
 *   mirroring the off-view peer cursor's badge.
 *
 * Both are children of the pin's wrapper (positioned relative to the marker),
 * so per-frame reprojection, off-context dimming, and the open-thread z-lift
 * all carry them along for free in either view.
 */
import type { Annotation } from "./annotationDocument.ts";
import { offContextLabel } from "./annotationContext.ts";

/** Comment-count pill at the pin's upper-right — only when the pin has at
 * least one comment. Clicking toggles the pin's thread (the same toggle the
 * dot performs). */
export function CommentCountBadge({
  count,
  onToggleThread,
}: {
  count: number;
  /** Toggle this pin's thread popover open/closed. */
  onToggleThread: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      aria-label={`${count} comment${count === 1 ? "" : "s"}`}
      onClick={onToggleThread}
      style={{
        position: "absolute",
        top: -14,
        left: 4,
        minWidth: 24,
        height: 24,
        minHeight: 24,
        padding: "0 4px",
        border: 0,
        borderRadius: 12,
        backgroundColor: "#1f6feb",
        color: "white",
        fontSize: 11,
        lineHeight: "24px",
        textAlign: "center",
        fontWeight: 600,
        boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
        pointerEvents: "auto",
        cursor: "pointer",
      }}
    >
      {count}
    </button>
  );
}

/** Off-context helptext (issue #779): rendered only when the pin lives on a
 * different Z/T/C than the current view (the caller gates on `isOffContext`).
 * The marker itself still renders + clicks (its thread still opens), so this is
 * purely an informative overlay. Absent entirely when the pin is on-context —
 * so an on-context pin carries NO `annot-offcontext-<id>` testid. */
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
