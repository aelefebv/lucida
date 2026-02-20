# Step 11 Sub-Spec: Remote Web Gateway (Phase 2)

## Objective
Deliver remote browser control for Lucida sessions over a token-protected WebSocket gateway with streamed 2D render tiles, while preserving daemon/runtime authority and protocol v1 contract stability.

## What Lives in This Sub-Spec
1. Gateway transport envelope for attach, RPC relay, event push, and render tile streaming.
2. Browser-to-daemon session attach semantics and single-controller lock policy.
3. Token auth and bind/TLS deployment policy for trusted-network use.
4. Render pipeline rules for true 2D dataset pixel streaming with tile diffing.
5. Step 11 CI/perf gates and reference browser client coverage.

## Scope
In scope:
1. Python gateway runtime (`aiohttp`) as sidecar to local daemon.
2. Remote attach by explicit `session_id` + `view_id`.
3. One active controller per session.
4. WebSocket relay for protocol RPC + event stream.
5. Tile-based render stream (`256px` tiles) with JPEG default and PNG fallback.
6. 2D core workflow support (pan/zoom/slice/channel/image layers).
7. Backend compatibility matching Step 03 policy:
   - local/http/synthetic guaranteed
   - s3/gcs supported when optional dependencies are installed
8. Dedicated Step 11 integration/perf workflow and tests.
9. Minimal in-repo reference SPA for attach/control/render smoke behavior.

Out of scope:
1. OpenRPC/schema method or field changes.
2. Multi-controller collaboration roles, viewer roles, or multi-tenant policy.
3. Browser feature parity for 3D and points workflows.
4. Built-in TLS certificate management in gateway process.
5. SDK transport surface expansion (SDK remains unchanged in Step 11).

## Protocol and Interface Policy
1. Step 11 keeps protocol artifacts unchanged:
   - no changes to `protocol/openrpc/lucida.v1.openrpc.json`
   - no request/response/event schema delta
2. Gateway introduces WS envelope frames above existing daemon methods.
3. Daemon remains command/state/event authority.
4. Gateway relay preserves Lucida typed error envelopes unchanged in `rpc.error` frames.

## Public Gateway Contracts
1. Health endpoint:
   - `GET /healthz`
2. WebSocket endpoint:
   - `GET /v1/ws`
   - token required (Bearer header; query token fallback for browser local testing)
3. Attach frame:
   - `{"type":"attach","session_id":"<uuidv7>","view_id":"<uuidv7>","client_name":"...","client_version":"..."}`
4. RPC request frame:
   - `{"type":"rpc.request","id":"<uuid>","method":"<lucida.method>","params":{...}}`
5. RPC response frame:
   - `{"type":"rpc.response","id":"<uuid>","result":{...}}`
6. RPC error frame:
   - `{"type":"rpc.error","id":"<uuid|null>","error":<LucidaErrorEnvelope>}`
7. Event frame:
   - `{"type":"event","event":<LucidaEventEnvelope>}`
8. Render tile frame:
   - `{"type":"render.tile","frame_id":"<uuid>","view_id":"<uuid>","tile_index":n,"tile_total":m,"x":px,"y":px,"width":px,"height":px,"format":"jpeg|png","quality":75,"plan_seq":k,"payload_b64":"..."}`
9. Render status frame:
   - `{"type":"render.status","state":"dropped|resync","dropped_frames":n}`

## Runtime Architecture
1. Gateway process model:
   - dedicated `lucida_gateway` service started by CLI
   - reuses or auto-launches daemon via existing local registry policy
2. Control bridge model:
   - one daemon connection per browser socket
   - attach flow runs `system.hello`, validates session/view, then subscribes events
3. Session controller lock model:
   - one active browser controller per session
   - second attach attempts are rejected with typed conflict
4. Event model:
   - wildcard daemon subscription (`*`) is gateway-managed
   - event ordering is preserved per session (`session_seq` monotonic)
5. Render model:
   - poll session frame-plan state
   - render visible bound image layers only
   - tile and diff against prior frame
   - enqueue with bounded queue (`default=2`)
   - drop stale render batches before command relay traffic

