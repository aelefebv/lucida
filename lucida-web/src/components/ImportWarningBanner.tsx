interface Props {
  /** Durable non-fatal import warnings for the current dataset open. Already
   *  capped upstream; `overflow` carries how many more occurred. */
  warnings: readonly string[];
  /** How many further distinct warnings occurred beyond `warnings` (the
   *  upstream retention cap). Folded into the "+ N more" summary and the total
   *  count so a flood is never under-reported. Defaults to none. */
  overflow?: number;
  /** Clears the collected warnings (hides this banner). */
  onDismiss: () => void;
}

/** Most individual notices shown before the rest collapse into a "+ N more"
 *  line. The scroll region caps height independently; this keeps the DOM small
 *  and the summary honest even under an unusually long list. */
const MAX_VISIBLE_WARNINGS = 5;

/**
 * Durable, dismissible amber banner for non-fatal import warnings reported
 * while opening a dataset (e.g. the sampled-label-discovery notice). Unlike a
 * progress flash, it stays visible after the open completes so the warning
 * reaches the user; it disappears only when the collected warnings clear — on
 * dismiss, when the specific open that warned fails, or on connection loss.
 *
 * Visibility is derived entirely from `warnings`: the parent owns the durable
 * list (in the session controller) and empties it on dismiss / failed open /
 * connection loss, so this component holds no state of its own.
 *
 * Layout is defensive: the notice list is capped and scrolls within a bounded
 * height so a long list can never cover the viewport, and the Dismiss control
 * sits outside that scroll region so it stays reachable no matter how many
 * warnings arrive. The top offset stacks this below the shared-view loading
 * banner (which occupies the same top-center slot) so both stay readable when
 * an open both restores a view and warns.
 */
export function ImportWarningBanner({ warnings, overflow = 0, onDismiss }: Props) {
  // Render whenever a warning fact exists — including the rare case where the
  // detailed list has emptied (its source's open failed) but a sibling
  // source's over-cap count survives. Hiding then would drop a real signal.
  if (warnings.length === 0 && overflow === 0) return null;

  const visible = warnings.slice(0, MAX_VISIBLE_WARNINGS);
  // Total is the retained list plus what the upstream cap elided; the "+ N
  // more" line accounts for both the locally-hidden notices and that overflow.
  const totalWarnings = warnings.length + overflow;
  const hiddenCount = totalWarnings - visible.length;

  return (
    <div
      role="status"
      data-testid="import-warning-banner"
      data-floating-safe-region
      style={{
        position: "absolute",
        // Below the loading banner (top: 12) so a co-visible restore banner
        // and this one do not occupy the same rectangle.
        top: 72,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        flexDirection: "column",
        background: "var(--warning-surface)",
        color: "var(--text-primary)",
        padding: "0.5rem 0.875rem",
        borderRadius: 6,
        border: "1px solid var(--warning-border)",
        fontSize: "0.85rem",
        zIndex: 50,
        maxWidth: 480,
        boxShadow: "var(--shadow-popover)",
      }}
    >
      <div>
        {totalWarnings === 1
          ? "Dataset opened with a warning."
          : `Dataset opened with ${totalWarnings} warnings.`}
      </div>
      <ul
        style={{
          margin: "0.4rem 0 0 1rem",
          padding: 0,
          listStyle: "disc",
          // Bound the list's height and let it scroll: a long list stays a
          // small, self-contained panel instead of growing over the viewport.
          maxHeight: 160,
          overflowY: "auto",
        }}
      >
        {visible.map((warning, index) => (
          <li
            key={`${index}:${warning}`}
            style={{ fontSize: "0.8rem", opacity: 0.92 }}
          >
            {warning}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <div style={{ marginTop: "0.25rem", fontSize: "0.8rem", opacity: 0.85 }}>
          + {hiddenCount} more
        </div>
      )}
      <button
        type="button"
        onClick={onDismiss}
        style={{
          // Outside the scroll region above, so it is always reachable.
          alignSelf: "flex-start",
          marginTop: 6,
          padding: "0.2rem 0.5rem",
          fontSize: "0.75rem",
          background: "transparent",
          color: "var(--text-primary)",
          border: "1px solid var(--border-strong)",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
