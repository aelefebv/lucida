# Lucida HTTP and Transport

Version: 0.1 draft  
Date: 2026-02-28  
Status: First-pass transport and wire-level specification aligned to `lucida_spec.md`, `lucida_protocol_and_schemas.md`, `lucida_sequences.md`, and `lucida_storage_layout.md`

## 1. Purpose

This document defines Lucida's network and transport contract.

It answers five questions:

1. How do clients discover the engine, authenticate, and attach to sessions?
2. How are authoritative control-plane messages framed, ordered, retried, and replayed?
3. How are chunk payloads, previews, bitsets, and metadata fetched over HTTP?
4. How are derived-layer payloads uploaded and published without making the control plane carry large binary blobs?
5. How does the same logical protocol support both engine-served LAN deployments and future static/object-backed deployments?

This document is normative for:
- baseline transport choices
- endpoint shapes and URL conventions
- message framing and content types
- authentication and permission binding at transport level
- caching and immutability rules for network-visible resources
- upload and publish staging behavior

It is not normative for:
- a specific web framework or RPC library
- a specific TLS termination strategy
- a single load balancer or CDN topology
- a single browser/runtime implementation of codecs or GPU upload behavior

---

## 2. Design principles

1. **Authoritative control plane, cacheable data plane.** State changes flow through the engine; payload bytes flow through immutable HTTP objects.
2. **Browser-first compatibility.** The baseline transport must work in ordinary browsers on ordinary networks.
3. **Transport should not reopen product decisions.** Shared-scene lease behavior, per-client view state, generation immutability, and sparse derived semantics are already fixed by higher-level docs.
4. **Large binary data never belongs on the control plane by default.** Control messages carry descriptors, manifests, and references; the data plane carries bytes.
5. **Concrete URLs must be immutable.** Any payload published at a concrete URL must never change in place.
6. **Reconnect must be routine.** Clients must be able to reconnect, resync, and continue after transient network failures.
7. **One logical protocol, multiple deployments.** The same logical chunk key must map to LAN engine-served endpoints today and static/object-backed URLs later.

---

## 3. Baseline transport choices

## 3.1 Baseline stack

Lucida's baseline transport stack is:
- **HTTP/2 or HTTP/1.1** for the data plane and REST-like resource endpoints
- **WebSocket** for the control plane

Future-compatible options:
- **HTTP/3** MAY be used where available
- **WebTransport** MAY be added later, but it is not the baseline for this spec version

Rationale:
- WebSocket is broadly available in browsers, Jupyter contexts, and CLIs
- HTTP GET/HEAD/PUT are easy to cache, proxy, debug, and secure
- The control/data plane split aligns naturally with Lucida's state/payload split

## 3.2 Control-plane framing

The control plane uses **UTF-8 JSON text frames** only.

Rules:
- All control-plane messages MUST conform to the envelopes defined in `lucida_protocol_and_schemas.md`
- Control-plane messages MUST NOT carry chunk payload bytes, preview images, or object-table bitsets larger than a small threshold
- Message ordering is defined by `session_rev`, `scene_rev`, and `view_rev`, not by TCP/WebSocket frame timing alone

Large or high-frequency binary objects MUST travel over HTTP, even if a WebSocket is already open.

## 3.3 Data-plane framing

The data plane uses ordinary HTTP responses with explicit content types.

Resource classes:
- chunk payloads (`tile2d`, `brick3d`)
- preview images
- label-visibility bitsets
- metadata query results
- Scene files and Context Packages
- upload staging objects and manifests

---

## 4. URI namespace and service roots

## 4.1 API root

All engine-served routes are rooted at:

```text
/v1/
```

Versioning rules:
- Major wire-contract changes MUST use a new top-level version prefix (for example `/v2/`)
- Backward-compatible additions MAY be introduced within the same `/v1/` namespace

## 4.2 Recommended top-level endpoint families

```text
/v1/info
/v1/sessions
/v1/sessions/{session_id}
/v1/data/...
/v1/metadata/...
/v1/uploads/...
/v1/scenes/...
/v1/context-packages/...
/v1/admin/...
```

Not every deployment must expose every family, but the logical resource model should remain consistent.

---

## 5. Content types

Recommended media types:

