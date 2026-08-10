# Monitor prototype — THROWAWAY (issue #892)

Three variants of the pipeline monitor's top-level view, switchable via `?variant=`, on a
throwaway page at `/monitor-prototype.html`.

**This is not instrumentation and it is not production code.** It has no tests, no error
handling, and a synthetic trace. Nothing here should be promoted as-is; the validated
decisions are written up in `docs/research/timeline-surface.md` and summarised on the
issue.

```
pnpm --filter lucida-web dev
open 'http://localhost:5173/monitor-prototype.html?variant=C&run=warm'
```

`←` / `→` cycle variants. The floating bar switches the run fixture, replays the recording
in real time, exports Chrome Trace Event JSON for `ui.perfetto.dev`, and reports the
monitor's own render cost.

The page is served by the dev server only — it is not listed in vite's build inputs, so a
production build never emits it.

| file | what it is |
| --- | --- |
| `traceModel.ts` | the columnar lifecycle table from ADR 0047: phases, stamps, tables |
| `syntheticTrace.ts` | two runs (cold open / warm re-open) calibrated to #888 and #899 |
| `analysis.ts` | per-phase rollup and derived callouts — shared by every variant |
| `chromeExport.ts` | the Chrome Trace Event projection, and why its emit shape is what it is |
| `VariantA.tsx` | "the wall" — every span, lanes over time, canvas |
| `VariantB.tsx` | "the budget" — stacked wall-clock first, spans on demand |
| `VariantC.tsx` | "the verdict" — callouts first, timeline as drill-in |
| `useReplay.ts` | replays a finished trace in real time so live behaviour is judgeable |
