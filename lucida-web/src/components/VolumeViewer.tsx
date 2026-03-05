/** 3D volume viewer component with WebGPU ray marching and pull-based chunk loading. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore, useChunkStore } from "../zarr/chunkStore.ts";
import { chunk_key } from "lucida-core";
import { initGPU, createEmptyVolumeTexture, writeVolumeChunk } from "../renderer/gpuContext.ts";
import { VolumeRenderer } from "../renderer/volumeRenderer.ts";
import { evaluateChunkPlan, sampleIntensityRange } from "../zarr/chunkPlan.ts";

interface Props {
  volume: VolumeData;
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
}

export function VolumeViewer({ volume, scene, store, datasetInfo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const gpuRef = useRef<{
    device: GPUDevice;
    renderer: VolumeRenderer;
  } | null>(null);

  const lodRef = useRef<{
    level: number;
    t: number;
    c: number;
  } | null>(null);

  const storeVersion = useChunkStore(store);

  const [cameraVersion, setCameraVersion] = useState(0);
  const bumpCamera = useCallback(() => setCameraVersion(v => v + 1), []);

  const [gpuReady, setGpuReady] = useState(0);

  // GPU init effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let destroyed = false;

    initGPU(canvas).then(({ device, context, format }) => {
      if (destroyed) return;
      const renderer = new VolumeRenderer(device, context, format);
      gpuRef.current = { device, renderer };
      setGpuReady(v => v + 1);
      bumpCamera();
    }).catch(err => {
      console.error("WebGPU init failed:", err);
    });

    return () => {
      destroyed = true;
      gpuRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial volume upload effect
  useEffect(() => {
    const gpu = gpuRef.current;
    if (!gpu) return;

    const canvas = canvasRef.current!;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    scene.set_viewport(canvas.width, canvas.height);

    const texture = createEmptyVolumeTexture(
      gpu.device,
      volume.width,
      volume.height,
      volume.depth,
    );
    for (let z = 0; z < volume.depth; z++) {
      gpu.device.queue.writeTexture(
        { texture, origin: [0, 0, z] },
        volume.data.buffer,
        {
          offset: volume.data.byteOffset + z * volume.width * volume.height * 2,
          bytesPerRow: volume.width * 2,
          rowsPerImage: volume.height,
        },
        [volume.width, volume.height, 1],
      );
    }
    gpu.renderer.setVolume(texture, volume.width, volume.height, volume.depth);

    const { min, max } = sampleIntensityRange(volume.data);
    gpu.renderer.setIntensityRange(min, max);

    lodRef.current = {
      level: datasetInfo.levels.length - 1,
      t: 0,
      c: 0,
    };
  }, [volume, scene, datasetInfo, gpuReady]);

  // Chunk request effect — triggered by camera changes
  useEffect(() => {
    const plan = evaluateChunkPlan(scene);
    if (plan && plan.needed.length > 0) {
      store.ensureFetched(plan.needed);
    }
  }, [scene, store, cameraVersion]);

  // LOD swap + render effect
  useEffect(() => {
    const gpu = gpuRef.current;
    const lod = lodRef.current;
    if (!gpu) return;

    const plan = evaluateChunkPlan(scene);
    if (plan && plan.needed.length > 0) {
      // Ensure any uncached chunks are fetched
      store.ensureFetched(plan.needed);

      const viewT = scene.t();
      const viewC = scene.c();
      const targetLevel = plan.needed[0].level;

      const allReady = plan.needed.every(
        (coord) => store.has(coord.key),
      );

      if (allReady && lod && (targetLevel !== lod.level || viewT !== lod.t || viewC !== lod.c)) {
        const levelMeta = datasetInfo.levels[targetLevel];
        const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
        const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

        const nz = Math.ceil(depthFull / chunkZ);
        const ny = Math.ceil(heightFull / chunkY);
        const nx = Math.ceil(widthFull / chunkX);

        const newTexture = createEmptyVolumeTexture(
          gpu.device,
          widthFull,
          heightFull,
          depthFull,
        );

        let newMin = 65535, newMax = 0;

        for (let iz = 0; iz < nz; iz++) {
          for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
              const key = chunk_key(targetLevel, viewT, viewC, iz, iy, ix);
              const buf = store.get(key);
              if (!buf) continue;

              const chunk = new Uint16Array(buf);
              const zOff = iz * chunkZ;
              const yOff = iy * chunkY;
              const xOff = ix * chunkX;
              const cw = Math.min(chunkX, widthFull - xOff);
              const ch = Math.min(chunkY, heightFull - yOff);
              const cd = Math.min(chunkZ, depthFull - zOff);

              writeVolumeChunk(gpu.device, newTexture, chunk, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);

              const perChunkSamples = Math.floor(100000 / (nz * ny * nx));
              const { min, max } = sampleIntensityRange(chunk, perChunkSamples);
              if (min < newMin) newMin = min;
              if (max > newMax) newMax = max;
            }
          }
        }

        gpu.renderer.setVolume(newTexture, widthFull, heightFull, depthFull);
        gpu.renderer.setIntensityRange(newMin, newMax);

        lodRef.current = { level: targetLevel, t: viewT, c: viewC };
        console.log(`3D: swapped to level ${targetLevel} (${widthFull}x${heightFull}x${depthFull})`);
      }
    }

    // Render
    const invVP = new Float32Array(scene.inv_view_proj_3d());
    const model = new Float32Array(scene.model_matrix());
    const invModel = new Float32Array(scene.inv_model_matrix());
    const eye = new Float32Array(scene.eye_position_3d());
    gpu.renderer.setMatrices(invVP, model, invModel, eye);
    gpu.renderer.render();
  }, [storeVersion, cameraVersion, scene, store, datasetInfo]);

  // Input handling
  const [dragging, setDragging] = useState(false);
  const shiftDragRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      setDragging(true);
      shiftDragRef.current = e.shiftKey;
      lastPos.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragging) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };

      if (shiftDragRef.current) {
        scene.pan_3d(dx, dy);
      } else {
        scene.rotate_3d(-dx * 0.005, -dy * 0.005);
      }
      bumpCamera();
    },
    [dragging, scene, bumpCamera],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      scene.zoom_3d(e.deltaY * 0.001);
      bumpCamera();
    },
    [scene, bumpCamera],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        width: "100%",
        maxWidth: 800,
        height: 600,
        borderRadius: 8,
        cursor: dragging ? "grabbing" : "grab",
      }}
    />
  );
}
