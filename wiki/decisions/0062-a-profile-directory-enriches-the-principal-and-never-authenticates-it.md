---
type: Decision
title: "A profile directory enriches the principal and never authenticates it"
description: "An optional listing of display names and pictures, keyed by email, is applied in the auth middleware after the mode resolves a principal. A row may change how a person is shown and nothing about who they are. An unreachable listing is survived, and malformed configuration is refused at boot."
tags: [lucida, decision]
source_path: wiki/decisions/0062-a-profile-directory-enriches-the-principal-and-never-authenticates-it.md
created: 2026-09-04
modified: 2026-09-04
---

# A profile directory enriches the principal and never authenticates it

Status: Accepted.

## Decision

`lucida-server::auth::directory` gains a **profile directory**: an optional source,
named by configuration, that supplies a display name and a picture for an email
address. When any auth mode resolves a principal, the middleware looks the email up
in an in-memory snapshot of the directory and, when there is a row, uses the row's
name and picture. When there is no row, when the directory is unreachable, and when
none is configured, the principal is exactly what the mode produced.

It is a component beside the auth modes, not a fourth mode. Who a caller is stays
the mode's decision. The directory decides only how that person is shown.

## The seam

One place, and the same place in every mode: the auth middleware calls the active
`PrincipalExtractor`, receives a principal, applies the directory, and attaches the
result to the request. Nothing upstream of the extractor sees the directory, and
nothing downstream of the middleware can tell whether it ran. Handlers keep reading
`AuthPrincipal` from request extensions, which is the contract
[ADR 0015](0015-server-stored-bookmarks-and-auth-seam.md) set. Peer identity in a
live session, membership records, and creator fields pick the enriched values up
because they already read the principal and nothing else.

Putting the step in the middleware rather than in each extractor keeps the modes
ignorant of it, so a mode is written the way
[ADR 0060](0060-iap-mode-reads-the-identity-the-perimeter-established.md) wrote the
IAP one, with no line about directories. Putting it in the middleware rather than in
a decorating extractor keeps "resolve" and "enrich" as two steps with two names, so a
reader of the middleware sees where authentication ends.

The middleware's state accepts a bare extractor as well as the pair, and a bare
extractor means no directory. Every router wired before the directory existed is
wired exactly as it was, and with the directory unset the principal that reaches a
handler is byte for byte the one the mode produced.

## What a row may change

A row replaces the display name and the picture URL, each only when the row carries
one, and nothing else. In particular:

- **Never the email.** The lookup key is the email the mode resolved, normalized the
  way every mode normalizes it: trimmed and lowercased. The row's own spelling of the
  address, and any other address the row happens to carry, are not consulted.
- **Never the administrator flag.** That comes from `LUCIDA_ADMIN_EMAILS`, in every
  mode, as before. A row that claims otherwise is not read.
- **Never an authorization decision.** Nothing that checks a permission reads
  anything the directory wrote.

The consequence for a security reviewer is the point. A compromised or mistaken
directory can rename people and swap their pictures, and can do nothing else. It
cannot promote, cannot impersonate, and cannot let anyone in.

A picture URL is a string the client renders as an image source and nowhere else.
The server passes it through.

## Why the lookup keys on the resolved email

The alternative, letting the request name the record, is what turns directory
integrations into privilege bugs. A header the caller controls is a header the caller
sets to somebody else's address. Keying on the value the auth mode produced means the
only way to be shown as a person is to authenticate as that person, and the directory
adds no path around that.

The same reasoning covers case and whitespace. Two spellings of one address are one
person, so both sides are normalized with the one function the modes already share,
and a listing that spells someone twice yields one row rather than two people.

## Why an unreachable directory is not a boot failure, and malformed configuration is

The two failures look alike from the inside, since no names come back either way,
and they must be told apart at the moment the operator can still act.

**Malformed configuration stops the boot and names the variable**, the way
`LUCIDA_IAP_AUDIENCE` does: a URL that does not parse or that no HTTP client can
fetch, a field variable that is set but names nothing, a header pair without a
colon, an interval that is not a positive whole number of seconds. Each of these is
a typo. A typo is caught in the first minute or never, and a server that boots with
a directory it can never read would present as a working server showing the wrong
names. The field variables carry defaults, so an absent one is fine. One that is
present and blank is a deployment template that rendered nothing into it, and reading
the default out of it would hide the one mistake worth reporting.

