// The chrome-free capture surface (`?render=1`), used by `dataset montage`,
// `dataset explore` and the headless trace driver (ADR 0051).
//
// `render=1` hides all UI chrome (`.app.render-mode` in App.css) and records
// nothing on a person's behalf: no camera, view, or preference is written back.
// A writing capture perturbs the next run, overwrites the user's saved view, and
// puts a debounce floor under every headless run. Gate any new load-path write
// on `isCaptureSurface()` and pass the flag down, rather than re-reading the URL
// at the write site, so the rule stays findable from here.
//
// Not gated, since none records a person's choice: `history.replaceState` URL
// sync (dies with the page), `open_remote_dataset` (opening is the capture), and
// presence (live followers still see the capture's camera). A restore here
// applies its layout locally without broadcasting (`LayoutMutationMode` `local`).

/**
 * Whether this page is the chrome-free capture surface (`?render=1`).
 *
 * @param search Query string to read; defaults to the live `window.location`.
 *   Injectable so a test can state the URL it means.
 */
export function isCaptureSurface(search?: string): boolean {
  const raw = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(raw).get("render") === "1";
}
