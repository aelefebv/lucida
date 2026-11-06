# Semantic theme tokens and per-browser appearance

Status: Accepted.

## Context

The viewer's styles held about 700 hard-coded colors from unrelated palettes,
and its only theme mechanism was a `prefers-color-scheme` block that recolored
the page and a few buttons. Canvas overlays drew in colors of their own. There
was no way to offer a light theme, an accent, or a denser layout, and no single
place a deployment could restyle.

## Decision

Every UI color, size, radius, shadow, duration, and layer is a CSS custom
property named `--lc-*`, defined once in `lucida-web/src/theme/tokens.css` and
listed in `tokens.ts`. Names are semantic, saying what a value is for
(`--lc-surface-2` is popovers and dialogs, `--lc-text-muted` is secondary text),
never what it looks like. Components style with tokens and nothing else. A new
need adds a token with a dark and a light value; a test holds the CSS and the
list together and checks body-text contrast on every surface.

Appearance is four choices, written as attributes on `<html>`:

- Theme: Dark (the default), Light, or System, which follows the OS setting
  live. `data-theme` carries the resolved `dark` or `light`.
- Accent: one of six presets or a hex value. It is the only accent input; hover,
  subtle fill, accent text, focus ring, and text on the accent derive from it
  with `color-mix()` and relative `oklch()`, so a custom accent stays legible.
- Density: comfortable or compact, which changes control heights.
- Canvas background: black (the default), dark gray, white, or the theme's
  background. It is separate from the theme because image data is judged
  against it, and colors drawn on the canvas take their contrast from it.

Data colormaps are never themed.

Canvas and GPU code reads the same tokens. `readColorToken` resolves a token to
sRGB through the browser, since a derived token's computed value is an
unresolved expression, and `subscribeAppearance` says when to read again. The
render worker cannot read styles, so the render loop sends it the canvas colors
before its first frame and after every appearance change. Layers blend with
each other over a transparent canvas and the background goes beneath the
finished stack, so an additive layer never brightens a light background.

Preferences live per browser in one versioned localStorage entry. A module
defines its own preference beside itself with a typed builder and reads it with
`usePreference`, so adding one edits no central list. A stored value that fails
its parser reads as the default. A shape change bumps the version and adds a
migration; an entry from a newer build is read as-is and keeps its version.

An inline script in `index.html` applies the stored appearance before first
paint, so a reload never flashes the wrong theme. It duplicates a few lines of
`appearance.ts`, and a test runs both against the same storage. The capture
surface reads defaults and persists nothing, so a capture looks the same
whichever browser took it.

A deployment sets defaults with `setPreferenceDefaults`, under any stored
choice, and overrides tokens with a stylesheet loaded after `tokens.css`. End
users pick presets, never individual tokens.

## Rejected alternatives

- A styling framework or CSS-in-JS theme object. Either puts a build-time or
  runtime layer between a value and the canvas code that needs it, and custom
  properties already cascade, animate, and override per deployment.
- Literal palette names (`--gray-800`). They say nothing about use, so a light
  theme has to remap each call site instead of each token.
- Hand-picked hover, subtle, and focus colors per accent. Six presets would be
  manageable, but a custom hex would have no correct values.
- Applying the theme from React. The module script runs after the first paint,
  which shows a flash of the dark theme on every light-theme reload.
- One localStorage key per preference. Nothing would version them together,
  and a reshape would need a migration per key.
- Syncing preferences through the server. Possible later; per-browser storage
  needs no wire and works signed out.
