# A profile directory enriches the principal and never authenticates it

Status: Accepted.

## Context

An IAP assertion carries only an email
([ADR 0060](0060-iap-mode-reads-the-identity-the-perimeter-established.md)), so
in that mode the display name is derived from the address and there is no
picture. An operator often has a listing elsewhere that maps people to names and
pictures. Directory integrations turn into privilege bugs when the directory is
trusted to say who someone is.

## Decision

An optional profile directory (`lucida-server/src/auth/directory.rs`),
configured by `LUCIDA_DIRECTORY_*` variables and off when unset, supplies a
display name and a picture per email address. It is a component beside the auth
modes, not a mode. The auth middleware calls the mode's extractor, applies the
directory, then attaches the principal. Handlers keep reading `AuthPrincipal` as
[ADR 0015](0015-server-stored-bookmarks-and-auth-seam.md) set, and no mode
contains directory code.

The lookup key is the email the mode resolved, normalized the way every mode
normalizes it. A row may replace the display name and the picture URL, each only
when it carries one, and nothing else. It never changes the email, never sets
the admin flag (still `LUCIDA_ADMIN_EMAILS`), and never feeds an authorization
decision. A compromised directory can rename people and swap pictures, and
nothing more. A row wins over Google mode's own name and picture, since the
directory is where an operator curates how people appear.

One background task fetches the whole listing and holds it in memory. No request
fetches, waits on, or triggers a fetch. A failed or empty refresh keeps the last
good snapshot.

Malformed configuration stops the boot and names the variable. An unreachable
listing is logged and survived, and the server shows the names the mode derives.
The line is whether the operator could have known before deploying: a URL is
right or wrong when typed, and a host is up or down at runtime. A field-name
variable that is set but blank is refused rather than defaulted, because it
means a template rendered nothing into it.

## Rejected alternatives

- A fourth auth mode that reads the directory. A mode answers "who is this", and
  the directory must never be asked that.
- Enrich inside each extractor. Three copies, three places to forget it, and
  every future mode inherits the obligation.
- A decorating extractor around the mode's. It reaches the same seam but makes
  the directory look like an extractor to anything holding the handle. Two named
  steps, resolve then enrich, show where authentication ends.
- Let a request header name the record. A caller would set it to someone else's
  address.
- Look the email up per request. A network round trip on every request, and
  authentication stalls when a decorative dependency does.
- Refresh from the request that finds the snapshot stale. It puts a fetch back
  on the request path, and the first requests after an outage arrive together
  and need single flight.
- Fail the boot when the listing cannot be loaded. It promotes a display
  dependency to an availability dependency.
- Read more fields, such as titles or teams. No surface wants them, and every
  field read is a field that can be wrong.

## Consequences

A display name stored from a principal, such as a member's when they are added,
is the enriched one from then on. Rows already written are not rewritten.
