// The chrome-free capture surface (`?render=1`), used by `dataset montage`,
// `viewer render` and the headless trace driver (ADR 0051).
//
// `render=1` has two meanings, and they are equally binding:
//
//   1. VISUAL — every piece of UI chrome is hidden and the canvas fills the
//      viewport, so a headless screenshot is pure data (see `.app.render-mode`
//      in App.css).
//   2. BEHAVIORAL — **the capture surface records nothing as if a person had
//      done it.** No camera, no view, no preference is written back on its
//      behalf. It reads persisted state freely; it never authors any.
//
// The rule exists because a capture surface that writes is wrong three ways at
// once (issue #923): it perturbs the next run, it overwrites the user's own
// saved view, and any debounce in front of the write puts a floor on every
// headless run's wall clock. Outwaiting a debounce fixes only the last of the
// three, so the write is removed rather than waited out.
//
// ANYTHING ADDED TO THE CAPTURE SURFACE LATER INHERITS THIS RULE. If you wire a
// new write on the load path, gate it on `isCaptureSurface()` and pass the flag
// down to whatever owns the write — do not gate it at the write site by
// sniffing the URL again, or the rule stops being findable from here.
//
// Deliberately NOT covered, and none of it records what a person chose:
//
//   - `history.replaceState` URL sync. A replaced URL lives and dies with the
//     page, so it cannot perturb a later run or anything a person sees.
//   - `open_remote_dataset`. Opening the dataset IS the capture, and the live
//     session is the only path to pixels. It records what is loaded, not what
//     anyone picked. Making a capture a non-participating session member is a
//     redesign, not a gate.
//   - Presence. The surface pushes its camera to peers like any other member,
//     so anyone actively following it moves with it. Nothing is written, but a
//     live follower does see the capture drive.
//
// `set_active_layout` used to belong on that list and no longer does: a restore
// on the capture surface applies the layout to this page's scene without
// broadcasting it (`LayoutMutationMode` = `local`, see savedView/types.ts), so
// the capture shows the layout the view asked for and the shared document keeps
// the one it had.

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