- Control-plane JSON messages: `application/json`
- Session snapshot JSON: `application/json`
- Scene file: `application/vnd.lucida.scene+json`
- Context package archive: `application/vnd.lucida.context+zip`
- Chunk payload: `application/vnd.lucida.chunk`
- Visibility bitset: `application/vnd.lucida.bitset`
- Metadata query result: `application/vnd.lucida.metadata+json`
- Upload manifest: `application/vnd.lucida.upload-manifest+json`
- Preview image: `image/webp` or `image/png`

Notes:
- Chunk payloads are already codec-compressed internally; servers SHOULD NOT apply additional HTTP content encodings such as gzip or brotli to those payloads.
- The `Content-Type` of quantitative chunk payloads identifies the wrapper format; the internal chunk header identifies dtype, shape, codec, and byte counts.

---

## 6. Authentication and authorization at transport level

## 6.1 Exposure modes

Lucida supports two read-access exposure modes per session:
- **open-view**: any reachable client may attach in `view` mode
- **token-view**: a `view_token` is required to attach in `view` mode

Write access requires a **control token**. Administrative actions may require a separate admin token.

## 6.2 Browser-safe token handling

Because browser WebSocket APIs do not reliably support custom headers, the baseline browser flow is:

1. A shareable link MAY include a token in the URL fragment, not the query string:
   - `https://host/app#session=sess_123&view_token=vtok_...`
2. Client-side code reads the fragment.
3. The WebSocket opens without secrets in the URL.
4. The client sends `auth.bind` as the first authenticated control-plane message.

Non-browser clients MAY also send tokens using standard HTTP `Authorization` headers where supported.

## 6.3 Token classes

Transport-visible token types:
- `view_token`
- `control_token`
- `admin_token`

A client MAY begin attached as `view` and later bind a `control_token` to upgrade its effective capabilities.

## 6.4 Transport-level permission mapping

Permissions map to transport behavior as follows:

- `view`
  - may attach to session
  - may receive snapshots/events
  - may fetch data-plane payloads
  - may mutate own per-client view state by sending `client_view` commands

- `control`
  - everything in `view`
  - may request/steal lease
  - may issue `scene_shared` commands while holding lease
  - may publish derived chunks without lease

- `admin`
  - everything in `control`
  - may call administrative endpoints and admin-scoped commands

---

## 7. Engine discovery and session lifecycle endpoints

## 7.1 Engine info

```http
GET /v1/info
```

Returns engine capabilities and defaults, such as:
- engine version
- protocol schema version(s)
- supported codecs
- supported control-plane transport(s)
- whether LAN mode is enabled
- whether default view mode is open or token-gated
- max upload object size
- server-side limits and advisory cache budgets

This endpoint SHOULD be readable without authentication unless the deployment is fully locked down.

## 7.2 Session listing

```http
GET /v1/sessions
```

Returns the sessions visible to the caller under current credentials.

By default in open-view LAN mode, the response MAY include all viewable sessions.

## 7.3 Session summary

```http
GET /v1/sessions/{session_id}
```

Returns non-streaming summary information:
- session metadata
- exposure mode
- current lease holder
- source count and layer count
- current scene revision
- whether the session accepts new attachments

## 7.4 Session snapshot over HTTP

```http
GET /v1/sessions/{session_id}/snapshot
```

Returns a full `session.snapshot` payload as JSON.

This endpoint is useful for:
- debugging
- CLI one-shot reads
- client recovery when WebSocket replay is unavailable

For continuously interactive clients, WebSocket snapshot-on-attach remains primary.

---

## 8. Control-plane WebSocket endpoint

## 8.1 Endpoint

Baseline endpoint:

```text
GET /v1/sessions/{session_id}/connect
Upgrade: websocket
```

The socket attaches to a single session.

A future engine MAY offer a multiplexer endpoint such as `/v1/connect`, but that is not required in this spec version.

## 8.2 Connection phases

A control-plane connection proceeds through these phases:

1. **socket_open**
   - TCP/TLS and WebSocket upgrade complete

2. **hello negotiation**
   - client sends capabilities and desired attach behavior
   - server returns accepted protocol/schema version and initial transport parameters

3. **auth bind**
   - client optionally binds view/control/admin token(s)
   - server confirms effective permission class

