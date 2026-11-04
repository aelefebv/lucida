# Issue tracker: GitHub

Issues live on `aelefebv/lucida`, managed with `gh`. Fetch a ticket with
`gh issue view <number> --comments`. Titles and bodies follow the domain-neutral rule in
`CLAUDE.md`.

Triage labels, all present on GitHub: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`.

PRs as a request surface: no.

## Wayfinding operations

Used by `/wayfinder` and `/to-tickets`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. `gh issue create --parent <map>` does it at creation time; `gh issue edit <map> --add-sub-issue <n>` wires one after the fact. Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev. An issue can have only one parent. Leave one that is already someone else's sub-issue, and say so rather than re-parenting silently.
- **Blocking**: GitHub's native issue dependencies, a separate feature from sub-issues, which do not confer blocked state on their own. Declare the edge at creation with `gh issue create --blocked-by <n>[,<n>]` (or `--blocking`), or later with `gh issue edit <child> --add-blocked-by <n>`. Both take the plain issue number, so creating blockers first is enough. Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed. Requires `gh` 2.94 or newer. On older clients use `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where the id is the blocker's numeric database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), not the `#number` or `node_id`.
- **Frontier query**: `gh issue list --state open --json number,title,assignees,blockedBy`, scoped to the map's children, then drop any row with an assignee or an open blocker. `blockedBy` is an object, not an array: `.blockedBy | length` returns 2 on every row. Filter on node states instead: `[.blockedBy.nodes[] | select(.state == "OPEN")] | length == 0`. `.blockedBy.totalCount` counts closed blockers too, so it is no gate either. Per issue, `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary` gives the same live gate. First in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
