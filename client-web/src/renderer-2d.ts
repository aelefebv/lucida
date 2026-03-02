export type BlendMode = "normal" | "additive";

export type ChannelLayer = {
  channelIndex: number;
  pixels: Uint8Array;
  color: [number, number, number];
  enabled: boolean;
  contrast: number;
  gamma: number;
};

export function composite2d(
  width: number,
  height: number,
  channels: ChannelLayer[],
  blendMode: BlendMode,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const out = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    let r = 0;
    let g = 0;
    let b = 0;

    for (const channel of channels) {
      if (!channel.enabled) {
        continue;
      }
      const sample = channel.pixels[i] ?? 0;
      const mapped = mapSample(sample, channel.contrast, channel.gamma);
      const chR = mapped * channel.color[0];
      const chG = mapped * channel.color[1];
      const chB = mapped * channel.color[2];

      if (blendMode === "normal") {
        r = Math.max(r, chR);
        g = Math.max(g, chG);
        b = Math.max(b, chB);
      } else {
        r += chR;
        g += chG;
        b += chB;
      }
    }

    out[i * 4] = clamp255(r);
    out[i * 4 + 1] = clamp255(g);
    out[i * 4 + 2] = clamp255(b);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function mapSample(sample: number, contrast: number, gamma: number): number {
  const normalized = sample / 255;
  const gammaCorrected = Math.pow(normalized, 1 / Math.max(gamma, 0.01));
  return Math.min(255, gammaCorrected * 255 * Math.max(contrast, 0));
}

function clamp255(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 255) {
    return 255;
  }
  return Math.round(value);
}

