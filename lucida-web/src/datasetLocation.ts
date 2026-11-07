// Short, distinguishable labels for where datasets live, for lists that show
// many of them at once. Pure string work on canonical URLs, so it needs no
// wasm and runs in any render.

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether a canonical dataset URL names remote storage rather than a server path. */
export function isRemoteDatasetUrl(url: string): boolean {
  return SCHEME.test(url);
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0].replace(/\/+$/, "");
}

/** The host or bucket, then each path segment. */
function segmentsOf(url: string): string[] {
  const bare = withoutQuery(url);
  const scheme = SCHEME.exec(bare);
  return (scheme ? bare.slice(scheme[0].length) : bare).split("/").filter(Boolean);
}

/**
 * One label per URL: the dataset's folder and name, with more of the path
 * only where two URLs would otherwise read the same. A label that stops short
 * of the root starts with `…/`; one that reaches it is the whole URL without
 * its query.
 */
export function shortDatasetLocations(urls: readonly string[]): string[] {
  const segments = urls.map(segmentsOf);
  const depths = segments.map((s) => Math.min(2, s.length));
  const tail = (i: number) => segments[i].slice(segments[i].length - depths[i]).join("/");

  for (let grew = true; grew; ) {
    grew = false;
    const byTail = new Map<string, number[]>();
    segments.forEach((_, i) => byTail.set(tail(i), [...(byTail.get(tail(i)) ?? []), i]));
    for (const group of byTail.values()) {
      // The same URL twice cannot be told apart, however much of it shows.
      if (new Set(group.map((i) => withoutQuery(urls[i]))).size < 2) continue;
      for (const i of group) {
        if (depths[i] < segments[i].length) {
          depths[i] += 1;
          grew = true;
        }
      }
    }
  }

  return urls.map((url, i) =>
    depths[i] < segments[i].length ? `…/${tail(i)}` : withoutQuery(url),
  );
}
