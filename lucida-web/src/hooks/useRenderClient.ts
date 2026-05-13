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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || clientRef.current) return;

    const client = new RenderClient(canvas);
    clientRef.current = client;
    client.ready().then(() => {
      setClientReady(true);
    }).catch(err => {
      console.error("Render worker init failed:", err);
      setRenderError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  // `client` is null until the worker init resolves; once it does,
  // setClientReady(true) re-renders this hook and the ref read picks up
  // the live RenderClient. The ref is the canonical home (mutation
  // happens inside the init effect); `client` is the gated read.
  // eslint-disable-next-line react-hooks/refs
  const client = clientReady ? clientRef.current : null;

  // eslint-disable-next-line react-hooks/refs
  return { canvasRef, clientRef, clientReady, client, loopRef, activeLoop, setActiveLoop, renderError };
}
