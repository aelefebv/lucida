# ADR-0004: Channel-Blocked Packaging

- Status: Accepted
- Date: 2026-03-01

## Context

Microscopy datasets may contain many channels. Fetching one payload per channel causes high request overhead; fetching all channels in one payload can waste bandwidth and decode time.

Lucida needs a middle path that preserves per-channel UI semantics while keeping request and decode costs manageable.

## Decision

Lucida packages payloads in channel blocks. Clients request the minimal set of channel blocks needed for the current visible channels and compose channels client-side.

Block structure and codec details are implementation choices, but block addressing and selection semantics are stable protocol behavior.

## Consequences

- Lower request count and better transport efficiency than per-channel payloads.
- Better bandwidth efficiency than always fetching all channels.
- Client scheduler and cache logic must map channel selections to block coverage.
- Block-size tuning remains an implementation/performance concern.

## Alternatives Considered

- One payload per channel: rejected due to request overhead.
- Always all-channel payloads: rejected due to overfetch.
