/** 3D volume viewer component with WebGPU ray marching and pull-based chunk loading. */
import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore } from "../zarr/chunkStore.ts";
import { chunk_key } from "lucida-core";
import type { ChunkCoord } from "../zarr/chunkStore.ts";
import { initGPU, createEmptyVolumeTexture, writeVolumeChunk } from "../renderer/gpuContext.ts";
import { VolumeRenderer } from "../renderer/volumeRenderer.ts";

interface Props {
  volume: VolumeData;
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
}

export function VolumeViewer({ volume, scene, store, datasetInfo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    renderer: VolumeRenderer;
    device: GPUDevice;
    animId: number;
    dirty: boolean;
    currentLevel: number;
    currentT: number;
    currentC: number;
    lastStoreVersion: number;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let destroyed = false;

    async function setup() {
      const canvas = canvasRef.current!;
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;

      scene.set_viewport(canvas.width, canvas.height);

      const gpu = await initGPU(canvas);
      if (destroyed) return;

      const renderer = new VolumeRenderer(gpu.device, gpu.context, gpu.format);

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
      renderer.setVolume(texture, volume.width, volume.height, volume.depth);

      let min = 65535, max = 0;
      const step = Math.max(1, Math.floor(volume.data.length / 100000));
      for (let i = 0; i < volume.data.length; i += step) {
        const v = volume.data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      renderer.setIntensityRange(min, max);

      const state = {
        renderer,
        device: gpu.device,
        animId: 0,
        dirty: true,
        currentLevel: datasetInfo.levels.length - 1,
        currentT: 0,
        currentC: 0,
        lastStoreVersion: -1,
      };
      stateRef.current = state;

      // Request initial chunk load
      try {
        const plan: { needed: ChunkCoord[] } = JSON.parse(scene.chunk_plan());
        if (plan.needed.length > 0) {
          store.ensureFetched(plan.needed);
        }
      } catch { /* ignore */ }

      function frame() {
        if (destroyed) return;

        const st = stateRef.current;
        if (!st) { st && (st.animId = requestAnimationFrame(frame)); return; }

        // Check if store has new chunks
        const currentVersion = store.getVersion();
        if (currentVersion !== st.lastStoreVersion) {
          st.lastStoreVersion = currentVersion;

          // Get current view state from scene
          const viewT = scene.t();
          const viewC = scene.c();

          // Get chunk plan
          let plan: { needed: ChunkCoord[] };
          try {
            plan = JSON.parse(scene.chunk_plan());
          } catch {
            st.animId = requestAnimationFrame(frame);
            return;
          }

          if (plan.needed.length > 0) {
            const targetLevel = plan.needed[0].level;

            // Check if all chunks for this level are available
            const allReady = plan.needed.every(
              (coord) => store.has(coord.key),
            );

            if (allReady && (targetLevel !== st.currentLevel || viewT !== st.currentT || viewC !== st.currentC)) {
              const levelMeta = datasetInfo.levels[targetLevel];
              const [, , depthFull, heightFull, widthFull] = levelMeta.shape;
              const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

              const nz = Math.ceil(depthFull / chunkZ);
              const ny = Math.ceil(heightFull / chunkY);
              const nx = Math.ceil(widthFull / chunkX);

              const newTexture = createEmptyVolumeTexture(
                st.device,
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

                    writeVolumeChunk(st.device, newTexture, chunk, chunkX, chunkY, cw, ch, cd, xOff, yOff, zOff);

                    // Sample intensity range from this chunk
                    const sampleStep = Math.max(1, Math.floor(chunk.length / (100000 / (nz * ny * nx))));
                    for (let i = 0; i < chunk.length; i += sampleStep) {
                      const v = chunk[i];
                      if (v < newMin) newMin = v;
                      if (v > newMax) newMax = v;
                    }
                  }
                }
              }

              st.renderer.setVolume(newTexture, widthFull, heightFull, depthFull);
              st.renderer.setIntensityRange(newMin, newMax);

              st.currentLevel = targetLevel;
              st.currentT = viewT;
              st.currentC = viewC;
              st.dirty = true;
              console.log(`3D: swapped to level ${targetLevel} (${widthFull}x${heightFull}x${depthFull})`);
            }
          }
        }

        if (st.dirty) {
          const invVP = new Float32Array(scene.inv_view_proj_3d());
          const model = new Float32Array(scene.model_matrix());
          const invModel = new Float32Array(scene.inv_model_matrix());
          const eye = new Float32Array(scene.eye_position_3d());
          st.renderer.setMatrices(invVP, model, invModel, eye);
          st.renderer.render();
          st.dirty = false;
        }
        st.animId = requestAnimationFrame(frame);
      }
      state.animId = requestAnimationFrame(frame);
    }

    setup();

    return () => {
      destroyed = true;
      if (stateRef.current) {
        cancelAnimationFrame(stateRef.current.animId);
      }
    };
  }, [volume, scene, store, datasetInfo]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let shiftDrag = false;
    let lastX = 0, lastY = 0;

    function onPointerDown(e: PointerEvent) {
      dragging = true;
      shiftDrag = e.shiftKey;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas!.setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragging || !stateRef.current) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;

      if (shiftDrag) {
        scene.pan_3d(dx, dy);
      } else {
        scene.rotate_3d(-dx * 0.005, -dy * 0.005);
      }
      stateRef.current.dirty = true;
    }

    function onPointerUp() {
      dragging = false;
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (!stateRef.current) return;
      scene.zoom_3d(e.deltaY * 0.001);
      stateRef.current.dirty = true;
      // Request chunks for new zoom level
      try {
        const plan: { needed: ChunkCoord[] } = JSON.parse(scene.chunk_plan());
        if (plan.needed.length > 0) {
          store.ensureFetched(plan.needed);
        }
      } catch { /* ignore */ }
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [scene, store]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        maxWidth: 800,
        height: 600,
        borderRadius: 8,
        cursor: "grab",
      }}
    />
  );
}
