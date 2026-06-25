---
type: Gotcha
title: "Axum's Default Query Extractor Drops Repeated Keys"
description: "/api/bookmarks?dataset=urlA&dataset=urlB&dataset=urlC looks like a multi-value query — and the bookmark list endpoint defines it that way (any-overlap filter)."
tags: [lucida, gotcha]
source_path: wiki/gotchas/axum-query-multivalue.md
created: 2026-05-08
modified: 2026-05-08
---

# Axum's Default Query Extractor Drops Repeated Keys

## The footgun

`/api/bookmarks?dataset=urlA&dataset=urlB&dataset=urlC` looks like a multi-value query — and the bookmark list endpoint defines it that way (any-overlap filter). But Axum's default `Query<T>` extractor uses `serde_urlencoded`, which silently keeps **only the last value** of a repeating key. The handler sees `dataset = urlC` and quietly returns the wrong result.

No 400, no log line, no panic. Just wrong data.

## Why it works this way

`serde_urlencoded` is a faithful implementation of `application/x-www-form-urlencoded`, which doesn't really have a multi-value concept — repeating keys are technically allowed but the canonical interpretation is "last wins." The form-encoded model is HTML-form-centric, where repeated keys are unusual. Multi-value query strings are a HTTP convention layered on top.

For multi-value queries, you need a parser that returns `Vec<String>` instead of `String` for repeated keys. The standard `serde_urlencoded` does not.

## The workaround

Two options:

1. **Pull in `axum-extra::extract::Query`** — a drop-in replacement that handles multi-value via `serde_qs`. Adds a dependency.
2. **Hand-roll against `RawQuery`** — Axum gives you the raw query string; split on `&`, decode each `key=value` pair, collect into a `HashMap<String, Vec<String>>` (or directly to `Vec<String>` for the key you care about). No new dep.

The bookmarks slice picked option 2 — see `parse_dataset_params` in `lucida-server/src/bookmarks/handlers.rs`. ~30 lines, no dep, scoped to one endpoint.

If multi-value queries proliferate, switching to `axum-extra` becomes worthwhile.

## How to detect it

The fastest signal: an integration test that passes `?key=A&key=B` and asserts both values reach the handler. Without that test, the bug is dormant — the handler gets a single value, returns plausible-looking results, and nothing complains.

If you see a handler that takes `Query<SomeStruct>` where `SomeStruct` has a `Vec` field for a query parameter, double-check whether `serde_urlencoded` actually populates it. (Spoiler: it usually doesn't, depending on the wire format.)

## Related

- `lucida-server/src/bookmarks/handlers.rs::parse_dataset_params` — example workaround in production
- [Saved Views](../systems/subsystems/saved-views.md) — context: bookmark listing uses any-overlap on multiple `?dataset=` params
- [lucida-server](../systems/crates/lucida-server.md)
