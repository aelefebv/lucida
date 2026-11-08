import { useEffect, useRef, useState } from "react";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop } from "../renderLoop.ts";
import { webGpuUnavailableReason, type WebGpuUnavailableReason } from "../renderer/gpuContext.ts";
import type { GpuErrorKind } from "../renderer/workerProtocol.ts";
import { toast } from "../ui/toastQueue.ts";
import { gpuNotice } from "./gpuNotices.ts";

/** A browser without `navigator.gpu` is known not to draw before any worker starts. */
function lacksWebGpu(): boolean {
  return typeof navigator !== "undefined" && !(navigator as { gpu?: unknown }).gpu;
}

export function useRenderClient() {
  const [missingWebGpu] = useState(lacksWebGpu);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<RenderClient | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const loopRef = useRef<RenderLoop | null>(null);
  const [activeLoop, setActiveLoop] = useState<RenderLoop | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // `transferControlToOffscreen` is one-shot per <canvas>, so a destroyed
  // client's canvas can never host another. `canvasKey` is the canvas's React
  // `key`: cleanup bumps it, React swaps in a fresh element, and the effect
  // builds the next client against it. In practice only a StrictMode remount
  // exercises this.
  const [canvasKey, setCanvasKey] = useState(0);
  // A WeakSet, not a boolean, because the spent element is still attached when
  // the effect re-runs ahead of the keyed replacement committing.
  const transferredCanvasesRef = useRef<WeakSet<HTMLCanvasElement>>(new WeakSet());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || clientRef.current || missingWebGpu) return;
    if (transferredCanvasesRef.current.has(canvas)) {
      // Spent element. The canvasKey bump re-runs this against a fresh one.
      return;
    }
    transferredCanvasesRef.current.add(canvas);

    const client = new RenderClient(canvas);
    clientRef.current = client;
    let disposed = false;
    const noticesShownAt = new Map<GpuErrorKind, number>();
    const stopGpuStatus = client.onGpuStatus((status) => {
      if (disposed) return;
      if (status.type === "gpuFailed") {
        setRenderError(`${status.message}. Reload the page to try again.`);
        return;
      }
      const notice = gpuNotice(status, noticesShownAt, performance.now());
      if (notice) toast(notice);
    });
    // A test hook in every build, like the capture globals: the trace driver
    // and a headless browser reach the worker's device through it.
    const hooks = window as unknown as { __lucidaLoseGpuDevice?: () => void };
    const loseGpuDevice = () => client.loseDevice();
    hooks.__lucidaLoseGpuDevice = loseGpuDevice;
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
      // `disposed` stops a late settle from flipping state for a dead client.
      disposed = true;
      stopGpuStatus();
      if (hooks.__lucidaLoseGpuDevice === loseGpuDevice) delete hooks.__lucidaLoseGpuDevice;
      client.destroy();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      setClientReady(false);
      setCanvasKey(k => k + 1);
    };
  }, [canvasKey, missingWebGpu]);

  /** Set when the browser can't draw at all; the viewer explains instead of erroring. */
  const gpuUnavailable: WebGpuUnavailableReason | null = missingWebGpu
    ? "missing"
    : renderError
      ? webGpuUnavailableReason(renderError)
      : null;

  // `client` is null until the worker init resolves; once it does,
  // setClientReady(true) re-renders this hook and the ref read picks up
  // the live RenderClient. The ref is the canonical home (mutation
  // happens inside the init effect); `client` is the gated read.
  // eslint-disable-next-line react-hooks/refs
  const client = clientReady ? clientRef.current : null;

  // eslint-disable-next-line react-hooks/refs
  return { canvasRef, clientRef, clientReady, client, loopRef, activeLoop, setActiveLoop, renderError, gpuUnavailable, canvasKey };
}
