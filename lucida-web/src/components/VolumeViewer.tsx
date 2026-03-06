/** 3D volume viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore, useChunkStore } from "../zarr/chunkStore.ts";
import type { ChunkCoord } from "../zarr/chunkStore.ts";
import { RenderClient } from "../renderer/renderClient.ts";
import { evaluateChunkPlan } from "../zarr/chunkPlan.ts";

interface Props {
  volume: VolumeData;
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteCameraVersion: number;
  sendCommand: (json: string) => void;
}

export function VolumeViewer({ volume, scene, store, datasetInfo, client, canvas, remoteCameraVersion, sendCommand }: Props) {
  const storeVersion = useChunkStore(store);

  const [cameraVersion, setCameraVersion] = useState(0);
  const bumpCamera = useCallback(() => setCameraVersion(v => v + 1), []);

  const planRef = useRef<{ needed: ChunkCoord[]; t: number; c: number } | null>(null);
  const uploadedRef = useRef<Set<string>>(new Set());
  const lodRef = useRef<{ level: number; t: number; c: number } | null>(null);

  // Set mode on mount
  useEffect(() => {
    client.setModeVolume();
  }, [client]);

  // Initial volume upload effect
  useEffect(() => {
    const canvasW = canvas.clientWidth * devicePixelRatio;
    const canvasH = canvas.clientHeight * devicePixelRatio;
    scene.set_viewport(canvasW, canvasH);

    client.volumeSetInitial(volume.data, volume.width, volume.height, volume.depth);

    lodRef.current = {
      level: datasetInfo.levels.length - 1,
      t: 0,
      c: 0,
    };
    uploadedRef.current = new Set();
    bumpCamera();
  }, [volume, scene, datasetInfo, client, canvas, bumpCamera]);

  // Chunk request effect — triggered by camera changes
  useEffect(() => {
    const plan = evaluateChunkPlan(scene);
    planRef.current = plan ? { ...plan, t: scene.t(), c: scene.c() } : null;
    if (plan && plan.needed.length > 0) {
      store.ensureFetched(plan.needed);
    }
  }, [scene, store, cameraVersion, remoteCameraVersion]);

  // LOD swap + render effect (incremental chunk upload)
  useEffect(() => {
    const viewT = scene.t();
    const viewC = scene.c();
    let plan = planRef.current;
    if (plan && (plan.t !== viewT || plan.c !== viewC)) {
      const freshPlan = evaluateChunkPlan(scene);
      if (freshPlan) {
        planRef.current = { ...freshPlan, t: viewT, c: viewC };
        plan = planRef.current;
        store.ensureFetched(freshPlan.needed);
      }
    }

    if (plan && plan.needed.length > 0) {
      const targetLevel = plan.needed[0].level;
      const levelMeta = datasetInfo.levels[targetLevel];
      const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
      const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

      // Reset uploaded set when target level/t/c changes
      const lod = lodRef.current;
      if (!lod || lod.level !== targetLevel || lod.t !== viewT || lod.c !== viewC) {
        uploadedRef.current = new Set();
        lodRef.current = { level: targetLevel, t: viewT, c: viewC };
      }

      // Collect newly available chunks
      const newChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
      for (const coord of plan.needed) {
        if (uploadedRef.current.has(coord.key)) continue;
        const buf = store.get(coord.key);
        if (!buf) continue;
        newChunks.push({ data: new Uint16Array(buf), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
        uploadedRef.current.add(coord.key);
      }

      if (newChunks.length > 0) {
        client.volumeUploadChunks(
          newChunks,
          targetLevel, viewT, viewC,
          widthFull, heightFull, depthFull,
          chunkX, chunkY, chunkZ,
        );
      }
    }

    // Render
    const invVP = new Float32Array(scene.inv_view_proj_3d());
    const model = new Float32Array(scene.model_matrix());
    const invModel = new Float32Array(scene.inv_model_matrix());
    const eye = new Float32Array(scene.eye_position_3d());
    const canvasW = canvas.clientWidth * devicePixelRatio;
    const canvasH = canvas.clientHeight * devicePixelRatio;

    client.volumeRender(invVP, model, invModel, eye, canvasW, canvasH);
  }, [storeVersion, cameraVersion, remoteCameraVersion, scene, store, datasetInfo, client, canvas]);

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

      if (shiftDragRef.current) {
        scene.pan_3d(dx, dy);
        sendCommand(JSON.stringify({ type: "pan_3d", dx, dy }));
      } else {
        const dTheta = -dx * 0.005;
        const dPhi = -dy * 0.005;
        scene.rotate_3d(dTheta, dPhi);
        sendCommand(JSON.stringify({ type: "rotate_3d", d_theta: dTheta, d_phi: dPhi }));
      }
      bumpCamera();
    },
    [dragging, scene, bumpCamera, sendCommand],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY * 0.001;
      scene.zoom_3d(delta);
      sendCommand(JSON.stringify({ type: "zoom_3d", delta }));
      bumpCamera();
    },
    [scene, bumpCamera, sendCommand],
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