4. **session attach / resume**
   - client requests snapshot or replay from a known `session_rev`
   - server either replays the gap or sends a fresh snapshot

5. **steady state**
   - command/ack/event/heartbeat traffic

## 8.3 Recommended opening exchange

### Client -> Server: `client.hello`

Purpose:
- declare supported protocol versions
- advertise codec support and WebGPU/device budgets
- provide preferred resume point if reconnecting

### Server -> Client: `server.hello`

Purpose:
- choose schema/protocol version
- advertise server limits
- indicate whether auth is required before attach
- provide heartbeat interval and replay window limits

### Client -> Server: `auth.bind`

Purpose:
- provide `view_token`, `control_token`, and/or `admin_token`
- tokens may be omitted in open-view mode

### Server -> Client: `auth.result`

Purpose:
- confirm effective permission class
- indicate any token expiry or revocation status

### Client -> Server: `session.attach`

Purpose:
- request attach behavior:
  - fresh snapshot
  - replay from `last_seen_session_rev`
  - attach with existing `client_id` if reconnecting

### Server -> Client: `session.snapshot` or replay stream

Purpose:
- deliver authoritative state baseline
- optionally replay missed events if the server can do so safely

## 8.4 Reconnect and replay

Reconnect behavior MUST support transient loss.

Rules:
- A reconnecting client SHOULD present prior `client_id` and `last_seen_session_rev`
- If the server still retains replay history covering that revision gap, it MAY replay events starting at `last_seen_session_rev + 1`
- If not, the server MUST send a fresh `session.snapshot`
- Clients MUST tolerate either path

Replay retention is an implementation detail, but servers SHOULD retain enough recent history to make ordinary reconnects cheap.

## 8.5 Heartbeats

WebSocket connections MUST support keepalive/heartbeat messages.

Recommended behavior:
- server advertises `heartbeat_interval_ms`
- either side MAY send `heartbeat` / `pong`
- absence of heartbeat or any traffic over a configurable interval MAY trigger reconnect

Heartbeat payloads MUST remain small and MUST NOT carry authoritative state.

## 8.6 Event batching

Servers MAY batch events into a single frame for efficiency.

Rules:
- batched events MUST remain in ascending `session_rev` order
- clients MUST process batched events as if they arrived individually
- batching MUST NOT delay lease changes, auth revocations, or critical error notifications beyond a small latency budget

Recommended batch trigger:
- max N events OR max T milliseconds since first pending event

## 8.7 Ordering guarantees

Ordering is defined by revisions, not transport timing:
- `session_rev` totally orders all authoritative events
- `scene_rev` orders shared scene edits
- `view_rev` orders authoritative updates for one client's view state
- `write_rev` orders writes to one mutable derived layer branch

Clients MUST use revisions rather than arrival order when reconciling stale or duplicated frames.

---

## 9. Control-plane message classes and transport behavior

This section does not redefine schemas; it defines transport-level handling.

## 9.1 Command messages

Command frames:
- MUST be JSON
- MUST carry `request_id`, `client_id`, and `client_seq`
- SHOULD remain small (state references, not payload bytes)

Retry rules:
- clients MAY retry commands using the same `idempotency_key`
- engines SHOULD treat identical idempotency keys from the same client as replay-safe where the operation semantics allow it

## 9.2 Command acks

Acks confirm acceptance or rejection of a command.

Rules:
- acceptance does not imply downstream job completion
- long-running commands MUST later produce completion/failure events
- if a command is accepted and later fails asynchronously, the async failure MUST reference the original request or resulting object IDs where possible

## 9.3 Error messages

Errors on the control plane use the standard error envelope.

Transport mapping guidelines:
- schema/validation errors: send control-plane `error`; do not necessarily close socket
- auth failure after connection: send `error` and MAY close socket depending on severity
- token revocation mid-session: send `permissions.updated`; if access is no longer valid, the server MAY close socket after notification

## 9.4 Snapshot messages

Snapshots are heavyweight but infrequent. They are authoritative full-state baselines.

Servers MUST send a snapshot when:
- a client attaches fresh
- replay gap cannot be satisfied
- server requests a forced resync after internal compaction or replay-window loss

Clients MUST treat the most recent snapshot as authoritative and clear any stale local assumptions not reintroduced by the snapshot.

