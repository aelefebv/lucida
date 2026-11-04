# IAP mode reads the identity the perimeter established

Status: Accepted.

## Context

Google Cloud's Identity-Aware Proxy (IAP) authenticates a caller before the
request reaches the server and attaches a signed assertion to every request it
forwards. Google mode runs its own sign-in and mints a session, which behind IAP
would be a second sign-in for an identity already established. lucida's
authorization code only ever needed a trustworthy email address.

## Decision

`AuthMode::Iap` adds a principal extractor (`lucida-server/src/auth/iap.rs`)
that verifies the assertion and reads its `email` claim. There is no sign-in, no
session, and no change to authorization.

An assertion is accepted only when signature, issuer, expiry, and audience all
pass, and none can be turned off. The signature is checked against IAP's own
ES256 key set, not the Google OAuth key set, with the algorithm pinned rather
than taken from the token's header. A missing `iss`, `aud`, or `exp` fails the
check rather than skipping it.

The audience is an exact string match against `LUCIDA_IAP_AUDIENCE`, which is
required and has no default. IAP signs every assertion for every deployment with
the same keys, so signature and issuer prove only that some IAP minted the
token. The audience is the one field that says it was this deployment's. IAP
strips client-supplied `x-goog-*` headers at the load balancer, but any workload
inside the cluster can reach the backend Service directly with any header it
likes, and on that path the audience check is what holds.

Credentials are tried in the order Google mode uses, through the same
`DualCredentialExtractor`: a lucida bearer token if the request carries one,
then the IAP assertion, then rejection. An `Authorization` header never falls
back. The bearer branch keeps the CLI working through IAP.

Admin rights still come from `LUCIDA_ADMIN_EMAILS`. Sign-out points at IAP's own
cookie-clearing URL, since lucida issued nothing to clear. The key set is
fetched before the first request is served, so a server that cannot reach it
fails at boot instead of failing every request.

## Rejected alternatives

- Trust `x-goog-authenticated-user-email` and skip the JWT. It is the same
  header class, stripped by the same perimeter, with no signature, so it has no
  answer to the in-cluster path.
- Reuse the Google provider's key set cache. Different key set, algorithm,
  issuer, and audience.
- An optional audience, or a flag to skip it. A deployment learns it never had
  the check only after the fact, and a skip flag set during an incident tends to
  stay set.
- Prefix-match the audience. A backend service whose id begins with ours is a
  different service.
- Derive the audience from a project number and backend service id. Its exact
  form is Google's to change, and a value the server assembled is one nobody
  checked.
- A canned shared identity when no credential is present. Disabled mode on a
  loopback bind already covers that
  ([ADR 0018](0018-auth-mode-auto-detect-by-bind-address.md)).
- Apply `LUCIDA_ALLOWED_HOSTED_DOMAINS`. IAP's access policy already decides who
  gets through, and two places to say it is one too many.

## Consequences

IAP mode has a network dependency at startup that the other modes lack. A
rejected assertion is a 401 whose reason is logged at `warn` the first time in a
process and at `debug` after, so a wrong audience is visible without flooding
the log. A browser that fails the check gets the plain 401 rather than the
sign-in landing page, because IAP mode registers no sign-in route to bounce to.
