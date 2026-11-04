# Discriminated Active-Set and Entity Types

Status: Accepted.

## Context

Planning types once carried their invariants in comments: group-as-proxy entries have an empty `imageId`, tiles always have a `parentId`. Invisible entities were encoded as `mode: "tiles-with-detail"`, so a check for `entry.mode === "tiles-with-detail"` matched invisible entities too.

## Decision

Both planning unions are discriminated by `kind` (`lucida-web/src/pipeline/planning/types.ts`), and consumers narrow on `kind` before reading variant fields.

`ActiveSetEntry` is `GroupAsProxyEntry | TileEntry | InvisibleEntry`. `mode` lives only on `TileEntry`, narrowed to `"tiles-with-proxy-fallback" | "tiles-with-detail"`. Invisible entities have their own variant and contribute no chunk requests.

`EntitySnapshot` is `ImageSnapshot | GroupSnapshot | TileSnapshot`. Only `TileSnapshot` has `parentId`, and it is non-null. A tile without a parent throws when the snapshot is assembled.

The rule behind both: an invariant a variant can state goes in its type, where the compiler checks it, not in a comment.

## Rejected alternatives

- Four active-set variants, one per tile mode. The two tile modes share their shape (real levels, a real `imageId`, a possible proxy), so splitting them buys little.
- Stripping `levels` from `GroupSnapshot`, since group-as-proxy never iterates group chunks. Proving groups never need their own geometry means auditing every reader of `entity.levels`, so `levels` stays on all three variants.

## Consequences

The planner now builds only `TileEntry` and `InvisibleEntry`. `GroupAsProxyEntry` and the `tiles-with-proxy-fallback` mode stay for the proxy-asset path until [0043](0043-superseded-server-surfaces-sunset.md) removes it.