---

## 10. HTTP data plane

## 10.1 General rules

The data plane serves immutable payloads addressed by concrete generation-specific URLs.

Rules:
- data-plane URLs MUST resolve to generation-specific content, not mutable aliases such as `latest`
- `GET` and `HEAD` MUST be supported for chunk payloads and previews
- data-plane fetches SHOULD be cacheable
- data-plane payloads MUST NOT require a control-plane connection to remain valid once authorized and resolved

## 10.2 Canonical chunk URL form

The canonical logical form is defined in `lucida_protocol_and_schemas.md`:

```text
/v1/data/{dataset_id}/{generation_id}/{layer_id}/{representation}/lod/{lod}/idx/{index_key}/c0/{c0}/chunk/{coord_key}
```

Examples:

```text
/v1/data/ds_.../gen_.../lay_.../tile2d/lod/0/idx/position=3;round=1;t=0;z=120/c0/0/chunk/y=17;x=42
/v1/data/ds_.../gen_.../lay_.../brick3d/lod/2/idx/position=3;round=1;t=0/c0/4/chunk/z=4;y=9;x=11
```

Engine implementations MAY internally redirect, rewrite, or proxy these URLs to concrete object-store paths, but clients SHOULD see stable logical URLs unless signed/static URLs are being handed out explicitly.

## 10.3 Derived-layer URL stability

Derived layers are mutable at the logical layer level, but concrete payload URLs MUST remain immutable.

Therefore engine-served data URLs for mutable derived content SHOULD include an immutable write discriminator such as:
- `write_rev`
- `object_epoch`
- both

Example pattern:

```text
/v1/data/{dataset_id}/{generation_id}/{layer_id}/{representation}/lod/{lod}/idx/{index_key}/c0/{c0}/wr/{write_rev}/chunk/{coord_key}
```

This prevents stale cache poisoning when a derived layer chunk is overwritten.

## 10.4 Preview URLs

Recommended preview path:

```text
/v1/data/{dataset_id}/{generation_id}/{layer_id}/preview2d/lod/{lod}/idx/{index_key}/chunk/{coord_key}
```

If previews are precomposited and channel-independent, `c0` MAY be omitted.

## 10.5 Metadata and bitset URLs

Recommended endpoints:

```text
GET /v1/metadata/{dataset_id}/{generation_id}/{layer_id}/objects/query
GET /v1/metadata/{dataset_id}/{generation_id}/{layer_id}/objects/rows/{id}
GET /v1/metadata/{dataset_id}/{generation_id}/{layer_id}/filter-results/{filter_result_id}
```

Transport behavior:
- metadata query results are JSON
- filter-result payloads MAY be JSON descriptors that point to a bitset URL
- bitset payloads SHOULD be fetched over HTTP with a concrete revision-specific URL

Recommended bitset path:

```text
/v1/metadata/{dataset_id}/{generation_id}/{layer_id}/bitsets/{metadata_rev}/{filter_hash}
```

This URL MUST identify a single stable filter result against a single metadata revision.

---

## 11. HTTP methods and status code guidance

## 11.1 Read endpoints

Use:
- `GET` for body retrieval
- `HEAD` for metadata-only inspection of immutable objects

Recommended status usage:
- `200 OK`: resource returned
- `204 No Content`: successful request but intentionally empty logical payload (rare)
- `401 Unauthorized`: missing/invalid credentials where required
- `403 Forbidden`: authenticated but not allowed
- `404 Not Found`: object not found
- `409 Conflict`: stale precondition or generation mismatch when applicable
- `410 Gone`: object existed but was garbage-collected and is no longer available
- `423 Locked`: optional for lease-related REST endpoints, though control-plane error envelopes remain primary
- `429 Too Many Requests`: rate-limited
- `500/502/503`: service-side failure

## 11.2 Cache headers

Immutable generation-specific chunk payloads SHOULD be served with:

```text
Cache-Control: public, max-age=31536000, immutable
ETag: "sha256:..."
```

When auth policies require stricter behavior, `private` MAY replace `public`, but immutability SHOULD remain.

Snapshots, session summaries, and admin endpoints SHOULD be served with:

```text
Cache-Control: no-store
```

Upload staging objects MUST be served/accepted with `no-store` semantics.

