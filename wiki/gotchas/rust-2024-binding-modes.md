---
type: Gotcha
title: "Rust 2024 Edition Binding Modes"
description: "lucida-core (and the workspace at large) is on Rust edition 2024 (Cargo.toml workspace says resolver = \"3\" and crates declare edition = \"2024\")."
tags: [lucida, gotcha]
source_path: wiki/gotchas/rust-2024-binding-modes.md
created: 2026-04-18
modified: 2026-04-18
---

# Rust 2024 Edition Binding Modes

## The footgun

[lucida-core](../systems/crates/lucida-core.md) (and the workspace at large) is on Rust **edition 2024** (`Cargo.toml` workspace says `resolver = "3"` and crates declare `edition = "2024"`). Binding modes — particularly in patterns inside closures — differ from edition 2021. Code that compiled cleanly under 2021 with `&` references in closures may now require explicit dereferencing or different binding patterns, and vice versa.

The compiler error messages are usually clear, but the *fix* often involves removing what looks like necessary `&` or adding what looks like an unnecessary `*`. Reach for the edition-2024 migration guide first, not your usual binding-mode mental model.

## Where it bites

- Closures over reference iterators in collection methods (`filter`, `find`, `map`).
- Pattern bindings inside `match` arms.
- `if let` patterns over reference values.

## What to do

1. **Trust the compiler.** Edition-2024 binding inference is more aggressive about defaulting to references. Listen to the suggested fix.
2. **Read the migration guide** if you find yourself fighting many of these in one change — there's usually a uniform fix pattern.
3. **Don't downgrade the edition** to "make the error go away" — the rest of the workspace assumes 2024, and partial-edition crates create maintenance friction.

## Why we're on 2024

For the binding-mode improvements (cleaner pattern matches), `let-else` with better error messages, and the `gen` blocks coming up the chain. The footgun is real but the wins are real too.

## Related

- `Cargo.toml` files in each crate (`edition = "2024"`)
- Rust edition 2024 release notes
