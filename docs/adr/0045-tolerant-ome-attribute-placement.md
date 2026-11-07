# Tolerant OME attribute placement

Status: Accepted.

## Context

OME-Zarr 0.5 moved its metadata under an `ome` namespace at the same time as the move to Zarr
v3, and writers adopted the two changes at different speeds. Real stores are valid Zarr v3 yet
carry `attributes.multiscales` with `"version": "0.4"` at the top level. That shape conforms
to neither revision, but it is unambiguous to read: the same keys and sub-schemas, one level of
nesting apart.

## Decision

Lucida reads every OME block (`multiscales`, `omero`, `labels`, `image-label`, `plate`,
`well`) from either `attributes.ome.<block>` or `attributes.<block>` in a Zarr v3 group's
`zarr.json`. The choice is made once per group, never per block. When `attributes.ome` exists
and is an object, it is the only source. Only when it is absent, or is not an object, does the
reader use the top level. One helper in `lucida-store::parse` resolves placement, and no call
site picks for itself.

Lucida stays Zarr v3 only; this does not add v2 (`.zattrs`) support. The top-level placement is
read, never written. When a block is missing from both places, the error names both spellings
and lists the keys the group does carry, or says the path is an array and points at its parent.

## Rejected alternatives

- Read only the namespaced placement. Turns a readable store into an unopenable one, and the
  user's fix is to rewrite metadata the format did not require. Lucida is a viewer, not a
  validator.
- Fall back per block instead of per namespace. A half-migrated group could pick up a stale
  top-level `multiscales` left by a converter, which is wrong but plausible metadata with no
  signal. A viewer must not silently show wrong data ([intention.md](../../intention.md)).
- Branch on the declared `version` string. The version is exactly what these stores get wrong,
  so structure, which is observable, decides instead.
- Accept the store and reject it later if the placement implies an unsupported feature. No such
  feature exists.

## Consequences

A group with non-OME top-level keys named `plate` or `multiscales` would be read as OME
metadata. Accepted: those keys are OME-defined, and namespace-only reading has the larger,
demonstrated cost.
