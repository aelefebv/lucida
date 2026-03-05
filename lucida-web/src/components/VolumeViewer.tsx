/** 3D volume viewer component with WebGPU ray marching. */
import { useEffect, useRef } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import { initGPU, createVolumeTexture } from "../renderer/gpuContext.ts";
import { VolumeRenderer } from "../renderer/volumeRenderer.ts";

interface Props {
  volume: VolumeData;
  scene: WasmScene;
}

export function VolumeViewer({ volume, scene }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    renderer: VolumeRenderer;
    animId: number;
    dirty: boolean;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let destroyed = false;

    async function setup() {
      const canvas = canvasRef.current!;
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;

      // Update viewport in the WASM camera
      scene.set_viewport(canvas.width, canvas.height);

      const gpu = await initGPU(canvas);
      if (destroyed) return;

      const renderer = new VolumeRenderer(gpu.device, gpu.context, gpu.format);

      const texture = createVolumeTexture(
        gpu.device,
        volume.width,
        volume.height,
        volume.depth,
        volume.data,
      );
      renderer.setVolume(texture, volume.width, volume.height, volume.depth);

      // Auto-detect intensity range from data
      let min = 65535, max = 0;
      const step = Math.max(1, Math.floor(volume.data.length / 100000));
      for (let i = 0; i < volume.data.length; i += step) {
        const v = volume.data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      renderer.setIntensityRange(min, max);

      const state = { renderer, animId: 0, dirty: true };
      stateRef.current = state;

      function frame() {
        if (destroyed) return;
        if (state.dirty) {
          // Read matrices from WASM scene
          const invVP = new Float32Array(scene.inv_view_proj_3d());
          const model = new Float32Array(scene.model_matrix());
          const invModel = new Float32Array(scene.inv_model_matrix());
          const eye = new Float32Array(scene.eye_position_3d());
          state.renderer.setMatrices(invVP, model, invModel, eye);
          state.renderer.render();
          state.dirty = false;
        }
        state.animId = requestAnimationFrame(frame);
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
  }, [volume, scene]);

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
  }, [scene]);

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
