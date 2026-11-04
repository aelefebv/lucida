# Local-File Datasets Are Personal-Only in Saved Views

Status: Accepted.

## Context

A local file in lucida is a path on the server's filesystem, picked through the server's file browser and opened with `OpenRemoteDataset { url }`. `is_local_dataset_url`, applied after `normalize_dataset_url` in `lucida-content` ([0042](0042-canonical-dataset-url-form.md)), classifies POSIX (`/data/foo.zarr`), drive-letter (`c:/...`), and UNC (`//server/share/...`) paths. A dataset's id is a blake3 hash of its URL string, not of its bytes.

On the sender's own server, the same path gives the same file and the same id, so a saved view works as a personal bookmark. On another server the path may not exist, may fall outside the server's data directory, or may name a different file. A different file gets the same id and silently receives viewport state meant for another dataset.

## Decision

A saved view or bookmark that references local paths is a personal artifact. The client encodes it as usual. When the user copies the link, it shows a non-blocking warning with the number of local paths: the link works only on a server with the same files at the same paths. Nothing is converted. A recipient whose server cannot open a path gets `OpenDatasetFailed` for it, and the apply skips that dataset and continues.

`DatasetId` equality is URL equality, not content equality. A feature that needs content identity across servers, such as cross-server cache sharing, needs its own content-derived id.

## Rejected alternatives

- Refuse to encode local paths. Local workflows would lose reload-keeps-the-view entirely.
- Convert local paths to a served URL on share, with the server exposing the file over HTTP at a stable address. That is a product feature in its own right (TLS, auth, content addressing, garbage collection) and out of scope here.
