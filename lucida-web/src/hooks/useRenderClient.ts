import { useEffect, useRef, useState } from "react";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop } from "../renderLoop.ts";

export function useRenderClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<RenderClient | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const loopRef = useRef<RenderLoop | null>(null);
  const [activeLoop, setActiveLoop] = useState<RenderLoop | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // `transferControlToOffscreen` (inside the RenderClient constructor) is
  // one-shot per <canvas> element, so a destroyed client's canvas can never
  // host another client. `canvasKey` feeds the canvas element's React `key`:
  // the cleanup bumps it, React swaps in a fresh element, and the effect
  // (keyed on the same value) builds the next client against that element.
  // In production the bump only happens while unmounting (a no-op); in dev,
  // StrictMode's mount→cleanup→mount cycle exercises the full replacement.
  const [canvasKey, setCanvasKey] = useState(0);
  // Canvas elements whose control has already been transferred to a GPU
  // worker. Tracked per element (WeakSet, not a boolean) because the spent
  // element is still attached when the effect re-runs ahead of the keyed
  // replacement committing.
  const transferredCanvasesRef = useRef<WeakSet<HTMLCanvasElement>>(new WeakSet());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || clientRef.current) return;
    if (transferredCanvasesRef.current.has(canvas)) {
      // This element already gave its control to a (since destroyed)
      // client. The canvasKey bump from that client's cleanup re-renders
      // with a fresh element and re-runs this effect against it.
      return;
    }
    transferredCanvasesRef.current.add(canvas);

    const client = new RenderClient(canvas);
    clientRef.current = client;
    let disposed = false;
    client.ready().then(() => {
      if (!disposed) setClientReady(true);
    }).catch(err => {
      // Once disposed, rejection is the expected settle path (destroy()
      // rejects a still-pending ready()), not an init failure to report.
      if (!disposed) {
        console.error("Render worker init failed:", err);
        setRenderError(err instanceof Error ? err.message : String(err));
      }
    });

    return () => {
      // Shut down the GPU worker and settle its pending promises; guard
      // the ready()/error callbacks above so a late settle can't flip
      // state for a client that no longer exists.
      disposed = true;
      client.destroy();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      setClientReady(false);
      // Request a fresh canvas element for any subsequent setup (the one
      // this client used is spent — see the canvasKey note above).
      setCanvasKey(k => k + 1);
    };
  }, [canvasKey]);

  // `client` is null until the worker init resolves; once it does,
  // setClientReady(true) re-renders this hook and the ref read picks up
  // the live RenderClient. The ref is the canonical home (mutation
  // happens inside the init effect); `client` is the gated read.
  // eslint-disable-next-line react-hooks/refs
  const client = clientReady ? clientRef.current : null;

  // eslint-disable-next-line react-hooks/refs
  return { canvasRef, clientRef, clientReady, client, loopRef, activeLoop, setActiveLoop, renderError, canvasKey };
}
