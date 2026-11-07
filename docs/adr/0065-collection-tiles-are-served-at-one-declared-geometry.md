# Collection tiles are served at one declared geometry

Status: Accepted.

## Context

The client plans and renders a collection from one multiscale: it takes level
shapes, chunk shapes, and the layout cell from the first image. OME-Zarr does
not require a collection's tiles to share level shapes or chunk shapes, and
writers that store each acquired region at its own size, or clip a coarse
level's chunk to that level, produce tiles that differ. Import used to read one
representative tile and apply its geometry to every tile, so a smaller tile's
coarse chunks arrived short and a larger tile was cropped and its coarse chunk
read at the wrong row stride.

## Decision

Import reads the first tile of every group and declares, per level, the largest
shape and the largest chunk on each axis, over the levels every group has. Every
tile's image carries that declared geometry.

Each tile's binding describes its own stored level. Where the stored chunk shape
is the declared one, keys address stored chunks directly, and a key past a
smaller tile's grid reads as fill. Where it differs, the binding carries a
regrid, and the server assembles each declared chunk from the stored chunks it
overlaps, with fill past the tile's extent. Only the chunk read knows; the
client and coarse generation see ordinary chunks.

A chunk that decodes to some other size than its stored chunk shape holds is a
decode error, never bytes to serve.

The other tiles of a group are taken to be stored like its first tile, so
metadata reads stay proportional to groups. A group whose first tile has other
axes or another data type is read as if stored like the representative, and one
aggregated warning names it.

## Rejected alternatives

- Per-tile geometry in the manifest. Truthful, but the client reads collection
  geometry from the first image in many places, and every one would need to
  change.
- Read every tile. Correct within a group too, but a wide collection would pay
  one read per tile per level, which open is built to avoid.
- Discover each tile's geometry lazily when its first chunk is read. Free at
  open, but it cannot widen the declared geometry, so larger tiles stay
  cropped.
