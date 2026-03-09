/** 3D volume viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore } from "../zarr/chunkStore.ts";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop } from "../renderLoop.ts";
import { applyViewportCommand } from "../applyAndSend.ts";

interface Props {
  volume: VolumeData;
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteDocumentVersion: number;
  emitPresence: () => void;
  breakFollow: () => void;
  t: number;
  c: number;
  loopRef: MutableRefObject<RenderLoop | null>;
}

export function VolumeViewer({ volume, scene, store, datasetInfo, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, t, c, loopRef: parentLoopRef }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);

  // Create/start render loop
  useEffect(() => {
    const loop = new RenderLoop({ scene, store, datasetInfo, client, canvas, mode: "volume" });
    loopRef.current = loop;
    parentLoopRef.current = loop;
    loop.start();
    return () => {
      loop.stop();
      parentLoopRef.current = null;
    };
  }, [scene, store, datasetInfo, client, canvas]);

  // Mark dirty on remote document updates
  useEffect(() => {
    loopRef.current?.markDirty();
  }, [remoteDocumentVersion]);

  // Mark dirty on T/C changes so the render loop re-evaluates chunks
  useEffect(() => {
    loopRef.current?.markDirty();
  }, [t, c]);

  // Set mode on mount
  useEffect(() => {
    client.setModeVolume();
  }, [client]);

  // Initial volume upload effect
  useEffect(() => {
    const canvasW = canvas.clientWidth * devicePixelRatio;
    const canvasH = canvas.clientHeight * devicePixelRatio;
    scene.set_viewport(canvasW, canvasH);

    loopRef.current?.resetVolumeCache();
    client.volumeSetInitial(volume.data, volume.width, volume.height, volume.depth);
    loopRef.current?.markDirty();
  }, [volume, scene, datasetInfo, client, canvas]);

  // Input handling
  const [dragging, setDragging] = useState(false);
  const shiftDragRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      setDragging(true);
      shiftDragRef.current = e.shiftKey;
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    },
    [canvas],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };

      breakFollow();
      if (shiftDragRef.current) {
        applyViewportCommand(scene, { type: "pan_3d", dx, dy });
      } else {
        const dTheta = -dx * 0.005;
        const dPhi = -dy * 0.005;
        applyViewportCommand(scene, { type: "rotate_3d", d_theta: dTheta, d_phi: dPhi });
      }
      emitPresence();
      loopRef.current?.markDirty();
    },
    [dragging, scene, emitPresence, breakFollow],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY * 0.001;
      breakFollow();
      applyViewportCommand(scene, { type: "zoom_3d", delta });
      emitPresence();
      loopRef.current?.markDirty();
    },
    [scene, emitPresence, breakFollow],
  );

  // Attach event handlers to the shared canvas
  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = dragging ? "grabbing" : "grab";
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onWheel, dragging]);

  return null;
}