## 11.3 Range requests

Lucida does not require byte-range requests for chunk payloads. Chunking is already the primary unit of random access.

Servers MAY support `Range` for large artifacts such as Context Packages, but chunk fetches SHOULD generally be whole-object GETs.

---

## 12. Upload and staging plane for derived publishing

## 12.1 Rationale

Derived-layer publishing should not push binary chunk payloads through the control plane.

Baseline model:
1. client asks engine to prepare upload slots
2. engine returns one or more upload targets and object refs
3. client uploads payloads over HTTP PUT/POST
4. client issues `publish.write_chunks` referencing staged objects
5. engine validates, links/promotes, and emits publish events

## 12.2 Upload prepare

Recommended control-plane command:
- `upload.prepare`

Inputs:
- expected object count
- expected per-object metadata (dtype, shape, representation, optional checksum)
- target derived layer or intent to create new layer

Output:
- `upload_session_id`
- per-object `upload_url` or `upload_path`
- `staged_object_ref` tokens
- max TTL / expiry
- any required checksum or content-length constraints

## 12.3 Upload object endpoint

Recommended engine-served form:

```text
PUT /v1/uploads/{upload_session_id}/objects/{object_id}
```

Alternative for static/object-backed deployments:
- engine returns presigned object-store URLs
- the logical protocol remains unchanged

Rules:
- clients MUST upload payload bytes exactly once per object unless retry is explicitly allowed
- uploads SHOULD include checksum headers when available
- staged objects are not visible in the scene until a publish command references them successfully

## 12.4 Upload object content types

Uploaded chunk payloads SHOULD use the same payload wrapper/content type as normal chunk payloads:
- `application/vnd.lucida.chunk`

The payload body is already codec-compressed and self-describing via internal header.

## 12.5 Publish command references staged objects

`publish.write_chunks` SHOULD reference staged objects via immutable `staged_object_ref` values rather than inlining bytes.

Each published chunk reference MUST include:
- logical target chunk identity
- staged object ref
- checksum
- optional stats
- publish extent policy already resolved at recipe/batch level

## 12.6 Upload completion and garbage collection

Staged uploads are temporary.

Rules:
- unreferenced staged objects MUST expire after TTL
- successful publish promotes or links staged objects into durable generation/write-rev namespace
- failed publishes MUST NOT leak partially visible chunks
- engine SHOULD garbage-collect abandoned upload sessions and emit observability counters

## 12.7 Local fast path

If compute runs co-located with the engine, implementations MAY provide a faster upload path (for example direct filesystem handoff or zero-copy local registration), but the logical API should still present staged-object references so higher-level flows remain unchanged.

---

## 13. Cutout and metadata transport behavior

## 13.1 Cutout responses carry references, not bytes

A cutout request returns:
- RegionRecipe metadata
- payload descriptors or URLs for each required chunk
- optional local fast-path hints when co-located

Cutout responses MUST NOT inline all chunk bytes by default.

## 13.2 Chunked compute clients

A compute client is expected to:
- fetch chunk payloads directly from the data plane
- materialize chunked arrays locally or near compute
- publish results through the upload/publish path

This keeps the engine scalable and transport semantics simple.

## 13.3 Metadata query transport

Metadata query results may be returned either:
- directly on the control plane for small interactive results, or
- as HTTP JSON responses for larger result sets

Recommended rule:
- rows or aggregates under a small threshold MAY be returned inline on control plane
- filter result bitsets and large row sets SHOULD use HTTP references

---

## 14. Scenes and Context Packages over HTTP

## 14.1 Scene file endpoints

Recommended endpoints:

```text
GET /v1/scenes/{scene_id}
PUT /v1/scenes/{scene_id}
POST /v1/scenes
```

Behavior:
- scene files are JSON
- live scenes and pinned scenes are both representable
- export/share tools SHOULD warn or pin when serializing live scenes for collaborators

## 14.2 Context Package endpoints

Recommended endpoints:

```text
GET /v1/context-packages/{context_id}
POST /v1/context-packages
```

Context Packages are typically ZIP-like archives (`application/vnd.lucida.context+zip`).

Servers MAY generate them asynchronously; if so, control-plane or HTTP job-status signaling MUST indicate readiness.

