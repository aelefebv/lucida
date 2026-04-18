---
created: 2026-04-18
modified: 2026-04-18
---

# Glossary

Flat lookup of Lucida domain terms. Short definitions here; link to fuller articles when a term has its own page.

The repo also has a top-level `GLOSSARY.md` — that file remains authoritative until this glossary is fully populated. Once populated, the top-level `GLOSSARY.md` should redirect here.

## Terms

(To be populated by `repo-wiki-derive`, `repo-wiki-compile`, or by folding `GLOSSARY.md` content during a `repo-wiki-interview` session.)

Examples of terms expected:
- **Chunk** — atomic unit of volumetric data; see [[systems/index|Systems]]
- **Atlas** — GPU texture pool holding chunk payloads
- **Indirection buffer** — GPU lookup table mapping chunk coordinates to atlas slots
- **Epoch** — monotonic counter for ordering scene-state changes
- **DocumentState** — shared, persisted scene state (vs ephemeral presence)
- **Presence** — per-client ephemeral state (cursor, viewport, follow target)
- **Wanted-set** — chunks the planning domain decides should be resident
- **CpuCache** — host-side decoded-chunk cache feeding the GPU upload path
- **Plan / Planning domain** — module that computes wanted-sets and promotion order
- **Promotion** — moving a chunk from CpuCache into a GPU atlas slot
