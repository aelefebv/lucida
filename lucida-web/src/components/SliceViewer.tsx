/** 2D slice viewer — renders a single Z-slice with pan/zoom interactivity. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { VolumeData } from "../zarr/volumeAssembler.ts";

interface Props {
  volume: VolumeData;
  z: number;
}

export function SliceViewer({ volume, z }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<OffscreenCanvas | null>(null);

  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Reset pan/zoom when the dataset dimensions change (new dataset loaded),
  // but not when the volume object is recreated due to T/C slice changes.
  const prevDims = useRef({ w: volume.width, h: volume.height, d: volume.depth });
  useEffect(() => {
    const { width, height, depth } = volume;
    const prev = prevDims.current;
    if (width !== prev.w || height !== prev.h || depth !== prev.d) {
      prevDims.current = { w: width, h: height, d: depth };
      setOffsetX(0);
      setOffsetY(0);
      setZoom(1.0);
    }
  }, [volume]);

  // Render slice data to offscreen canvas whenever volume or z changes
  useEffect(() => {
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

    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d")!;
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
    offscreenRef.current = offscreen;
  }, [volume, z]);

  // Composite offscreen canvas onto visible canvas with pan/zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    const offscreen = offscreenRef.current;
    if (!canvas || !offscreen) return;

    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    canvas.width = canvasW;
    canvas.height = canvasH;

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const dataW = offscreen.width;
    const dataH = offscreen.height;
    const dx = canvasW / 2 - (dataW / 2 - offsetX) * zoom;
    const dy = canvasH / 2 - (dataH / 2 - offsetY) * zoom;
    const dw = dataW * zoom;
    const dh = dataH * zoom;

    ctx.drawImage(offscreen, 0, 0, dataW, dataH, dx, dy, dw, dh);
  }, [volume, z, offsetX, offsetY, zoom]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      setDragging(true);
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
      setOffsetX((prev) => prev + dx / zoom);
      setOffsetY((prev) => prev + dy / zoom);
    },
    [dragging, zoom],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = zoom * factor;

      // Adjust offset so the point under the cursor stays fixed
      const canvasW = canvas.clientWidth;
      const canvasH = canvas.clientHeight;
      const offscreen = offscreenRef.current;
      if (!offscreen) return;
      const dataW = offscreen.width;
      const dataH = offscreen.height;

      // Current world point under cursor
      const worldX = (cursorX - canvasW / 2) / zoom + dataW / 2 - offsetX;
      const worldY = (cursorY - canvasH / 2) / zoom + dataH / 2 - offsetY;

      // New offset so that same world point maps to same cursor position
      const newOffsetX = dataW / 2 - worldX + (cursorX - canvasW / 2) / newZoom;
      const newOffsetY = dataH / 2 - worldY + (cursorY - canvasH / 2) / newZoom;

      setZoom(newZoom);
      setOffsetX(newOffsetX);
      setOffsetY(newOffsetY);
    },
    [zoom, offsetX, offsetY],
  );

  // Attach wheel handler with { passive: false } to allow preventDefault
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
        height: 600,
        maxWidth: 800,
        imageRendering: "pixelated",
        borderRadius: 8,
        cursor: dragging ? "grabbing" : "grab",
        backgroundColor: "black",
      }}
    />
  );
}
