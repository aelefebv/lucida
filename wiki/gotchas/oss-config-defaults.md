---
created: 2026-05-08
modified: 2026-05-08
---

# OSS Config Defaults and the LUCIDA_* Env Var Contract

Lucida is open-source and intentionally has zero Calico-specific literals in code. Every Calico-specific value lives in environment variables. This is a deliberate posture (see [[decisions/0017-configurable-from-day-one-for-oss-release]]) and shapes a few non-obvious behaviors.

## The contract

All `LUCIDA_*` env vars are part of the **public configuration surface**. Renaming or repurposing one is a breaking change for self-hosters, the same as renaming a public function signature.

The full set is documented in PRD #455 §"Configuration surface". Common ones:

- `LUCIDA_BIND` — bind address. Default `127.0.0.1:9876` (loopback).
- `LUCIDA_AUTH` — auth mode (`google` or `disabled`). Auto-detected from bind address when unset.
- `LUCIDA_ALLOWED_HOSTED_DOMAINS` — comma-separated allowlist of `hd` claim values. Empty = no domain restriction.
- `LUCIDA_ADMIN_EMAILS` — comma-separated allowlist of admin emails. Empty = no admins.
- `LUCIDA_GOOGLE_{CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}` — required when `LUCIDA_AUTH=google`.
- `LUCIDA_INSECURE` — explicit acknowledgment for `disabled + non-loopback`.
- `LUCIDA_DB_PATH` — SQLite file path. Default `./lucida.db` (CWD-relative).
- `LUCIDA_COOKIE_{NAME,SECURE}` — cookie configuration overrides.

## Common misconfigurations

### "Auth disabled but I bound to 0.0.0.0"

Server fail-fasts at startup with `AuthConfigError::InsecureRequiresOptIn`. This is intentional — auto-detect ([[decisions/0018-auth-mode-auto-detect-by-bind-address]]) treats "disabled auth + non-loopback bind" as the dangerous combination that requires explicit `LUCIDA_INSECURE=1` acknowledgment.

If you genuinely want auth-off on a non-loopback bind (private network, VPN-only deployment, hardcoded firewall):
```
LUCIDA_BIND=0.0.0.0:9876 LUCIDA_AUTH=disabled LUCIDA_INSECURE=1 cargo run --bin lucida-server
```
Server starts with a prominent multi-line warning banner. Treat any production deployment with this combination as needing extra scrutiny in code review.

### "I changed LUCIDA_BIND to 0.0.0.0 and now sign-in is broken"

You also need to set Google credentials (`LUCIDA_GOOGLE_CLIENT_ID`, `LUCIDA_GOOGLE_CLIENT_SECRET`, `LUCIDA_OAUTH_REDIRECT_URI`) because non-loopback bind auto-defaults `LUCIDA_AUTH=google`. The fail-fast at startup names the missing variable.

### "Behind a TLS-terminating proxy, cookies don't set"

The proxy terminates TLS and forwards `http://` to lucida. Lucida's auto-detection of `Secure` looks at the request scheme, sees `http`, and doesn't set `Secure`. Browser then refuses the cookie (Secure-only context vs. proxied http mismatch).

We deliberately do NOT trust `X-Forwarded-Proto` (forgeable; documented inline in `auth/cookie.rs`). Set `LUCIDA_COOKIE_SECURE=always` to force `Secure` cookies regardless of detected scheme.

### "Microsoft auth value doesn't work"

`LUCIDA_AUTH=microsoft` (or any unknown value) fails at startup with `UnknownAuthMode`. Slice 7 deliberately tightened parsing to fail loud rather than silently fall through to `Disabled`. Adding a new auth provider requires implementing the `PrincipalExtractor` trait — the value isn't recognized until a provider implementation registers it. See [[decisions/0017-configurable-from-day-one-for-oss-release]] for the OSS extension model.

### "Email format issues with hosted domain check"

`LUCIDA_ALLOWED_HOSTED_DOMAINS` and `LUCIDA_ADMIN_EMAILS` are both lowercased at parse time AND when matched against incoming claims. So `LUCIDA_ADMIN_EMAILS="AuStin@CalicoLabs.com"` correctly matches a JWT with `email: "austin@calicolabs.com"`. Whitespace around commas is tolerated.

The hosted domain check uses the JWT `hd` claim, NOT email suffix matching. A user with `email: someone@calico-alias.com` but `hd: calicolabs.com` is allowed when the allowlist contains `calicolabs.com`. Personal Gmail accounts (no `hd` claim at all) are rejected when any allowlist is set.

### "Empty allowed_hosted_domains accepts everyone — is this intentional?"

Yes. Empty list = OSS-permissive default. Self-hosters may want any verified Google email; Calico's deployment sets `LUCIDA_ALLOWED_HOSTED_DOMAINS=calicolabs.com` to restrict.

### "I want to add an admin without restarting"

You can't, today. `LUCIDA_ADMIN_EMAILS` is read once at startup. Promotion = config change + restart, takes effect on the user's next request. Admin status is derived per-request (not stored on the session row), so existing sessions immediately reflect the new admin set after restart.

## Database location

`LUCIDA_DB_PATH` defaults to `./lucida.db` (CWD-relative), which is fine for dev (`cargo run` from the repo root creates files there) but brittle for production. Set it to an absolute path under a writable directory the deployment owns, e.g., `/var/lib/lucida/lucida.db`.

The SQLite file accumulates `lucida.db`, `lucida.db-shm`, `lucida.db-wal` (WAL journal mode for non-blocking writes). All three are in `.gitignore`; back them up together if you back the deployment up.

## What NOT to commit

- `LUCIDA_GOOGLE_CLIENT_SECRET` is a real secret. Keep it in a secrets manager (Google Secret Manager is the obvious choice on GCP) or your deployment system's secrets layer; do not put it in version control.
- The Google OAuth client JSON file (e.g. `client_secret_xxx.json` from Google Console) — `.gitignore` patterns like `*client_secret*.json`, `*.oauth.json`, `google-oauth.json` are good preventive entries.

## Related

- [[decisions/0017-configurable-from-day-one-for-oss-release]] — full OSS posture rationale
- [[decisions/0018-auth-mode-auto-detect-by-bind-address]] — bind-address auto-detect logic
- [[auth]] — the subsystem these env vars configure
