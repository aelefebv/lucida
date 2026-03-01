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
  generationSeq: number;
  rgba: Uint8ClampedArray;
};

export class ProgressiveFrameStore {
  private previewFrames: Map<number, FramePayload>;
  private tileFrames: Map<number, FramePayload>;

  public constructor() {
    this.previewFrames = new Map();
    this.tileFrames = new Map();
  }

  public setPreview(generationSeq: number, rgba: Uint8ClampedArray): void {
    this.previewFrames.set(generationSeq, { generationSeq, rgba });
  }

  public setTiles(generationSeq: number, rgba: Uint8ClampedArray): void {
    this.tileFrames.set(generationSeq, { generationSeq, rgba });
  }

  public resolveFrame(generationSeq: number): Uint8ClampedArray | null {
    const tiles = this.tileFrames.get(generationSeq);
    if (tiles !== undefined) {
      return tiles.rgba;
    }
    const preview = this.previewFrames.get(generationSeq);
    if (preview !== undefined) {
      return preview.rgba;
    }
    return null;
  }

  public pruneOlderThan(generationSeq: number): void {
    for (const key of this.previewFrames.keys()) {
      if (key < generationSeq) {
        this.previewFrames.delete(key);
      }
    }
    for (const key of this.tileFrames.keys()) {
      if (key < generationSeq) {
        this.tileFrames.delete(key);
      }
    }
  }
}
