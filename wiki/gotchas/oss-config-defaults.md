---
type: Gotcha
title: "OSS Config Defaults and the LUCIDA_* Env Var Contract"
description: "Lucida is open-source and keeps zero deployment-specific literals in code — every such value lives in a LUCIDA_* environment variable."
tags: [lucida, gotcha]
source_path: wiki/gotchas/oss-config-defaults.md
created: 2026-05-08
modified: 2026-07-17
---

# OSS Config Defaults and the LUCIDA_* Env Var Contract

Lucida is open-source and intentionally has zero organization-specific literals in code. Every deployment-specific value lives in environment variables. This is a deliberate posture (see [Configurable From Day One for OSS Release](../decisions/0017-configurable-from-day-one-for-oss-release.md)) and shapes a few non-obvious behaviors.

## The contract

All `LUCIDA_*` env vars are part of the **public configuration surface**. Renaming or repurposing one is a breaking change for self-hosters, the same as renaming a public function signature.

The full set is documented in PRD #455 §"Configuration surface". Common ones:

- `LUCIDA_BIND` — bind address. Default `127.0.0.1:9876` (loopback).
- `LUCIDA_AUTH` — auth mode (`google` or `disabled`). Auto-detected from bind address when unset.
- `LUCIDA_ALLOWED_HOSTED_DOMAINS` — comma-separated allowlist of `hd` claim values. Empty = no domain restriction.
- `LUCIDA_ADMIN_EMAILS` — comma-separated allowlist of admin emails. Empty = no admins.
- `LUCIDA_GOOGLE_{CLIENT_ID,CLIENT_SECRET}` and `LUCIDA_OAUTH_REDIRECT_URI` — required when `LUCIDA_AUTH=google`. Note the redirect URI does **not** share the `LUCIDA_GOOGLE_` prefix.
- `LUCIDA_INSECURE` — explicit acknowledgment for `disabled + non-loopback`.
- `LUCIDA_DB_PATH` — SQLite file path. Default `./lucida.db` (CWD-relative).
- `LUCIDA_COOKIE_{NAME,SECURE}` — cookie configuration overrides.
- `LUCIDA_DATA_DIR` — root for `/api/browse`. Mirrors `--data-dir`; CLI flag wins.
- `LUCIDA_GENERATED_COARSE_CACHE_DIR` — generated-coarse cache root. Mirrors `--generated-coarse-cache-dir`; CLI flag wins.
- `LUCIDA_GENERATED_COARSE_DISK_BUDGET_BYTES` — finite root-wide generated-cache ceiling. Default `8589934592` bytes (8 GiB); zero is rejected at startup.
- `LUCIDA_PROXY_CACHE_DIR` — deprecated proxy-era root used only by `clear-proxy-cache` during upgrade cleanup. New generated data is never written there.
- `LUCIDA_GENERATED_COARSE_CONCURRENCY` — generated-coarse worker concurrency. Mirrors `--generated-coarse-concurrency`; CLI flag wins.
- `LUCIDA_SOURCE_HTTP_{HOSTS,CIDRS}` — exact hostname allowlist plus an explicit opt-in for intentional private/LAN ranges.
- `LUCIDA_SOURCE_HTTP_IPV6_TRANSLATION_CIDRS` — deployment-specific RFC 6052 IPv6 translation prefixes to deny. Standard NAT64 and transition forms are always rejected without configuration.
- `LUCIDA_LOG_FORMAT` — `text` (default) or `json`. Switches the tracing subscriber between the dev-friendly pretty formatter and the production JSON formatter that log aggregators consume natively. Unknown values fall back to `text` (mirrors `SecureCookieMode::parse`).
- `LUCIDA_SHUTDOWN_QUIET_PERIOD_SECS` — delay after readiness flips to
  `draining` before the HTTP server stops accepting work. Default `2`; capped
  below the total timeout.
- `LUCIDA_SHUTDOWN_TIMEOUT_SECS` — hard upper bound for connection drain and
  process shutdown. Default `30`; values below one second are raised to one.

## Common misconfigurations

### "Auth disabled but I bound to 0.0.0.0"

