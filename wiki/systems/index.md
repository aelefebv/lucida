# Systems

Major modules and subsystems within Lucida, split into two sub-folders by what they describe.

## Subdirectories

- [Crates](crates/index.md) — one article per Cargo workspace member. Crate boundaries are durable; each article describes what that crate owns.
- [Subsystems](subsystems/index.md) — web-internal modules and cross-cutting runtime concepts (chunk pipeline, GPU residency, planning, presence, …) that live inside `lucida-web/src/` or span `lucida-web` + `lucida-server`.

Cross-references are relative Markdown links to each article's file (`[lucida-core](crates/lucida-core.md)`, `[Chunk Lifecycle](../flows/chunk-lifecycle.md)`).
