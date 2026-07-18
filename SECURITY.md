# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use
[GitHub's private vulnerability report](https://github.com/aelefebv/lucida/security/advisories/new)
so maintainers can investigate before details or exploit steps become public.
Do not include live credentials, private dataset URLs, or data copied from a
deployment. If the private-report form is unavailable, open a public issue that
only asks for a private contact channel and contains no vulnerability details.

Expect an acknowledgement within three business days and an initial severity
assessment within seven business days. Fix and disclosure timing depends on
impact, exploitability, and release coordination; the reporter will receive
status updates while the report remains active. Maintainers may request a
minimal reproduction against a supported release.

## Supported versions

Security fixes target the newest tagged release and `main`. Lucida is pre-1.0,
so older releases do not receive guaranteed backports. When a fix ships, the
advisory will identify the first fixed image tag and digest. Operators should
deploy images by `tag@sha256:digest`, read release notes before upgrades, and
keep the previous database backup until the new release is verified.

## Scope

Reports about the server, web client, CLI, Python package, authentication,
deployment templates, release pipeline, and dependency chain are in scope.
Public upstream datasets, third-party identity/cloud services, and weaknesses
that require intentionally running with `LUCIDA_AUTH=disabled` plus
`LUCIDA_INSECURE=1` are normally outside the project's control, but reports
showing an unexpected boundary failure are welcome.

Dependency advisories are continuously checked in CI. Any temporary waiver
must name an owner, explain why exposure is bounded, and include a removal date;
the current policy files contain no advisory waivers.
