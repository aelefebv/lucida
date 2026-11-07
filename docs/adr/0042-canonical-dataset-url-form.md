# Canonical dataset URL form

Status: Accepted.

## Context

`DatasetId` is a hash of the dataset URL string. On Windows one file has many legal spellings
(`C:\foo`, `c:/foo`, `file:///C:/foo`), and each produced a different `DatasetId`, a different
cache directory, and a different saved-view URL. Picking the wrong spelling once meant a
re-import and a lost saved-view association, with no warning.

## Decision

Every dataset URL passes through one pure string normalization,
`lucida_content::url::normalize_dataset_url`, and the result is the form used for hashing,
cache directory names, the wire, and display.

- Unix paths are unchanged.
- Drive-letter paths get a lowercase drive letter, forward slashes, and no `file://` prefix:
  `c:/foo/bar.zarr`.
- UNC paths get forward slashes: `//server/share/foo.zarr`.
- Cloud and HTTP URLs pass through, except that a leading scheme is lowercased, since schemes
  are case-insensitive (RFC 3986 §3.1). Host, bucket, and object path stay byte for byte,
  because bucket and object names are case-sensitive.

The function touches no filesystem: it does not resolve `..` or symlinks, the path need not
exist, and it is idempotent, so any boundary may call it defensively. It lives in
`lucida-content`, which both the store and the core already depend on and which already holds
pure identity computation. The server, the store's open path, the browse endpoint, and the web
client all normalize, so a Windows user who types `C:\Users\me\foo.zarr` sees
`c:/Users/me/foo.zarr` afterward.

## Rejected alternatives

- Canonicalize through the filesystem before hashing. Requires the path to exist, which breaks
  computing a `DatasetId` before open. Returns Windows verbatim paths (`\\?\C:\…`) that need
  stripping anyway. Changes Unix dedup behavior (`/foo/./bar` would merge with `/foo/bar`).
  And `..` and symlinks rarely appear in the absolute paths users open.
- No normalization, with documentation telling Windows users to pick one spelling. The
  failure is silent, so users would learn the rule by losing work.
- Put the helpers in `lucida-protocol`. That crate is meant to carry wire types, not
  computation.

## Consequences

Not solved: `..` resolution, symlink collapse, case-folding beyond the drive letter and scheme
(host names stay as typed), and cross-machine path equivalence, which stays under the
personal-only rule of [ADR 0014](0014-local-file-datasets-personal-only-in-saved-views.md).