**A listing that cannot be reached, or answers with an error, is logged and
survived.** A directory is a dependency the auth modes do not have, and a boot that
fails on it turns an outage in a decorative service into an outage in lucida. The
server comes up serving the names the mode derives, which is what it served before
the directory existed, and one warning line says what happened. A person with no
row, whether because the listing is down or because they are not in it, sees exactly
what they saw before.

The line between the two is whether the operator could have known before deploying.
A URL is right or wrong at typing time. A host is up or down at runtime.

## Consequences

- **A lookup costs no network round trip.** The listing is fetched whole, once, with
  a ten-second timeout, and held in memory keyed by normalized email. Refreshing that
  snapshot on an interval, keeping the last good one across a failed refresh, and
  treating an empty listing as "not loaded yet" are the next decisions.
  `ProfileDirectory::load` is the operation they repeat, and the interval is already
  parsed and carried.
- **A load reports what it kept and what it skipped.** A wrong endpoint or a wrong
  field name then shows up as zero rows or as most rows skipped, at boot rather than
  on the first complaint. The listing URL is logged without its query string or
  userinfo, since a listing that wants an API key may carry it there.
- **The directory applies in every mode.** A row wins over Google mode's own name and
  picture, because the directory is where an operator curates how people appear.
  Disabled mode is unchanged in practice because its dev principal has no row. It is
  not exempt: a dev principal switched to a listed address is shown as listed.
- **Stored names change going forward, not backward.** A display name recorded from
  a principal, such as a member's when they are added, is the enriched one from now
  on. Rows already written are not rewritten.
- **Configuration is by `LUCIDA_*` variables, and unset means off.** This is the
  contract [ADR 0017](0017-configurable-from-day-one-for-oss-release.md) set: the URL,
  the email field, the name fields, the picture field, fixed request headers, and the
  refresh interval, with defaults for every field name. The name is one or more
  fields joined by one space, so a listing that keeps first and last names apart
  needs no adapter.
- **The wire shape does not change.** `whoami` and peer identity carry the same
  fields with different values.

## Alternatives considered

- **A fourth auth mode that reads the directory.** Rejected. A mode answers "who is
  this". The directory has no answer to that question and must never be asked it.
  Folding the two together is how a directory ends up being trusted.
- **Enrich inside each extractor.** Rejected. Three copies of the same step, three
  places to forget it, and every future mode inherits the obligation.
- **A decorating extractor wrapped around the mode's.** Rejected, narrowly. It
  reaches the same seam, but it makes the directory look like an extractor to
  anything holding the handle, and the value of this decision is that nobody can
  mistake it for one.
- **Look the email up per request.** Rejected. A network round trip on every
  request, and an authentication path that stalls when a decorative dependency does.
- **Fail the boot when the listing cannot be loaded.** Rejected, for the reasons
  above: it promotes a display dependency to an availability dependency.
- **Let a request header name the record.** Rejected, for the reason the lookup-key
  section gives.
- **Read more than a name and a picture.** Rejected. Titles, teams, and reporting
  lines are things other tools surface. lucida has no surface that wants them, and
  every field read is a field that can be wrong.

## Related

- [Server-Stored Bookmarks and the Auth Seam](0015-server-stored-bookmarks-and-auth-seam.md) — the principal every handler reads, and the reason enrichment can happen in one place
- [Configurable From Day One for OSS Release](0017-configurable-from-day-one-for-oss-release.md) — the `LUCIDA_*` contract the directory variables extend
- [Auth Mode Auto-Detect by Bind Address](0018-auth-mode-auto-detect-by-bind-address.md) — the disabled mode whose dev principal has no row
- [IAP mode reads the identity the perimeter established](0060-iap-mode-reads-the-identity-the-perimeter-established.md) — the mode whose assertion carries only an email, and the reason a directory is wanted at all
