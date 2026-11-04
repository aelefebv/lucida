# Single-Image Container with `ServeDir` is the Canonical Deploy Unit

Status: Accepted.

## Context

The SPA and the API must share an origin in production. The session cookie is `HttpOnly` and `SameSite=Lax` ([0016](0016-backend-mediated-oauth-with-session-cookies.md)), so cross-origin writes would not carry it. The web bundle and the server are already version-locked, because the SPA depends on the WASM build of `lucida-core` from the same tree.

## Decision

`lucida-server` serves the SPA bundle itself, through `tower-http`'s `ServeDir` (`lucida-server/src/static_serve.rs`), merged last as the catch-all route. Unknown paths fall back to `index.html`. A missing or empty bundle directory gets a page that says to build the SPA, not a blank page. `LUCIDA_WEB_DIST` sets the directory and defaults to `./lucida-web/dist`.

The deploy unit is one container image holding the server binary and the SPA at `/usr/share/lucida/web`. The same image runs in Kubernetes and in a local `docker run`. Without Docker, a release build next to a built `lucida-web/dist` serves the same way. Active development is unchanged: the Vite dev server proxies `/auth`, `/api`, `/admin`, and `/ws` to the backend.

## Rejected alternatives

- An nginx sidecar that serves the SPA and proxies the API. Two images, two health stories, and a chance of version skew, for no gain at this scale.
- Two images routed by path at the Ingress. The same problems, with routing knowledge pushed into the Ingress.
- Leaving SPA serving to the Ingress. It hands the same-origin problem to every adopter.
- Embedding the SPA in the binary (`include_dir!`). A bigger binary, no rebuilding the SPA against a running server, and no missing-bundle page.
- A compile-time dist path. A build flag where one variable with a default covers both cases.

## Consequences

The Dockerfile builds in order: Rust and WASM, then the SPA against that WASM, then the runtime image. The SPA build must pass cleanly for an image to exist.
