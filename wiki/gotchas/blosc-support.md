---
type: Gotcha
title: "Blosc support is a deliberately narrow subset"
description: "CZI-derived OME-Zarrs (and many older Bioformats exports) compress chunks with Blosc, a meta-codec that wraps an inner compressor (zstd/lz4/zlib/...) with optional byte/bit shuffling."
tags: [lucida, gotcha]
source_path: wiki/gotchas/blosc-support.md
created: 2026-04-23
modified: 2026-04-23
---

# Blosc support is a deliberately narrow subset

CZI-derived OME-Zarrs (and many older Bioformats exports) compress chunks with **Blosc**, a meta-codec that wraps an inner compressor (`zstd`/`lz4`/`zlib`/...) with optional byte/bit shuffling. Lucida ships a small in-tree Blosc1 decoder that intentionally supports **only the subset that appears in real-world OME-Zarr datasets we open**, and rejects the rest at import time with a clear error.

The motivation: silently falling back to "no compression" when an unknown codec arrives once produced the most cryptic bug we have ever shipped — the worker tried `new Uint16Array(buffer)` on a still-compressed payload and either threw on odd-byte length or painted noise onto the atlas. Hard rejection at import surfaces the limitation at dataset-open time instead.

## What is supported

| Dimension | Supported | Notes |
|---|---|---|
| Frame format | Blosc1 | Blosc2 frames are rejected at import. |
| Inner cname | `zstd` only | Reuses the existing `zstd` crate. |
| Shuffle | `noshuffle`, `shuffle` (byte), `bitshuffle` | All three implemented in-tree. |
| Typesize | 1, 2, 4 | 8 and others rejected at import. |

Anything outside the table — `blosclz`, `lz4`, `lz4hc`, `zlib`, `snappy` cnames; typesize 8; Blosc2 — is rejected at import with a message naming the offending property and the level it was detected on.

## Where it lives

- Decoder: `lucida-server::decode::blosc` (~200 LOC, no FFI). 16-byte header parse, cross-check against the `BloscConfig` recorded at import, dispatch to `zstd::decode_all` then `unshuffle` (byte/bit). MEMCPYED frames short-circuit decompression.
- Codec types: `lucida-store::codec` defines `StorageCompression`, `BloscConfig`, `BloscCompressor`, `BloscShuffle`. Used by both the import-time validator and the decoder. See [lucida-store](../systems/crates/lucida-store.md).
- Validation: runs at import per level; per-level errors so a partially broken pyramid surfaces the bad level rather than failing opaquely on first chunk fetch.

## Test vectors

The unit tests use **hardcoded `&[u8]` literals** rather than calling out to a Blosc CLI at test time. The vectors were generated once via Python and pasted into the test file. To regenerate (e.g. when extending the supported subset):

```sh
python3 -c "import blosc; print(blosc.compress(bytes([i%8 for i in range(256)]), typesize=2, cname='zstd', shuffle=blosc.BITSHUFFLE).hex())"
```

The test file documents this one-liner inline so the regen recipe stays next to the fixtures. Vary `typesize`, `cname`, and `shuffle` (`blosc.NOSHUFFLE`, `blosc.SHUFFLE`, `blosc.BITSHUFFLE`) to cover the matrix.

## Why this subset and not all of Blosc

- `zstd` is the only inner cname seen in CZI exports we have hit, and it's the modern default for Blosc-emitting tools. Adding `lz4`/`zlib` is straightforward (more crate deps), but until a dataset forces it, we keep the surface minimal.
- Typesize 8 would cover float64 / int64 chunks, which OME-Zarr image data effectively never uses. Microscopy is uint8/uint16, occasionally uint32.
- Blosc2 changes the frame format and adds chunked sub-frames. Supporting it is a separate decoder, not a tweak; deferring until needed.

## Related

- [Non-canonical axes are pinned to index 0](non-canonical-axes.md) — the other half of the CZI-rendering story; codec rejection and prefix-slice eligibility share the import-time validation pass.
- [lucida-store](../systems/crates/lucida-store.md) — `lucida-store::codec` and `lucida-store::layout` modules, and the binding-seed shape that carries per-level codec + layout to the server.
