---
type: Decision
title: "IAP mode reads the identity the perimeter established"
description: "LUCIDA_AUTH=iap adds a PrincipalExtractor that verifies the assertion Identity-Aware Proxy attaches to each request. Four checks, all required, and the audience is the one that says the assertion was minted for this deployment."
tags: [lucida, decision]
source_path: wiki/decisions/0060-iap-mode-reads-the-identity-the-perimeter-established.md
created: 2026-09-03
modified: 2026-09-03
---

# IAP mode reads the identity the perimeter established

Status: Accepted.

## Decision

`AuthMode` gains an `Iap` variant, and `lucida-server::auth::iap` gains the
`PrincipalExtractor` behind it. Where Google mode runs a sign-in and mints a
session, IAP mode runs neither: Google Cloud's Identity-Aware Proxy has already
authenticated the caller and attached a signed assertion, and lucida's job is to
verify that assertion and read its `email` claim.

No authorization code changes. That code only ever needed a trustworthy email
address, which is exactly what a verified assertion carries.

## The four checks

An assertion is accepted only when all four pass, and none of them can be turned
off:

1. **Signature**, against IAP's own ES256 key set.
2. **Issuer**, against the configured value.
3. **Expiry**, from the `exp` claim.
4. **Audience**, an exact string match against `LUCIDA_IAP_AUDIENCE`.

**The key set is not the one the Google OAuth provider uses.** IAP publishes its
keys somewhere else and signs with ES256 rather than RS256. Validating an IAP
assertion against the general OAuth JWKS finds no matching key and rejects
everything, which at least fails loudly. The nearby mistake is the dangerous one:
reaching for the OAuth JWKS because both are "Google keys" gives a check that
passes without meaning. Both URLs are named as constants in `auth::config`, next
to each other, with the distinction spelled out.

The algorithm is pinned to ES256 rather than taken from the assertion's own
header. A token is a thing an attacker writes, so letting it name the algorithm
lets it name a symmetric one and present the published verification key as a
shared secret.

**A missing claim fails the check rather than skipping it.** `jsonwebtoken`
constrains `iss` and `aud` only when they are present, and requires `exp` alone
by default, so an assertion that simply leaves `aud` out would have sailed past
the check this whole section is about. The required set is named explicitly. The
same line went into the Google provider, which had the same gap.

## Why the audience check earns its place

IAP signs every assertion it issues, for every deployment on the platform, with
the same keys. Signature and issuer together therefore prove only that *some*
IAP minted this token — the one guarding a stranger's service counts. The
audience claim is the only field that distinguishes this deployment's IAP from
theirs, so without it the first three checks amount to "was this minted by
Google Cloud", which is not a question worth asking.

The obvious rebuttal is that IAP strips client-supplied `x-goog-*` headers, so
nobody outside can present an assertion at all. That is true of traffic through
the load balancer, and it is why the audience check is defense in depth on the
normal path. But the strip happens at the perimeter, and the perimeter is not the
only way in. Any workload in the cluster can address the backend Service
directly and set whatever headers it likes. On that path the signature
is the only thing standing up, and the signature alone accepts any IAP's token.
A deployment where that path is closed today has a security property resting on
a network topology, which is a thing that gets edited.

**Exact match, and nothing else.** No prefix matching: a backend service whose id
begins with ours is a different backend service. No flag to skip the check,
because a flag to skip it is a flag that will be set during an incident and never
unset. And no value assembled from parts. Lucida never parses the audience and
never rebuilds it from a project number and a service id, because a value this
server derived is a value nobody checked. How a deployment obtains the string is
an operations concern.

`LUCIDA_IAP_AUDIENCE` is therefore required, with no default. When it is unset in
IAP mode the server stops at boot and names the variable, rather than starting
with the check quietly absent.

## Credential order

A lucida bearer token when the request carries one, then the IAP assertion, then
rejection. This is `DualCredentialExtractor`, the same composition Google mode
uses with its session cookie in the second position. The same code, not a
parallel copy, so the two modes cannot come to different conclusions about which
credential wins. An `Authorization` header is answered on its own merits and
never falls back: a caller who names a token and gets in as somebody else has
been lied to.

The bearer branch is what keeps the command-line client working through IAP
without a server-side special case.