type FramePayload = {
  sourceId: string;
  generationSeq: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

export type TilePatch = {
  canvasWidth: number;
  canvasHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
};

export class ProgressiveFrameStore {
  private previewFrames: Map<string, FramePayload>;
  private tileFrames: Map<string, FramePayload>;

  public constructor() {
    this.previewFrames = new Map();
    this.tileFrames = new Map();
  }

  public setPreview(
    sourceId: string,
    generationSeq: number,
    rgba: Uint8ClampedArray,
    width?: number,
    height?: number,
  ): void {
    const dimensions = normalizedFrameDimensions(rgba, width, height);
    this.previewFrames.set(frameKey(sourceId, generationSeq), {
      sourceId,
      generationSeq,
      width: dimensions.width,
      height: dimensions.height,
      rgba,
    });
  }

  public setTiles(
    sourceId: string,
    generationSeq: number,
    rgba: Uint8ClampedArray,
    width?: number,
    height?: number,
  ): void {
    const dimensions = normalizedFrameDimensions(rgba, width, height);
    this.tileFrames.set(frameKey(sourceId, generationSeq), {
      sourceId,
      generationSeq,
      width: dimensions.width,
      height: dimensions.height,
      rgba,
    });
  }

  public composeTilePatch(
    sourceId: string,
    generationSeq: number,
    patch: TilePatch,
  ): void {
    const key = frameKey(sourceId, generationSeq);
    const canvasWidth = normalizedDimension(patch.canvasWidth, 1);
    const canvasHeight = normalizedDimension(patch.canvasHeight, 1);
    const tileWidth = normalizedDimension(patch.width, 1);
    const tileHeight = normalizedDimension(patch.height, 1);
    const tileFrame = this.ensureTileFrame(
      key,
      sourceId,
      generationSeq,
      canvasWidth,
      canvasHeight,
    );

    blitRgba(
      patch.rgba,
      tileWidth,
      tileHeight,
      tileFrame.rgba,
      tileFrame.width,
      tileFrame.height,
      Math.floor(patch.offsetX),
      Math.floor(patch.offsetY),
    );
  }

  public resolveFrame(sourceId: string, generationSeq: number): Uint8ClampedArray | null {
    const key = frameKey(sourceId, generationSeq);
    const tiles = this.tileFrames.get(key);
    if (tiles !== undefined) {
      return tiles.rgba;
    }
    const preview = this.previewFrames.get(key);
    if (preview !== undefined) {
      return preview.rgba;
    }
    return null;
  }

  public pruneOlderThan(sourceId: string, generationSeq: number): void {
    for (const [key, frame] of this.previewFrames.entries()) {
      if (frame.sourceId === sourceId && frame.generationSeq < generationSeq) {
        this.previewFrames.delete(key);
      }
    }
    for (const [key, frame] of this.tileFrames.entries()) {
      if (frame.sourceId === sourceId && frame.generationSeq < generationSeq) {
        this.tileFrames.delete(key);
      }
    }
  }

  public clearGeneration(sourceId: string, generationSeq: number): void {
    const key = frameKey(sourceId, generationSeq);
    this.previewFrames.delete(key);
    this.tileFrames.delete(key);
  }

  private ensureTileFrame(
    key: string,
    sourceId: string,
    generationSeq: number,
    width: number,
    height: number,
  ): FramePayload {
    const existing = this.tileFrames.get(key);
    if (existing !== undefined && existing.width === width && existing.height === height) {
      return existing;
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    const preview = this.previewFrames.get(key);
    if (preview !== undefined) {
      blitRgba(
        preview.rgba,
        preview.width,
        preview.height,
        rgba,
        width,
        height,
        0,
        0,
      );
    }
    const frame = {
      sourceId,
      generationSeq,
      width,
      height,
      rgba,
    };
    this.tileFrames.set(key, frame);
    return frame;
  }
}

function frameKey(sourceId: string, generationSeq: number): string {
  return `${sourceId}:${generationSeq.toString()}`;
}

function normalizedDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizedFrameDimensions(
  rgba: Uint8ClampedArray,
  width?: number,
  height?: number,
): { width: number; height: number } {
  const pixelCount = Math.max(1, Math.floor(rgba.length / 4));
  const normalizedWidth = normalizedDimension(width, pixelCount);
  const normalizedHeight = normalizedDimension(height, 1);
  if (normalizedWidth * normalizedHeight === pixelCount) {
    return { width: normalizedWidth, height: normalizedHeight };
  }
  if (pixelCount % normalizedWidth === 0) {
    return { width: normalizedWidth, height: pixelCount / normalizedWidth };
  }
  if (pixelCount % normalizedHeight === 0) {
    return { width: pixelCount / normalizedHeight, height: normalizedHeight };
  }
  return { width: pixelCount, height: 1 };
}

function blitRgba(
  src: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  dst: Uint8ClampedArray,
  dstWidth: number,
  dstHeight: number,
  offsetX: number,
  offsetY: number,
): void {
  const clampedSrcWidth = normalizedDimension(srcWidth, 1);
  const clampedSrcHeight = normalizedDimension(srcHeight, 1);
  for (let row = 0; row < clampedSrcHeight; row += 1) {
    const dstY = offsetY + row;
    if (dstY < 0 || dstY >= dstHeight) {
      continue;
    }
    for (let col = 0; col < clampedSrcWidth; col += 1) {
      const dstX = offsetX + col;
      if (dstX < 0 || dstX >= dstWidth) {
        continue;
      }
      const srcPixelIndex = row * clampedSrcWidth + col;
      const dstPixelIndex = dstY * dstWidth + dstX;
      const srcOffset = srcPixelIndex * 4;
      const dstOffset = dstPixelIndex * 4;
      if (srcOffset + 3 >= src.length || dstOffset + 3 >= dst.length) {
        continue;
      }
      dst[dstOffset] = src[srcOffset] ?? 0;
      dst[dstOffset + 1] = src[srcOffset + 1] ?? 0;
      dst[dstOffset + 2] = src[srcOffset + 2] ?? 0;
      dst[dstOffset + 3] = src[srcOffset + 3] ?? 255;
    }
  }
}
