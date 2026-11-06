# UI primitives on React Aria Components, Phosphor, and plain CSS

Status: Accepted.

## Context

Controls in the viewer were built one at a time, each with its own markup,
keyboard handling, and look. Popovers did not all close on Escape, focus did not
return to the control that opened them, icons were text glyphs or one-off SVGs,
and each feature listened for its own keys, so nothing stopped two features
claiming the same one. A redesign split across many parallel changes needs one
obvious way to build each kind of control.

## Decision

Interactive primitives wrap React Aria Components, which supply focus
management, keyboard interaction, focus return, typeahead, and screen-reader
semantics. The wrappers live in `lucida-web/src/ui/`, one per control, and each
exposes a small typed API rather than React Aria's full surface: a variant and a
size from fixed unions, a required `label` for anything without visible text,
and typed values (`Select<V>` and `SegmentedControl<V>` take string-literal
options). Layout passes through `className`; restyling a primitive does not.

Every overlay closes on Escape and returns focus to its trigger, and dialogs
trap focus. An icon-only button always has a tooltip that names it and shows its
shortcut, so a control is discoverable before it is fast.

Icons are Phosphor, regular weight, passed to primitives as components
(`icon={PlusIcon}`) so the primitive sets the size: 16px in controls, 20px in
rails.

Styles are plain CSS beside each primitive, using `lc-` classes, data
attributes for variants and states, and `--lc-*` tokens only
([0066](0066-semantic-theme-tokens-and-per-browser-appearance.md)). Base styles
for unmigrated buttons skip `lc-` classes, so the two coexist while screens
move over.

Keyboard shortcuts go through one registry (`src/ui/shortcuts.ts`). A component
binds a key with `useShortcut`, giving an id, a label, a group, and a handler;
one window listener dispatches. Keys stay quiet while focus is in a text field,
an editable element, or an open overlay. A combo taken twice in the same scope
throws in development, so a test that mounts both owners fails. A scope lets a
mode reuse global keys while it is active, the way fly mode reuses letters.
Combos are a typed grammar (`Mod+Shift+K`), and `Mod` is ⌘ on Apple platforms
and Ctrl elsewhere. The registry lists what is bound, which feeds the shortcut
sheet.

Toasts go through one region at the app root and a `toast()` call that works
outside React.

`/ui-gallery` renders every primitive in every state with theme, accent, and
density switchers. It is unlinked, loaded on demand, and is where the visual
language is reviewed.

## Rejected alternatives

- Hand-rolled primitives. Focus traps, focus return, and listbox keyboard rules
  are easy to get mostly right, and each feature would get them right
  differently.
- A component library with its own styling (MUI, Chakra, Mantine). Its theme
  would sit beside the tokens, and the canvas could not read it.
- Exposing React Aria directly to features. Its flexibility is the problem a
  shared look is meant to remove.
- A central table of every shortcut. It would let a test see every key without
  mounting anything, but every feature would edit one file, and the handler
  would live apart from the code it drives.
- An icon font or sprite sheet. Neither tree-shakes, and both lose the typed
  component.