**The provider never produces a canned identity.** A request with no credential
is unauthenticated, full stop. A deployment that wants every caller to share one
identity runs disabled mode on a loopback bind, which
[ADR 0018](0018-auth-mode-auto-detect-by-bind-address.md) already governs and
which this mode does not duplicate.

**Admin rights keep coming from `LUCIDA_ADMIN_EMAILS`.** IAP decides who reaches
the server; it has no opinion about who administers lucida. An unset list means
no administrators and every admin endpoint answers 403.

## Sign-out points at the perimeter

Nothing here issued the caller's identity, so there is nothing here to clear. The
mode's sign-out URL is IAP's own, and Google documents it as the query parameter
`?gcp-iap-mode=CLEAR_LOGIN_COOKIE` rather than as a path. Clearing the IAP cookie
does not sign the user out of the identity provider behind it, so a browser still
signed in there can be waved straight back through. That is IAP's behaviour, not
something lucida can improve on from this side, and it is the honest answer to
give the control.

## Consequences

- **The key set is read before the first request is served.** `build_extractor`
  became fallible for this: a server that cannot reach the key set cannot
  authenticate anybody, and saying so once at boot beats 500ing every request
  until somebody reads the logs. It also means IAP mode has a network dependency
  at startup that the other two modes do not.
- **A rejected assertion is a 401, never a 500, and the first one is loud.** A
  mismatched `LUCIDA_IAP_AUDIENCE` and an outage both make every request fail,
  and an operator needs to tell them apart. The status separates them, and the
  reason — which names the variable — is logged. Per request it is a `debug`
  event, because a caller hammering the door should not bury the boot log; the
  first rejection of the process is a `warn`, because one line at the default
  level is what a misconfiguration deserves and a flood is not.
- **A browser that fails the check gets the plain 401, not the landing page.**
  The landing page's move is to bounce to `/auth/start`, which IAP mode never
  registers, and the bounce would land on the SPA catch-all and come straight
  back. `PrincipalExtractor::offers_sign_in` is what the middleware asks; only a
  provider running its own sign-in answers yes. ADR 0018 records the last time
  that loop shipped.
- **Key rotation costs one round trip.** The cache follows the OAuth JWKS cache's
  shape — refreshed on an interval and immediately on a `kid` the cache does not
  hold, which is what a rotation looks like from here. Verification otherwise
  pays no network round trip.
- **`hd` is read by nobody.** IAP's IAM policy decides who gets through, so
  `LUCIDA_ALLOWED_HOSTED_DOMAINS` — which Google mode applies at callback time —
  has no callback to apply at here. Two places to express "who may sign in"
  would be one too many.
- **The dev identity switcher stays off.** It needs disabled mode and a loopback
  bind, and IAP mode is neither.

## Alternatives considered

- **Trust `x-goog-authenticated-user-email` and skip the JWT.** Rejected. It is
  the same header class, stripped by the same perimeter, with no signature at
  all — so every argument for the audience check applies to it, and it has
  nothing to answer them with.
- **Reuse the Google provider's JWKS cache instance.** Rejected: different key
  set, different algorithm, different issuer, different audience. Sharing the
  cache would mean one of the two providers reading keys chosen for the other.
- **Make the audience optional, defaulting to unchecked.** Rejected. An optional
  check is one a deployment discovers it never had after the fact.
- **Derive the audience from the project number and backend service id.**
  Rejected. It puts lucida in the business of guessing a value whose exact form
  is Google's to change, and a guess that happens to be right is
  indistinguishable from one that is wrong until somebody presents a token.

## Related

- [Server-Stored Bookmarks and the Auth Seam](0015-server-stored-bookmarks-and-auth-seam.md) — the `PrincipalExtractor` seam this plugs into
- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — names the seam as the extension point for new providers, and the `LUCIDA_*` contract this extends
- [Auth Mode Auto-Detect by Bind Address](0018-auth-mode-auto-detect-by-bind-address.md) — mode selection, and the disabled-mode path this deliberately does not duplicate
- [Post-Logout Marker Cookie and prompt=select_account](0019-post-logout-marker-cookie-and-prompt-select-account.md) — the sign-out machinery that has nothing to do here
