import "./PanelScrim.css";

/**
 * Dims what an overlay panel covers and closes it on a tap there. The tap
 * ends on the scrim, so it never reaches the canvas as a pan or a drawn point.
 */
export function PanelScrim({ onDismiss }: { onDismiss: () => void }) {
  return <div className="lc-panel-scrim" aria-hidden="true" data-testid="panel-scrim" onClick={onDismiss} />;
}
