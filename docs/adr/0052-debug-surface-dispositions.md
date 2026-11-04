# Debug surface dispositions

Status: Accepted. Carried out; `DebugPanel.tsx` was deleted in c278b3ef.
Amended by [#1048] and [#1061], which made the monitor a dock in the viewer and
moved the overlay toggles to the HUD legend.

## Context

The debug panel had ten tabs of gauges, one-off probes and controls, and shipped
in production. Some readouts showed a confident zero for something never
measured, which reads as "measured and fine". The monitor records timing while
the panel showed values right now, and the two overlap less than they appear to.

## Decision

Temporal observation moves to the monitor. A count that varies per tick moves to
the trace's per-tick aggregate table. Observation that is neither is deleted,
including probes with no ongoing consumer and views that duplicate a CLI read of
the same wire type. A readout that cannot measure what it shows is drawn as
absent, never as zero.

Mutation keeps one surface, Dev controls, named for mutation. Its writes work in
dev builds only, except "Reset all to defaults", because knobs persisted by an
earlier session keep steering the planner. Session-scoped knobs are marked as
such, since they reset on reload beside knobs that persist.

The monitor is observation only, a dock that overlays the canvas without
resizing it. The overlays stay a separate in-viewport layer, toggled from the
HUD legend in every build, because their value is registration with the pixels
beneath them. The two link through a published selection, a brushed window's
chunk set, and neither reads the other. Log categories keep their console
interface ([0012](0012-logging-conventions.md)) with no UI.

## Rejected alternatives

- Keeping the panel beside the monitor. Two observation surfaces would disagree
  about one pipeline, one of them gated on being watched.
- Marking gauges as absorbed by the monitor. That deletes capability under a
  label that says it was kept.
- New wire so `lucida debug state` can carry browser state. That spends budget
  to keep a gauge board nobody reads.
- Merging the overlays into the monitor. A timeline cannot register with the
  viewport.

[#1048]: https://github.com/aelefebv/lucida/issues/1048
[#1061]: https://github.com/aelefebv/lucida/issues/1061
