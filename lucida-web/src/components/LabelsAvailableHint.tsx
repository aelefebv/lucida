/**
 * Transient one-time hint announcing that the just-opened dataset ships
 * segmentation labels the user can toggle on. Mirrors {@link FlyCameraHint}'s
 * transient pattern exactly (auto-dismiss after a few seconds, dismiss on any
 * keydown, fade-out), so the two ephemeral overlays feel identical.
 *
 * Discoverability, not obstruction: labels default OFF, so without this nudge a
 * user might never notice a labelled dataset has masks available. It states the
 * count and points at the Labels section, then gets out of the way.
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  /** Turn on to show the hint (e.g. first open of a labelled dataset). */
  visible: boolean;
  /** How many labels the dataset has — surfaced in the message. */
  count: number;
  /** Called once the hint has fully faded out, so the parent can latch it off. */
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 6_000;
const FADE_MS = 300;

export function LabelsAvailableHint({ visible, count, onDismiss }: Props) {
  const [show, setShow] = useState(false);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<number>(0);

  const dismiss = useCallback(() => {
    setFading(true);
    clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setShow(false);
      setFading(false);
      onDismiss();
    }, FADE_MS);
  }, [onDismiss]);

  // When `visible` flips true, show + start the auto-dismiss timer. When it
  // flips false, hide immediately. `visible` IS the external state we
  // synchronize to — the setState calls implement the transition, mirroring
  // FlyCameraHint (they aren't a render cascade).
  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(true);
      setFading(false);
      clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    } else {
      clearTimeout(timerRef.current);
      setShow(false);
      setFading(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [visible, dismiss]);

  // Dismiss on any keydown while showing (same as FlyCameraHint).
  useEffect(() => {
    if (!show || fading) return;
    const handleKey = () => dismiss();
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [show, fading, dismiss]);

  if (!show) return null;

  const noun = count === 1 ? "label" : "labels";
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        left: "50%",
        top: "12%",
        transform: "translateX(-50%)",
        background: "rgba(0, 0, 0, 0.7)",
        color: "white",
        fontSize: 14,
        padding: "8px 16px",
        borderRadius: 8,
        pointerEvents: "none",
        zIndex: 10,
        whiteSpace: "nowrap",
        opacity: fading ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
      }}
    >
      {`This dataset has ${count} ${noun} — open the Labels section to show ${count === 1 ? "it" : "them"}.`}
    </div>
  );
}
