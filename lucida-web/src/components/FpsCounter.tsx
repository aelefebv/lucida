import { useEffect, useRef, useState } from "react";

const UPDATE_INTERVAL_MS = 100;

export function FpsCounter() {
  const [fps, setFps] = useState(0);
  const frameCount = useRef(0);
  // performance.now() at mount seeds the rolling FPS window. useRef's
  // initializer runs exactly once per component instance, so the impurity
  // doesn't leak across renders.
  // eslint-disable-next-line react-hooks/purity
  const lastTime = useRef(performance.now());

  useEffect(() => {
    let id: number;
    const tick = () => {
      frameCount.current++;
      const now = performance.now();
      const elapsed = now - lastTime.current;
      if (elapsed >= UPDATE_INTERVAL_MS) {
        setFps(Math.round((frameCount.current * 1000) / elapsed));
        frameCount.current = 0;
        lastTime.current = now;
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 10,
        background: "rgba(0, 0, 0, 0.5)",
        color: "white",
        fontFamily: "monospace",
        fontSize: 12,
        padding: "2px 6px",
        borderRadius: 4,
        pointerEvents: "none",
      }}
    >
      {fps} FPS
    </div>
  );
}