---

## 15. Static object mode and signed URLs

## 15.1 Motivation

For cloud or large fan-out viewing, the engine should be able to hand clients object-store/CDN URLs instead of proxying every payload.

## 15.2 Contract

The logical `ChunkKey` stays the same.

The engine MAY return either:
- engine-local URL paths under `/v1/data/...`, or
- absolute/signed URLs to static objects

Clients MUST treat both as opaque fetch targets once resolved.

## 15.3 Signed URL requirements

If signed URLs are used:
- they SHOULD be generation-specific and immutable
- TTL SHOULD be long enough to support ordinary interaction without constant refresh
- the engine SHOULD refresh or reissue URLs as needed without changing logical chunk identity

---

## 16. Backpressure, rate limits, and retry

## 16.1 Control plane

Servers MAY rate-limit pathological command streams.

Recommended behavior:
- reject with `quota_exceeded` or `429`-equivalent error when a client exceeds sane limits
- never silently drop accepted commands
- maintain idempotency guidance for retry-safe commands

## 16.2 Data plane

Clients SHOULD self-limit concurrent chunk fetches based on:
- current viewport priority
- network conditions
- decode throughput
- GPU upload throughput

Servers MAY advertise advisory concurrency limits via `/v1/info` or `server.hello`.

## 16.3 Upload plane

Uploads MAY be rate-limited independently from reads.

Recommended status usage:
- `413 Payload Too Large` for oversize objects
- `429 Too Many Requests` for upload concurrency/rate limits
- `409 Conflict` for expired or invalid upload sessions

---

## 17. Security and privacy considerations

## 17.1 Open-view LAN mode

Open-view LAN mode is convenient but should be an explicit session/engine exposure choice, not an accidental default on non-localhost interfaces.

## 17.2 Share links

View-token share links SHOULD place tokens in URL fragments where possible to avoid token leakage into intermediate HTTP logs.

## 17.3 Control tokens

Control tokens SHOULD never be placed in ordinary browser URLs.
They SHOULD be entered or stored through explicit client UI and bound via `auth.bind`.

## 17.4 Data visibility

Tile/brick streaming exposes underlying data, not just final pixels.
If a deployment wants pixel-only broadcast, that must be implemented as a separate rendering mode outside this baseline transport spec.

## 17.5 TLS

TLS SHOULD be used whenever traffic leaves trusted localhost boundaries. If the engine does not terminate TLS itself, it SHOULD be expected to run behind a reverse proxy that does.

---

## 18. Recommended baseline endpoint set

A minimal-but-complete engine-served transport surface should expose:

### Discovery and session
- `GET /v1/info`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `GET /v1/sessions/{session_id}/snapshot`
- `WS  /v1/sessions/{session_id}/connect`

### Data plane
- `GET|HEAD /v1/data/{dataset_id}/{generation_id}/{layer_id}/{representation}/lod/{lod}/idx/{index_key}/c0/{c0}/chunk/{coord_key}`
- `GET|HEAD /v1/data/{dataset_id}/{generation_id}/{layer_id}/preview2d/lod/{lod}/idx/{index_key}/chunk/{coord_key}`

### Metadata
- `GET /v1/metadata/{dataset_id}/{generation_id}/{layer_id}/objects/query`
- `GET /v1/metadata/{dataset_id}/{generation_id}/{layer_id}/objects/rows/{id}`
- `GET /v1/metadata/{dataset_id}/{generation_id}/{layer_id}/bitsets/{metadata_rev}/{filter_hash}`

### Upload/publish support
- `PUT /v1/uploads/{upload_session_id}/objects/{object_id}`

### Artifacts
- `GET|PUT|POST /v1/scenes...`
- `GET|POST /v1/context-packages...`

This set is sufficient for browser, CLI, and notebook integration.

---

## 19. Open issues intentionally left for implementation choice

The following are intentionally not over-specified in this document:
- exact WebSocket subprotocol name
- exact heartbeat interval values
- exact replay window retention duration
- whether upload preparation is a control-plane command, REST endpoint, or both
- exact URL shape for admin endpoints
- exact HTTP auth header format for non-browser clients
- whether large metadata query results are paginated over HTTP or materialized as separate downloadable objects

These choices should not alter the logical contracts above.
