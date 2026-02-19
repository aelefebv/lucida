# Lucida Component Map

## Current (Implemented in Repo)

1. Protocol contract layer:
   - `protocol/openrpc/lucida.v1.openrpc.json`
   - `protocol/schemas/**/*.schema.json`
   - `protocol/command-log/lucida.commandlog.v1.schema.json`
2. Protocol docs and tests:
   - `docs/protocol/README.md`
   - `tests/protocol/*`
3. Python protocol model generation:
   - `python/lucida_sdk/protocol/generate_models.py`
   - `python/lucida_sdk/protocol/generated/models.py`
4. In-memory core runtime (Step 02):
   - `python/lucida_core/__init__.py`
   - `python/lucida_core/engine.py`
   - `python/lucida_core/errors.py`
5. Step 03 IO subsystem:
   - `python/lucida_core/io/backends.py`
   - `python/lucida_core/io/cache.py`
   - `python/lucida_core/io/metadata.py`
   - `python/lucida_core/io/scheduler.py`
6. Step 04/05 deterministic planning runtime:
   - `python/lucida_core/render2d/*`
   - `python/lucida_core/render3d/*`
   - `python/lucida_core/engine.py`
7. Step 05 Rust renderer scaffold kickoff:
   - `rust/Cargo.toml`
   - `rust/crates/lucida-render-wgpu/*`
   - `rust/crates/lucida-render-shell/*`

## Planned Runtime Components (Roadmap-Aligned)

1. `lucida-core` (state graph, transforms, command processing).
2. `lucida-render-wgpu` (2D/3D/points rendering).
3. `lucida-daemon` (sessions, RPC routing, event stream).
4. `lucida-py` (SDK and notebook integration).
5. Packaging/release layer (installers and CI gates).
6. Phase-2 remote web gateway.

## Dependency Flow (High-Level)

1. `SPEC.md` and `specs/roadmap/*` define target behavior.
2. Protocol contracts define API-level boundaries.
3. Runtime components implement the contracts.
4. SDK and external tooling consume the contracts.
5. Context layer tracks what is implemented and validated.
