/** Transient overlay showing fly-mode controls when fly camera activates. */
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 5_000;
const FADE_MS = 300;

export function FlyCameraHint({ visible, onDismiss }: Props) {
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

  // When visible becomes true, show the hint and start the auto-dismiss timer.
  // When visible becomes false (mode switched away), hide immediately.
  // The `visible` prop IS the external state we synchronize to — the
  // setState calls here implement the transition, they aren't a cascade.
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

  // Dismiss on any keydown while the hint is showing
  useEffect(() => {
    if (!show || fading) return;
    const handleKey = () => dismiss();
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [show, fading, dismiss]);

  if (!show) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "60%",
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
      WASD move &middot; QE up/down &middot; IKJLOU look &middot; Scroll speed
    </div>
  );
}
