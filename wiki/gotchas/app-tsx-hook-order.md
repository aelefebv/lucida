---
created: 2026-04-18
modified: 2026-05-26
---

# App.tsx Hook Order and Callback Refs

## The footgun

`lucida-web/src/App.tsx` calls ~10 React hooks in a deliberate order. Reordering them — even for a "harmless" cleanup — silently breaks the app: the callbacks captured by earlier hooks won't see the latest values from later hooks.

The pattern uses **callback refs** (`bridgeCallbacksRef`, `datasetCallbacksRef`) populated *after all hooks return* but *before effects run on first render*. This breaks circular dependencies between hooks that need each other.

## Why circular deps exist

- `useBridge` needs to call layer-init when a dataset opens.
- `useDatasetSettings` needs the bridge to send commands.
- `useBridge` defined before `useDatasetSettings` would mean `useDatasetSettings` doesn't exist yet when `useBridge` is created.
- `useDatasetSettings` defined before `useBridge` would mean the bridge's send-command callback doesn't exist yet.

Resolution: define **callback refs at the top**, populated with no-op stubs initially. Hooks read from the refs (always current at call time) rather than from closures (frozen at hook-creation time). After all hooks return, populate the refs with the real callbacks.

## Specific order

(See `App.tsx` for the canonical sequence. Roughly:)

1. **Foundation hooks** — `useWasmScene`, `useRenderClient`, `useLayout`. These have no inter-dependencies and provide the WASM scene, the GPU worker client, and the layout state.
2. **Shared refs and lifted state** — `datasetsRef`, `selectedDatasetId`, `cameraMode`, version counters.
3. **Callback refs** — `bridgeCallbacksRef`, `datasetCallbacksRef` initialized with no-op stubs.
4. **Domain hooks** — `useDimensions`, `useDatasetSettings`, `useBridge`, `useDatasets`, `useIntensityBatcher`. Each reads from earlier hooks' returns and from the callback refs.
5. **Callback ref population** — assign real implementations to the refs (`bridgeCallbacksRef.current = {...}`, etc.).
6. **Effects and renders** — by the time effects run, the refs have real callbacks.

## What to do (and not do)

- **Don't move a hook above another** without checking what it reads. Even moving a "leaf" hook can starve the callback refs of the values they need.
- **Don't replace callback refs with `useState`-returned callbacks** unless you understand why the refs were chosen. State-returned callbacks change identity on each render and force re-renders downstream.
- **Don't try to "extract a custom hook"** that wraps multiple of these — the order constraint is structural; abstracting it in moves the constraint to a less-visible place.
- **Do read the hook signatures carefully** before reordering. The required-input list reveals the dependency.

## Why this is fragile

React doesn't enforce hook order semantics beyond "same order on every render." The compiler can't catch "this hook needs that hook's value." Tests would catch the bug, but the failure mode (no-op callback fires; nothing happens) is silent enough that integration tests don't always see it.

The pragma: **treat App.tsx hook order as load-bearing**. Refactor with care.

## Related

- [[lucida-web]]
- React docs on hook ordering and refs