## Render Pipeline Rules
1. Data source is true dataset pixels (not placeholder preview).
2. Selected level and slice axes follow existing frame-plan semantics.
3. Layer compositing order follows `view.bound_layer_ids`.
4. Layer alpha follows `layer.opacity`.
5. Channel selection uses layer channel when present, otherwise first view channel.
6. Tile stream defaults:
   - tile size `256px`
   - JPEG default quality `75`
   - fallback PNG when JPEG encoding fails or lossless requested
7. Frame push throttle:
   - max `15` render updates/second/connection
8. Tile diffing:
   - changed tiles only, keyed by tile hash

## Security and Deployment Policy
1. Token auth is required for gateway WS access.
2. Default bind is localhost (`127.0.0.1`).
3. Non-local bind requires explicit TLS-termination mode.
4. Step 11 secure deployment uses reverse-proxy TLS termination.
5. Daemon `remote_bind` remains unsupported directly; gateway is the remote path.

## Failure and Degradation Policy
1. Missing/invalid token -> HTTP `401` or WS upgrade rejection.
2. Attach with unknown session/view -> typed not-found error.
3. Attach with session lock conflict -> typed conflict error.
4. RPC with mismatched `session_id` vs attached session -> typed conflict error.
5. Slow-client policy:
   - bounded render queue
   - stale render batches dropped first
   - repeated overflow closes connection with retry-safe backpressure semantics
6. Event backpressure from daemon subscription is surfaced as typed errors and connection close when necessary.

## Deliverables
1. Gateway package:
   - `python/lucida_gateway/config.py`
   - `python/lucida_gateway/auth.py`
   - `python/lucida_gateway/bridge.py`
   - `python/lucida_gateway/render.py`
   - `python/lucida_gateway/tiles.py`
   - `python/lucida_gateway/server.py`
   - `python/lucida_gateway/cli.py`
   - `python/lucida_gateway/__init__.py`
   - `python/lucida_gateway/__main__.py`
2. Daemon integration updates:
   - `python/lucida_daemon/config.py`
   - `python/lucida_daemon/daemon.py`
3. Docs and reference client:
   - `docs/gateway/README.md`
   - `docs/web-gateway/reference-client/index.html`
   - `docs/web-gateway/reference-client/app.js`
   - `docs/web-gateway/reference-client/styles.css`
4. Workflow and tests:
   - `.github/workflows/step11-web-gateway.yml`
   - `tests/gateway/test_step11_gateway.py`
   - `tests/gateway/test_step11_gateway_components.py`
   - `tests/perf/test_step11_gateway_perf.py`

## Test and Acceptance Gates
1. Auth:
   - valid token accepts WS
   - missing/invalid token rejects with `401`
2. Attach/session control:
   - attach by explicit session/view succeeds
   - unknown session/view fails typed
   - single-controller lock is enforced
3. RPC relay:
   - non-mutating and mutating methods round-trip through gateway
   - typed error envelopes are preserved in `rpc.error`
4. Event stream:
   - event frames preserve session ordering and `session_seq` continuity
5. Render stream:
   - `render.tile` frames carry valid payload bytes and metadata
   - changed-tile diff behavior is active
6. Backend coverage:
   - synthetic and local dataset rendering pass in tests
   - optional backend behavior remains dependency-gated
7. Degradation:
   - bounded render queue behavior does not crash gateway or daemon
8. Perf smoke:
   - trusted LAN target of >=10 FPS effective updates
   - input-to-visible update p95 under 150ms
9. Context integrity:
   - context checks/tests remain green after Step 11 artifact updates

## Dependencies
1. Step 03 backend and metadata pipeline for dataset IO.
2. Step 04 deterministic 2D frame-plan semantics.
3. Step 07 daemon session/event orchestration.
4. Step 08 SDK daemon registry patterns (reuse/auto-launch behavior).
5. Step 10 CI/release gate conventions.

## Exit Criteria
Step 11 is complete when the gateway can securely attach a browser to a daemon session, relay RPC + events reliably, stream true 2D image tiles with bounded degradation behavior, satisfy Step 11 CI/perf gates, and remain protocol-artifact neutral.
