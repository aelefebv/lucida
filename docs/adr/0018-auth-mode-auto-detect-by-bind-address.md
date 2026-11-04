# Auth Mode Auto-Detect by Bind Address

Status: Accepted.

## Context

Auth can fail in two directions. Too strict, and a contributor cannot run lucida locally without setting up OAuth credentials. Too loose, and a production deployment ships with sign-in off. The real risk is one combination: a server with auth off that the network can reach.

## Decision

`LUCIDA_BIND` defaults to `127.0.0.1:9876`. When `LUCIDA_AUTH` is unset, the server infers the mode from the bind address:

- Loopback (`127.0.0.0/8`, `::1`) means `disabled`. Every request gets the shared `dev@local` principal, which is not an admin, because it is the identity a caller gets for presenting nothing.
- Any other address means `google`, which fails at startup without OAuth credentials.

Disabled mode on a non-loopback bind is refused at startup unless `LUCIDA_INSECURE=1` is set, and then the server logs a warning. `AuthConfig::bind_is_loopback` is the one place that decides loopback, so the default, the insecure gate, and the dev routes cannot disagree.

The dev identity switcher (`/auth/dev/login`) mints whatever identity the request names, admin included. It exists only in disabled mode on a loopback bind, decided once in `DevAuthState::new`, and answers 404 everywhere else. `LUCIDA_INSECURE=1` acknowledges that sign-in is off. It does not grant a route that hands out privilege.

Auto-detect never picks `iap` ([0060](0060-iap-mode-reads-the-identity-the-perimeter-established.md)). A bind address says whether anything but this machine can reach the server, not whether a perimeter stands in front of it, so IAP is explicit only.

## Rejected alternatives

- Default to disabled. A forgotten `LUCIDA_AUTH` ships an open server.
- Default to required. Every local run and CI job needs credentials.
- Always require `LUCIDA_AUTH`. The same safety with more friction on every dev session and CI run.
- A compile-time feature for stub auth. Hard to misconfigure, but switching needs a rebuild, and the choice belongs in configuration.
- Detect by whether credentials are set. Forgetting a variable would silently turn auth off. The bind address reflects operator intent more reliably.
- Gate the dev switcher on disabled mode alone. On a public bind with `LUCIDA_INSECURE=1` it handed an administrator to anyone who could reach the server.

## Consequences

Scripts that relied on the old `0.0.0.0:9876` default must set `LUCIDA_BIND`, and a user reaching the server from another machine sees "connection refused" until they do. A deployment that runs disabled mode behind its own perimeter keeps the app and the shared identity but has no way into admin-only endpoints. Both paths to auth-off are logged at startup, and `LUCIDA_INSECURE=1` in a production config is a flag for review.
