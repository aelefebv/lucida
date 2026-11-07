import { Banner } from "../shell/Banner.tsx";

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
  const details = hiddenCount > 0 ? [...visible, `+ ${hiddenCount} more`] : visible;

  return (
    <Banner tone="warning" details={details} onDismiss={onDismiss} data-testid="import-warning-banner">
      {totalWarnings === 1 ? "Dataset opened with a warning." : `Dataset opened with ${totalWarnings} warnings.`}
    </Banner>
  );
}
