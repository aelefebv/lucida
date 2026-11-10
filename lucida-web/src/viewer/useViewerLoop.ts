/**
 * The page's one render loop, which draws every view in its own mode. It is
 * made once the session, the client and the canvas exist, and a change of
 * mode or layout keeps it.
 */
import { useEffect, type RefObject } from "react";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { RenderClient } from "../renderer/renderClient.ts";
import type { Session } from "../session.ts";

/** What the loop draws with, once all of it exists. */
export interface ViewerLoopParts {
  session: Session;
  /** The live map the loop reads each frame, so a change to it never re-makes the loop. */
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
}

/**
 * Run the loop while `parts` exist, published through `loopRef` and
 * `onLoopChange` for the rest of the page. `remoteDocumentVersion` is a
 * peer's document edit, which the next frame draws.
 */
export function useViewerLoop(
  parts: ViewerLoopParts | null,
  loopRef: RefObject<RenderLoop | null>,
  onLoopChange: (loop: RenderLoop | null) => void,
  remoteDocumentVersion: number,
): void {
  const session = parts?.session;
  const client = parts?.client;
  const canvas = parts?.canvas;
  const datasets = parts?.datasets;
  useEffect(() => {
    if (!session || !client || !canvas || !datasets) return;
    const loop = new RenderLoop({ session, datasets, client, canvas });
    loopRef.current = loop;
    loop.start();
    onLoopChange(loop);
    return () => {
      loop.stop();
      loopRef.current = null;
      onLoopChange(null);
    };
    // The datasets map is live, and the ref and the callback are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, client, canvas]);

  useEffect(() => {
    loopRef.current?.markInteractiveDirty();
  }, [loopRef, remoteDocumentVersion]);
}
