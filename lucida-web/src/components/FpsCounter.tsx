import { useEffect, useState } from "react";
import { frameClock, IDLE_AFTER_MS } from "../frameClock.ts";
import "./FpsCounter.css";

const UPDATE_INTERVAL_MS = 100;

/**
 * The rate the page draws at. It counts the frame clock's frames, so a still
 * page reads `– FPS` instead of being kept drawing just to be measured.
 */
export function FpsCounter() {
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    let frames = 0;
    let since: number | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = frameClock.subscribe((now) => {
      // The first frame after a pause opens a window instead of closing one
      // that spans the pause.
      if (since === null) {
        since = now;
        frames = 0;
        return;
      }
      frames++;
      const elapsed = now - since;
      if (elapsed < UPDATE_INTERVAL_MS) return;
      setFps(Math.round((frames * 1000) / elapsed));
      frames = 0;
      since = now;
      clearTimeout(idle);
      idle = setTimeout(() => {
        since = null;
        setFps(null);
      }, IDLE_AFTER_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(idle);
    };
  }, []);

  return <div className="lc-fps">{`${fps ?? "–"} FPS`}</div>;
}
