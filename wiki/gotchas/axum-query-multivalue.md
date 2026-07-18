---
type: Gotcha
title: "Axum's Default Query Extractor Drops Repeated Keys"
description: "Repeated query keys need an explicit multi-value parser; a retired bookmarks endpoint supplied the original example."
tags: [lucida, gotcha]
source_path: wiki/gotchas/axum-query-multivalue.md
created: 2026-05-08
modified: 2026-07-16
---

# Axum's Default Query Extractor Drops Repeated Keys

## The footgun

The now-retired `/api/bookmarks?dataset=urlA&dataset=urlB&dataset=urlC`
endpoint supplied the original example: it looked like a multi-value query, but
Axum's default `Query<T>` extractor uses `serde_urlencoded`, which silently kept
**only the last value** of a repeating key. The handler saw `dataset = urlC` and
quietly returned the wrong result.

No 400, no log line, no panic. Just wrong data.

## Why it works this way

`serde_urlencoded` is a faithful implementation of `application/x-www-form-urlencoded`, which doesn't really have a multi-value concept — repeating keys are technically allowed but the canonical interpretation is "last wins." The form-encoded model is HTML-form-centric, where repeated keys are unusual. Multi-value query strings are a HTTP convention layered on top.

For multi-value queries, you need a parser that returns `Vec<String>` instead of `String` for repeated keys. The standard `serde_urlencoded` does not.

## The workaround

Two options:

1. **Pull in `axum-extra::extract::Query`** — a drop-in replacement that handles multi-value via `serde_qs`. Adds a dependency.
2. **Hand-roll against `RawQuery`** — Axum gives you the raw query string; split on `&`, decode each `key=value` pair, collect into a `HashMap<String, Vec<String>>` (or directly to `Vec<String>` for the key you care about). No new dep.

The deleted global-bookmarks slice picked option 2 in its
`parse_dataset_params` helper. ADR-0043 removed that endpoint and helper, so no
active Lucida route currently carries this workaround; the parser lesson
remains relevant to any future repeated-key endpoint.

If multi-value queries proliferate, switching to `axum-extra` becomes worthwhile.

## How to detect it

The fastest signal: an integration test that passes `?key=A&key=B` and asserts both values reach the handler. Without that test, the bug is dormant — the handler gets a single value, returns plausible-looking results, and nothing complains.

If you see a handler that takes `Query<SomeStruct>` where `SomeStruct` has a `Vec` field for a query parameter, double-check whether `serde_urlencoded` actually populates it. (Spoiler: it usually doesn't, depending on the wire format.)

## Related

- [ADR-0043](../decisions/0043-superseded-server-surfaces-sunset.md) — retirement of the global endpoint that supplied the historical example
- [Saved Views](../systems/subsystems/saved-views.md) — current workspace-scoped replacement
- [lucida-server](../systems/crates/lucida-server.md)
