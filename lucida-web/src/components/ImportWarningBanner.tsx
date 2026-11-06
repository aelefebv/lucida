interface Props {
  /** Durable non-fatal import warnings for the current dataset open. Already
   *  capped upstream; `overflow` carries how many more occurred. */
  warnings: readonly string[];
  /** Distinct warnings beyond the upstream cap. Counted in the "+ N more" line
   *  so a flood is never under-reported. */
  overflow?: number;
  /** Clears the collected warnings (hides this banner). */
  onDismiss: () => void;
}

/** Notices shown before the rest collapse into a "+ N more" line, keeping the
 *  DOM small under a long list. */
const MAX_VISIBLE_WARNINGS = 5;

/**
 * Dismissible banner for non-fatal import warnings from a dataset open. It
 * outlives the open so the warning reaches the user. The parent owns the list
 * (in the session controller) and empties it on dismiss, a failed open, or
 * connection loss, so this component holds no state.
 *
 * The list scrolls within a bounded height so it can't cover the viewport, and
 * Dismiss sits outside the scroll region so it stays reachable.
 */
export function ImportWarningBanner({ warnings, overflow = 0, onDismiss }: Props) {
  // Overflow alone still renders: the detailed list can empty (its open
  // failed) while a sibling source's over-cap count survives.
  if (warnings.length === 0 && overflow === 0) return null;

  const visible = warnings.slice(0, MAX_VISIBLE_WARNINGS);
  const totalWarnings = warnings.length + overflow;
  const hiddenCount = totalWarnings - visible.length;

  return (
    <div
      role="status"
      data-testid="import-warning-banner"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#5a3a00",
        color: "#fff",
        padding: "0.5rem 0.875rem",
        borderRadius: 6,
        border: "1px solid #b88500",
        fontSize: "0.85rem",
        maxWidth: "min(480px, 100%)",
        boxSizing: "border-box",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
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
          alignSelf: "flex-start",
          marginTop: 6,
          padding: "0.2rem 0.5rem",
          fontSize: "0.75rem",
          background: "transparent",
          color: "#fff",
          border: "1px solid #888",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
