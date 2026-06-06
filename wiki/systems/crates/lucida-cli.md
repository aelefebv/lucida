---
created: 2026-04-18
modified: 2026-06-06
---

# lucida-cli

A WebSocket client for [[lucida-server]] that reads document state, applies viewport commands, and emits presence updates — everything a browser does, except via the terminal.

Useful for scripted demos, integration testing, and steering peers (a CLI session can take over another client's viewport via `--steer`).

## Why a CLI client

Three concrete uses:

1. **Headless scripting** for reproducible viewport states ("pan to (1000, 500), zoom to 4×, set z=42").
2. **Multi-user testing** — start one in a terminal alongside browser tabs and verify follow/steer behavior end-to-end.
3. **Snapshots** — `lucida-cli state` dumps document and peers as JSON for inspection without standing up a viewer.

The CLI also serves as the simplest possible reference implementation of the wire protocol: ~200 lines that exercise snapshot ingestion, presence emission, and steering.

## Subcommands

Defined via `clap` derive in `main.rs`:

- `state` — print snapshot's document + peers as JSON
- `open <url>` — ask the server to open a dataset and wait for `DatasetOpened` or `OpenDatasetFailed`
- `visible-chunks` — reconstruct the Scene locally and print the chunk plan
- `pan`, `zoom`, `set-zoom`, `center` — 2D viewport commands
- `set-mode-2d`, `set-mode-3d`, `rotate` — 3D camera commands
- `slice` (axis: t/z/c) — index into a slice axis
- `contrast`, `gamma` — display adjustments
- `steer --client <id>` — tell another client to follow this CLI

Global flags:
- `--server <url>` — defaults to `ws://localhost:9876/ws`
- `--peer <id>` — start from a peer's viewport instead of defaults
- `--steer <id>` — make a client follow before sending the command

## Interactions

- Connects via `tokio-tungstenite` and ingests one `Snapshot` message before doing anything else (sequential by design — see `connection::connect`).
- Builds a [[lucida-core]] `Scene` from the snapshot, applies the requested `ViewportCommand`, and sends the resulting `ClientMessage::Presence` (camera + view + display).
- `open <url>` is the first document-side command exposed by the CLI. It sends `ClientMessage::OpenRemoteDataset` and stays connected until the server broadcasts `DatasetOpened` or unicasts `OpenDatasetFailed`. The browser and CLI both observe the same `DatasetOpened` broadcast.
- Other document mutations are still not exposed by the CLI; the remaining command surface is viewport/presence-oriented.

## Invariants

- **The CLI reconstructs derived state on every invocation** via `Scene::rebuild_derived` after restoring document state from snapshot. Derived state isn't serialized over the wire (correctly so — it's a function of document state and layouts).
- **Peer adoption is opt-in** via `--peer`. With no flag, the CLI uses defaults; if any peer exists, it adopts the first peer's viewport. This means scripted CLIs may end up at unexpected positions if a browser is also connected.
- **One command per invocation.** The CLI is a one-shot — it connects, sends, and exits. No long-lived sessions.
- **Dataset open is the exception to "send and exit."** `open <url>` waits because the server import runs asynchronously and the useful success signal is the later broadcast, not the WebSocket write.

## Gotchas

- **Steer requires the target client to not already be following someone.** The server's follow validation rejects chains where the new follower would create or join an existing chain in an invalid way. See `Session::set_follow` in [[lucida-server]].
- **`zoom` semantics differ between camera modes.** In Slice (2D), `factor` is multiplicative. In Arcball/Fly (3D), it's converted to `Zoom3D { delta: 1/factor - 1 }`. Same flag, different math.
- **No reconnection logic.** The CLI either connects-then-runs or fails immediately. There's no retry loop because every invocation is a one-shot.
