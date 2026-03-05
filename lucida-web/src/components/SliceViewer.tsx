/** 2D slice viewer — renders a single Z-slice from the loaded volume on a canvas. */
import { useEffect, useRef } from "react";
import type { VolumeData } from "../zarr/volumeAssembler.ts";

interface Props {
  volume: VolumeData;
  z: number;
}

export function SliceViewer({ volume, z }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { width, height, depth, data } = volume;
    const clampedZ = Math.max(0, Math.min(z, depth - 1));
    const sliceSize = width * height;
    const offset = clampedZ * sliceSize;
    const slice = data.subarray(offset, offset + sliceSize);

    // Auto-detect min/max intensity in this slice
    let min = 65535,
      max = 0;
    const step = Math.max(1, Math.floor(sliceSize / 100000));
    for (let i = 0; i < sliceSize; i += step) {
      const v = slice[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;

    for (let i = 0; i < sliceSize; i++) {
      const normalized = ((slice[i] - min) / range) * 255;
      const byte = normalized < 0 ? 0 : normalized > 255 ? 255 : normalized;
      const p = i * 4;
      pixels[p] = byte;
      pixels[p + 1] = byte;
      pixels[p + 2] = byte;
      pixels[p + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
  }, [volume, z]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        maxWidth: 800,
        imageRendering: "pixelated",
        borderRadius: 8,
      }}
    />
  );
}
