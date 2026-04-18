---
created: 2026-04-18
modified: 2026-04-18
---

# Proxy Generator Priority Is Not Honored Yet

## The footgun

[[lucida-server]] `proxy::ProxyGenerator::request(spec, priority)` accepts a `priority: u8` parameter, **but the MVP doesn't actually order requests by priority**. The tokio `Semaphore` provides bounded concurrency in **FIFO** order. The parameter exists for API stability — when the priority scheduler lands (PRD #397 S5 follow-up), call sites won't have to change.

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

`lucida-server/src/proxy/mod.rs` has the explicit comment:

> The MVP exposes a `priority: u8` parameter on `ProxyGenerator::request` for API stability but does not yet order requests by priority. The tokio `Semaphore` provides bounded concurrency in FIFO order. A real priority scheduler is a follow-up — see PRD #397 S5.

## Related

- [[lucida-server]]
- [[lucida-proxy]]
- [[flows/proxy-generation]]
