import { MAX_PREVIEW_BYTES } from "./api.ts";

/** The preview's long side in pixels: sharp on a card at pixel ratio 2, small on the wire. */
export const PREVIEW_LONG_SIDE = 480;

/**
 * Width over height of the card's image area, `.lc-ws-card-preview` in
 * WorkspaceDashboard.css. A capture is framed to it, so the card's
 * `object-fit: cover` has nothing left to crop.
 */
export const PREVIEW_ASPECT = 2;

/** The long side of the copy the framing reads; enough to find the data, cheap to scan. */
const ANALYSIS_LONG_SIDE = 160;

/** How far a channel may stray from the background and still count as background. */
const BACKGROUND_TOLERANCE = 12;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The size a `width` × `height` region is drawn at, never larger than the region. */
export function previewSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PREVIEW_LONG_SIDE / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface FrameContent {
  /** The canvas background, when all four corners show the same color. */
  background: [number, number, number] | null;
  /** Where anything but the background is, or null for a blank frame. */
  bounds: Rect | null;
}

/**
 * Find the data in an RGBA frame: the background is the color all four
 * corners share, and the data is everything else. Without a shared corner
 * color the data reaches the edges, and the whole frame is the data.
 */
export function findContent(pixels: Uint8ClampedArray, width: number, height: number): FrameContent {
  const whole = { x: 0, y: 0, width, height };
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const [first] = corners;
  const differs = (i: number) =>
    Math.abs(pixels[i] - pixels[first]) > BACKGROUND_TOLERANCE ||
    Math.abs(pixels[i + 1] - pixels[first + 1]) > BACKGROUND_TOLERANCE ||
    Math.abs(pixels[i + 2] - pixels[first + 2]) > BACKGROUND_TOLERANCE;
  if (corners.some(differs)) return { background: null, bounds: whole };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!differs(at(x, y))) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const background: [number, number, number] = [pixels[first], pixels[first + 1], pixels[first + 2]];
  if (maxX < 0) return { background, bounds: null };
  return { background, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
}

/**
 * The region a preview shows: the data with a margin, grown to `aspect`
 * around its center. Where that reaches past the frame, the caller fills
 * the rest with the background, which looks the same as the canvas would.
 */
export function frameContent(bounds: Rect, aspect = PREVIEW_ASPECT): Rect {
  const margin = Math.max(bounds.width, bounds.height) * 0.06;
  let width = bounds.width + margin * 2;
  let height = bounds.height + margin * 2;
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  return {
    x: bounds.x + bounds.width / 2 - width / 2,
    y: bounds.y + bounds.height / 2 - height / 2,
    width,
    height,
  };
}

/** The frame was blank: nothing has drawn yet, or the view shows only background. */
export class BlankFrameError extends Error {
  constructor() {
    super("there's nothing on the canvas to use yet");
    this.name = "BlankFrameError";
  }
}

function context2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2D canvas to encode the preview with");
  return ctx;
}

/** Read `frame` at a small size and find the data in it, in the frame's own pixels. */
async function locateContent(frame: ImageBitmap): Promise<FrameContent> {
  const size = {
    width: Math.max(1, Math.round((frame.width * ANALYSIS_LONG_SIDE) / Math.max(frame.width, frame.height))),
    height: Math.max(1, Math.round((frame.height * ANALYSIS_LONG_SIDE) / Math.max(frame.width, frame.height))),
  };
  const ctx = context2d(size.width, size.height);
  ctx.drawImage(frame, 0, 0, size.width, size.height);
  const found = findContent(ctx.getImageData(0, 0, size.width, size.height).data, size.width, size.height);
  if (!found.bounds) return found;
  const sx = frame.width / size.width;
  const sy = frame.height / size.height;
  return {
    background: found.background,
    bounds: {
      x: found.bounds.x * sx,
      y: found.bounds.y * sy,
      width: found.bounds.width * sx,
      height: found.bounds.height * sy,
    },
  };
}

/**
 * Frame a captured canvas for a dashboard card, downscale it, and encode it.
 *
 * The frame is whatever the render target held, which may be below the
 * device pixel ratio, so sizes come from the PNG rather than the canvas.
 * Framing centers the data, so a volume orbited off to one side or a
 * collection taller than the card still shows whole. WebP first; a browser
 * that cannot encode it hands back a PNG, and then JPEG is smaller.
 * Decoding and resampling run off the main thread where the browser can.
 */
export async function encodePreview(png: ArrayBuffer): Promise<Blob> {
  const frame = await createImageBitmap(new Blob([png], { type: "image/png" }));
  try {
    const { background, bounds } = await locateContent(frame);
    if (!bounds) throw new BlankFrameError();
    const region = background ? frameContent(bounds) : bounds;
    const out = previewSize(region.width, region.height);
    const scale = out.width / region.width;

    const ctx = context2d(out.width, out.height);
    // Without a background the region is the whole frame and covers the canvas.
    if (background) {
      ctx.fillStyle = `rgb(${background.join(",")})`;
      ctx.fillRect(0, 0, out.width, out.height);
    }
    // The part of the region that lies inside the frame.
    const sx = Math.max(0, Math.floor(region.x));
    const sy = Math.max(0, Math.floor(region.y));
    const sw = Math.min(frame.width, Math.ceil(region.x + region.width)) - sx;
    const sh = Math.min(frame.height, Math.ceil(region.y + region.height)) - sy;
    const dx = Math.round((sx - region.x) * scale);
    const dy = Math.round((sy - region.y) * scale);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    let part: ImageBitmap | null = null;
    try {
      part = await createImageBitmap(frame, sx, sy, sw, sh, {
        resizeWidth: dw,
        resizeHeight: dh,
        resizeQuality: "high",
      });
      ctx.drawImage(part, dx, dy);
    } catch {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(frame, sx, sy, sw, sh, dx, dy, dw, dh);
    } finally {
      part?.close();
    }

    const canvas = ctx.canvas;
    let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    if (blob.type !== "image/webp") blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    if (blob.size > MAX_PREVIEW_BYTES) throw new Error("the preview came out larger than the server accepts");
    return blob;
  } finally {
    frame.close();
  }
}
