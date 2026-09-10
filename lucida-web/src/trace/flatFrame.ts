/**
 * Is a frame one flat colour?
 *
 * The trace driver takes a screenshot over the DevTools protocol, and on some
 * hosts that screenshot leaves the WebGPU canvas out: headless Chrome on
 * Vulkan returns a solid black rectangle where the page's own capture of the
 * same canvas, at the same moment, shows the clear colour and the dataset
 * (#1098). A screenshot like that is not a frame. So before the page carries
 * the driver's screenshot as the fallback for a capture of its own that
 * failed, it decodes the screenshot and asks whether every pixel of the
 * canvas's region is the same. The region matters: the screenshot is of the
 * whole page, and a scrollbar along its edge is not the canvas.
 *
 * The check lives on the page because the page already has a PNG decoder in
 * its 2D canvas, and the CLI should not gain one for this.
 */

/** The pixels of a decoded image: RGBA, row-major, as a 2D context reads them back. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A rectangle, in whichever pixels the caller says: CSS pixels on the page, image pixels in a frame. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A PNG decoder the bundle can call: the page's, or a test's stand-in. */
export type PngDecoder = (png: Uint8Array) => Promise<DecodedImage>;

/**
 * The one colour every pixel shares, as `#rrggbb` with `aa` added when the
 * pixels are not opaque, or null when two pixels differ. With a `region`,
 * only its interior is read: the region inset by two percent per side, so a
 * rounded corner or an anti-aliased edge does not read as content. Without
 * one, or when the region leaves nothing inside the image, the whole image
 * is read. An image with no pixels, or fewer bytes than its size claims,
 * has no colour to name and is not flat.
 */
export function flatColourOf(image: DecodedImage, region?: Rect | null): string | null {
  const { data, width, height } = image;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const bounds = interior(region, width, height) ?? { x0: 0, y0: 0, x1: width, y1: height };
  if (!samePixelThroughout(data, width, bounds)) return null;
  const offset = (bounds.y0 * width + bounds.x0) * 4;
  const pair = (channel: number) => channel.toString(16).padStart(2, "0");
  const alpha = data[offset + 3];
  return `#${pair(data[offset])}${pair(data[offset + 1])}${pair(data[offset + 2])}${alpha === 255 ? "" : pair(alpha)}`;
}

/** Half-open: `x1` and `y1` are exclusive. */
interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per side, so a rounded corner or an anti-aliased edge does not read as content. */
const EDGE_INSET = 0.02;

function interior(region: Rect | null | undefined, width: number, height: number): Bounds | null {
  if (!region) return null;
  const insetX = region.width * EDGE_INSET;
  const insetY = region.height * EDGE_INSET;
  const x0 = Math.max(0, Math.ceil(region.x + insetX));
  const y0 = Math.max(0, Math.ceil(region.y + insetY));
  const x1 = Math.min(width, Math.floor(region.x + region.width - insetX));
  const y1 = Math.min(height, Math.floor(region.y + region.height - insetY));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * Compare whole pixels as 32-bit words, since a retina frame is five million
 * of them. A view that does not start on a word boundary is copied first.
 */
function samePixelThroughout(data: Uint8ClampedArray, width: number, bounds: Bounds): boolean {
  const { x0, y0, x1, y1 } = bounds;
  const aligned = data.byteOffset % 4 === 0 ? data : data.slice();
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length >> 2);
  const first = words[y0 * width + x0];
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      if (words[row + x] !== first) return false;
    }
  }
  return true;
}

/**
 * The part of `element` inside its document's client area, in CSS pixels,
 * or null when there is no element or none of it is inside. The client area
 * excludes scrollbars, so a page that overflows still yields the canvas
 * alone.
 */
export function visibleRectOf(element: Element | null): Rect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const root = element.ownerDocument.documentElement;
  const x0 = Math.max(0, rect.left);
  const y0 = Math.max(0, rect.top);
  const x1 = Math.min(root.clientWidth, rect.right);
  const y1 = Math.min(root.clientHeight, rect.bottom);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * Decode a PNG through the page's own 2D canvas. `createImageBitmap` is the
 * browser's decoder, and a 2D context with no colour management reads the
 * pixels back as the file holds them.
 */
export async function decodePngOnPage(png: Uint8Array): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("the page gave no 2D context to decode the frame with");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: pixels.width, height: pixels.height, data: pixels.data };
  } finally {
    bitmap.close();
  }
}

/** Whether this page can decode a PNG at all. False in a document with no image bitmaps or offscreen canvases. */
export function pageDecodesPng(): boolean {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
}