Server fail-fasts at startup with `AuthConfigError::InsecureRequiresOptIn`. This is intentional — auto-detect ([Auth Mode Auto-Detect by Bind Address](../decisions/0018-auth-mode-auto-detect-by-bind-address.md)) treats "disabled auth + non-loopback bind" as the dangerous combination that requires explicit `LUCIDA_INSECURE=1` acknowledgment.

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

`LUCIDA_AUTH=microsoft` (or any unknown value) fails at startup with `UnknownAuthMode`. Parsing is deliberately strict — it fails loud rather than silently falling through to `Disabled`. Adding a new auth provider requires implementing the `PrincipalExtractor` trait — the value isn't recognized until a provider implementation registers it. See [Configurable From Day One for OSS Release](../decisions/0017-configurable-from-day-one-for-oss-release.md) for the OSS extension model.

### "Email format issues with hosted domain check"

`LUCIDA_ALLOWED_HOSTED_DOMAINS` and `LUCIDA_ADMIN_EMAILS` are both lowercased at parse time AND when matched against incoming claims. So `LUCIDA_ADMIN_EMAILS="AdMin@Example.com"` correctly matches a JWT with `email: "admin@example.com"`. Whitespace around commas is tolerated.

The hosted domain check uses the JWT `hd` claim, NOT email suffix matching. A user with `email: someone@other-alias.com` but `hd: example.com` is allowed when the allowlist contains `example.com`. Personal Gmail accounts (no `hd` claim at all) are rejected when any allowlist is set.

### "Empty allowed_hosted_domains accepts everyone — is this intentional?"

Yes. Empty list = OSS-permissive default. Self-hosters may want any verified Google email; a hosted deployment sets `LUCIDA_ALLOWED_HOSTED_DOMAINS=example.com` to restrict.

### "I want to add an admin without restarting"

You can't, today. `LUCIDA_ADMIN_EMAILS` is read once at startup. Promotion = config change + restart, takes effect on the user's next request. Admin status is derived per-request (not stored on the session row), so existing sessions immediately reflect the new admin set after restart.

### "I set LUCIDA_DATA_DIR but my browse handler still serves arbitrary paths"

`--data-dir` and generated-coarse options accept their matching `LUCIDA_*` env fallbacks. **CLI flags override env vars** — clap's default behavior. So a systemd unit with both `Environment=LUCIDA_DATA_DIR=/var/lib/lucida/data` and `ExecStart=lucida-server --data-dir /tmp` uses `/tmp`. Drop one source when you want the other to win; the in-tree CLI tests lock this behavior.

### "My NAT64 deployment uses a custom prefix"

The server recognizes and rejects the standardized `64:ff9b::/96` and `64:ff9b:1::/48` forms, plus mapped/compatible, Teredo, 6to4, and ISATAP addresses. RFC 6052 network-specific prefixes have no self-identifying bit pattern, so configure every such operator-owned prefix in `LUCIDA_SOURCE_HTTP_IPV6_TRANSLATION_CIDRS`. Resolved addresses in that list are denied before transport pinning even if their hostname or a broad source CIDR is otherwise allowed.

## Database location

`LUCIDA_DB_PATH` defaults to `./lucida.db` (CWD-relative), which is fine for dev (`cargo run` from the repo root creates files there) but brittle for production. Set it to an absolute path under a writable directory the deployment owns, e.g., `/var/lib/lucida/lucida.db`.

The SQLite file accumulates `lucida.db`, `lucida.db-shm`, `lucida.db-wal` (WAL journal mode for non-blocking writes). All three are in `.gitignore`; back them up together if you back the deployment up.

## What NOT to commit

- `LUCIDA_GOOGLE_CLIENT_SECRET` is a real secret. Keep it in a secrets manager (Google Secret Manager is the obvious choice on GCP) or your deployment system's secrets layer; do not put it in version control.
- The Google OAuth client JSON file (e.g. `client_secret_xxx.json` from Google Console) — `.gitignore` patterns like `*client_secret*.json`, `*.oauth.json`, `google-oauth.json` are good preventive entries.

## Related

- [Configurable From Day One for OSS Release](../decisions/0017-configurable-from-day-one-for-oss-release.md) — full OSS posture rationale
- [Auth Mode Auto-Detect by Bind Address](../decisions/0018-auth-mode-auto-detect-by-bind-address.md) — bind-address auto-detect logic
- [Authentication](../systems/subsystems/auth.md) — the subsystem these env vars configure
