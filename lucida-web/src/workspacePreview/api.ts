/**
 * The preview routes: one small image per workspace, captured by the viewer
 * and shown on the dashboard card. The server keeps the bytes and never
 * renders one itself.
 */

/** The server's cap, `MAX_PREVIEW_BYTES` in `lucida-server/src/workspace/preview.rs`. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/**
 * The image URL. `version` is the listing's `preview_updated_at`: an image
 * already decoded in the page is reused by URL without asking the server,
 * so a changed preview needs a changed URL.
 */
export function workspacePreviewUrl(workspaceId: string, version?: string | null): string {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/preview`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

/**
 * When the workspace's preview was last written, or null when it has none.
 * A `HEAD`, so asking costs no image.
 */
export async function fetchPreviewUpdatedAt(workspaceId: string): Promise<Date | null> {
  const res = await fetch(workspacePreviewUrl(workspaceId), {
    method: "HEAD",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const modified = res.headers.get("last-modified");
  const at = modified ? new Date(modified) : null;
  // A preview with no readable date is treated as old rather than absent.
  return at && !Number.isNaN(at.getTime()) ? at : new Date(0);
}

/** Store `image` as the workspace's preview. Throws with the server's sentence when refused. */
export async function uploadPreview(workspaceId: string, image: Blob): Promise<void> {
  const res = await fetch(workspacePreviewUrl(workspaceId), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": image.type },
    body: image,
  });
  if (res.ok) return;
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { detail?: string; error?: string };
    detail = body.detail || body.error || detail;
  } catch {
    // Keep the status line.
  }
  throw new Error(detail);
}
