import { hasLocalFilePaths, localFilePathCount } from "../savedView/captureBuilder.ts";
import { encode } from "../savedView/encoder.ts";
import type { SavedView } from "../savedView/types.ts";
import { toast } from "../ui/toastQueue.ts";

// Past this length some chat apps cut a link off or refuse it.
const LONG_LINK_CHARS = 4096;

/**
 * A link to this page with `view` in its hash, the form the URL sync writes
 * (ADR 0013). Built from the view itself rather than read from the address
 * bar, which lags a debounce behind and has no view at all until the first
 * change after a load.
 */
export async function viewLink(view: SavedView | null): Promise<string> {
  const { origin, pathname, search, href } = window.location;
  if (view === null) return href;
  return `${origin}${pathname}${search}#view=${await encode(view)}`;
}

/** Why a copied view link might not open for someone else, if it might not. */
export function viewLinkCaveats(link: string, view: SavedView | null): string[] {
  const caveats: string[] = [];
  // A local path resolves only on a server with the same files (ADR 0014).
  if (view && hasLocalFilePaths(view)) {
    const n = localFilePathCount(view);
    caveats.push(
      `It opens ${n === 1 ? "a local file" : `${n} local files`}, so it works only on a server with the same files at the same paths.`,
    );
  }
  if (link.length > LONG_LINK_CHARS) {
    caveats.push("It is long enough that some chat apps may cut it off. A saved view has a short link.");
  }
  return caveats;
}

/**
 * Copies a view link and confirms with a toast that carries any caveats.
 * Pass the link as a string when you have it: then the clipboard write
 * happens within the press that asked for it, which some browsers require.
 */
export async function copyViewLink(link: string | Promise<string>, view: SavedView | null): Promise<void> {
  let text: string;
  try {
    text = typeof link === "string" ? link : await link;
    await navigator.clipboard.writeText(text);
  } catch (e) {
    toast({
      title: "Couldn't copy the link",
      description: e instanceof Error ? e.message : String(e),
      tone: "danger",
    });
    return;
  }
  const caveats = viewLinkCaveats(text, view);
  toast(
    caveats.length === 0
      ? { title: "Link copied", tone: "success" }
      : { title: "Link copied", description: caveats.join(" "), tone: "warning" },
  );
}
