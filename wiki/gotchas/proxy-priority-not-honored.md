---
type: Gotcha
title: "Proxy Generator Priority Is Not Honored Yet"
description: "lucida-server proxy::ProxyGenerator::request(spec, priority) accepts a priority: u8 parameter, but the MVP doesn't actually order requests by priority."
tags: [lucida, gotcha]
source_path: wiki/gotchas/proxy-priority-not-honored.md
created: 2026-04-18
modified: 2026-06-25
---

# Proxy Generator Priority Is Not Honored Yet

## The footgun

[lucida-server](../systems/crates/lucida-server.md) `proxy::ProxyGenerator::request(spec, priority)` accepts a `priority: u8` parameter, **but the MVP doesn't actually order requests by priority**. The tokio `Semaphore` provides bounded concurrency in **FIFO** order. The parameter exists for API stability — when the priority scheduler lands (PRD #397 S5 follow-up), call sites won't have to change.

Symptoms of relying on priority:

- Background pre-generation (`priority=0`) and on-demand requests (`priority=1`) interleave in arrival order, not priority order.
- A burst of pre-generation requests issued first will run before later on-demand requests for visible entities.

## What this means in practice

- Background pre-gen on dataset open is best-effort. If you have a 96-well plate, all 96 wells' `(T=0, C=0)` proxy requests enter the semaphore queue. On-demand requests issued during this run wait their turn.
- For interactive use today, keep pre-gen volumes modest. The semaphore's concurrency setting (default `num_cpus / 2`) caps the worst-case backlog.

## What to do

- **Don't rely on priority ordering.** Pass it for forward-compatibility, but design assuming FIFO.
- **If interactivity matters more than coverage**, reduce pre-generation scope (e.g. only for the visible wells initially, expand on demand).
- **When the priority scheduler lands**, the parameter starts being honored — code passing thoughtful priorities will benefit; code passing the same priority everywhere won't.

## Where the comment lives

`lucida-server/src/proxy/generator.rs` has the explicit module comment:

> `priority` is accepted for API stability but **not yet used to order requests**. The semaphore awakes waiters in roughly FIFO order; a real priority scheduler is deferred. See module docs.

The `request` method's `priority` argument is bound as `_priority: u8` (currently unused). The module-level overview in `lucida-server/src/proxy/mod.rs` likewise notes the MVP "does not yet order requests by priority" and that "a real priority scheduler is a future enhancement."

## Related

- [lucida-server](../systems/crates/lucida-server.md)
- [lucida-proxy](../systems/crates/lucida-proxy.md)
- [Flow: Proxy Generation (S5)](../flows/proxy-generation.md)
