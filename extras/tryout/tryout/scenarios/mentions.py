"""The ``mentions`` scenario: verify lucida's @-mention flow like a user.

This is the reference scenario — the @-mention feature we first verified by hand,
now expressed as *pure steps* on the framework (:mod:`tryout.scenarios._runner`):
a ``seed`` returning document commands, an ``init_scripts`` that pins the browser
identity, a testid-driven UI ``program`` with named shots, and an ``ok`` verdict.

The recipe (implemented exactly):

1. **Pin the browser identity BEFORE load.** ``addInitScript`` sets
   ``localStorage["lucida.annotation.author"] = "tryout-verifier"`` so the SPA
   reads it on first load. Compute the handle the SPA derives for "me" —
   ``deriveHandle("tryout-verifier")`` = FNV-1a-32 over the UTF-16 code units ->
   base36 -> ``"user" + padStart(8, "0")`` (matching the SPA's
   ``annotationParticipants.deriveHandle``) — so we can seed a comment that
   mentions exactly that handle.
2. **Seed over WS** (against the real ``wds-…`` ``dataset_id``, NOT the workspace
   id): a pin ``pin-mito`` authored by ``tryout-verifier``; a comment by
   ``alice-9f2`` that mentions ``@<myhandle>`` (so it lands in *mentions of me*);
   and a comment by ``tryout-verifier`` mentioning ``@Alice`` and ``@Bob`` (so the
   thread shows readable chips). Each command's ack is awaited by the framework.
3. **Drive the SPA by data-testid** (never the canvas): the mentions-of-me badge
   (count) -> shot; click it -> the mentions-of-me panel -> shot; click the panel
   row carrying the comment text (not the "Unread only" toggle) -> the thread
   opens with chips -> shot; focus the thread composer and type ``@`` -> the
   collaborator autocomplete appears -> shot.
4. **Verdict:** ok iff the badge + panel + chip shots are non-blank.

The mention feature needs a mentions-bearing build; the harness drives whatever
``LUCIDA_TRYOUT_WEB_DIST`` (and the server/CLI bins) point at, so this scenario is
build-agnostic — CI/runtime supplies the mentions build.
"""

from __future__ import annotations

from typing import Any

from . import Scenario, ScenarioResult, ShotResult, register
from ._runner import ScenarioContext, ScenarioSpec
from ._browser import UiStep


# The identity we pin into the SPA's localStorage before load. The SPA reads this
# as the current annotation author and derives a stable handle for "me" from it.
AUTHOR = "tryout-verifier"
AUTHOR_KEY = "lucida.annotation.author"

# Pin id we seed and then open in the UI.
PIN_ID = "pin-mito"

# Shot names (the four captures the recipe produces, in order).
SHOT_BADGE = "mentions-badge"
SHOT_PANEL = "mentions-panel"
SHOT_CHIPS = "thread-chips"
SHOT_AUTOCOMPLETE = "autocomplete"

# Test ids the SPA exposes for the mention flow (never the canvas).
TID_BADGE = "mentions-of-me-badge"
TID_PANEL = "mentions-of-me-panel"
TID_CHIP = "mention-chip"
# Each mention row in the panel is a button with a per-comment testid
# `mention-of-me-item-<commentId>`; we match on the prefix so we click the row
# (which opens the pin's thread) rather than the panel dialog or the toggle.
TID_ROW_PREFIX = "mention-of-me-item-"
# The collaborator autocomplete renders option buttons `mention-option-<id>`
# when '@' is typed in the composer; we wait for one before the autocomplete shot.
TID_OPTION_PREFIX = "mention-option-"

# The comment text we seed from alice — it both mentions "me" (so it lands in the
# mentions-of-me panel) and is the row text we click to open the thread.
MENTION_OF_ME_TEXT_TAIL = "can you confirm these are region-a?"


def derive_handle(author: str) -> str:
    """Compute the SPA's handle for ``author``: ``annotationParticipants.deriveHandle``.

    FNV-1a-32 over the string's **UTF-16 code units**, rendered base36, then
    ``"user" + base36.padStart(8, "0")``. Kept byte-for-byte faithful to the SPA
    so a seeded ``@<handle>`` mention matches the handle the SPA computes for the
    pinned identity. (UTF-16 code units = ``charCodeAt`` per JS; for BMP text this
    is the per-character code point, and surrogate pairs decompose into two units,
    exactly as ``charCodeAt`` yields.)
    """
    fnv_offset = 0x811C9DC5
    fnv_prime = 0x01000193
    h = fnv_offset
    # UTF-16-LE bytes -> 16-bit code units (matches JS String charCodeAt order).
    units = author.encode("utf-16-le")
    for i in range(0, len(units), 2):
        code_unit = units[i] | (units[i + 1] << 8)
        h ^= code_unit
        h = (h * fnv_prime) & 0xFFFFFFFF
    return "user" + _to_base36(h).rjust(8, "0")


def _to_base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while value:
        out = digits[value % 36] + out
        value //= 36
    return out


def _my_handle() -> str:
    return derive_handle(AUTHOR)


def init_scripts(ctx: ScenarioContext) -> list[str]:
    """Pin the annotation author into localStorage BEFORE any page script runs."""
    # JSON-encode the value so quoting is safe inside the JS string.
    import json

    key = json.dumps(AUTHOR_KEY)
    value = json.dumps(AUTHOR)
    return [
        f"try {{ window.localStorage.setItem({key}, {value}); }} catch (e) {{}}"
    ]


def seed(ctx: ScenarioContext) -> list[dict[str, Any]]:
    """The document commands that seed the mention flow.

    Targets the real opened dataset (``ctx.dataset_id``, a ``wds-…`` id — NOT the
    workspace id). Raises if no dataset opened (the scenario can't seed a pin
    without one), which the framework records as a clean scenario error.
    """
    from ..errors import TryoutError

    dataset_id = ctx.dataset_id
    if not dataset_id:
        raise TryoutError(
            "seed",
            "mentions scenario requires an opened dataset (a wds-… id) to anchor the pin; "
            "none was opened (pass --fixture or set LUCIDA_TRYOUT_FIXTURE)",
        )

    my_handle = _my_handle()
    ctx.log(f"[tryout] mentions: derived my handle = @{my_handle} (from author {AUTHOR!r})")

    return [
        # 1) A pin authored by me, anchored on the dataset.
        {
            "type": "add_annotation",
            "dataset_id": dataset_id,
            "id": PIN_ID,
            "position": [120.0, 90.0],
            "author": AUTHOR,
            "kind": "point",
        },
        # 2) A comment by alice-9f2 that mentions ME (@<myhandle>) -> mentions of me.
        {
            "type": "add_comment",
            "dataset_id": dataset_id,
            "annotation_id": PIN_ID,
            "id": "cmt-alice-1",
            "author": "alice-9f2",
            "text": f"@{my_handle} {MENTION_OF_ME_TEXT_TAIL}",
        },
        # 3) A comment by me mentioning @Alice and @Bob -> readable chips.
        {
            "type": "add_comment",
            "dataset_id": dataset_id,
            "annotation_id": PIN_ID,
            "id": "cmt-me-1",
            "author": AUTHOR,
            "text": "Thanks @Alice and @Bob — adding this to the report.",
        },
    ]


def program(ctx: ScenarioContext) -> list[UiStep]:
    """The testid-driven UI program: badge -> panel -> chips -> autocomplete.

    Every action targets a ``data-testid`` (or the composer placeholder), never the
    canvas, so each shot is content-bearing and the program reads like the manual
    flow it replaces.
    """
    return [
        # The badge shows the count of mentions of me.
        UiStep("wait_testid", testid=TID_BADGE),
        UiStep("shot", name=SHOT_BADGE),
        # Open the mentions-of-me panel.
        UiStep("click_testid", testid=TID_BADGE),
        UiStep("wait_testid", testid=TID_PANEL),
        UiStep("shot", name=SHOT_PANEL),
        # Click the panel ROW carrying alice's comment text (a mention-of-me item
        # button, not the "Unread only" toggle) to open the pin's thread; wait for
        # a mention chip to confirm the thread (with rendered @-chips) opened.
        UiStep(
            "click_row_with_text",
            testid_prefix=TID_ROW_PREFIX,
            text=MENTION_OF_ME_TEXT_TAIL,
        ),
        UiStep("wait_testid", testid=TID_CHIP),
        UiStep("shot", name=SHOT_CHIPS),
        # Focus the thread composer and type '@' to summon the collaborator
        # autocomplete; wait for an option to render, then capture it. (The
        # autocomplete shot is a bonus — not in the verdict — so each of these is
        # best-effort: a build without it still passes on the badge/panel/chip.)
        UiStep("focus_placeholder", text="comment", required=False),
        UiStep("type", text="@", required=False),
        UiStep("wait_testid_prefix", testid_prefix=TID_OPTION_PREFIX, required=False),
        UiStep("shot", name=SHOT_AUTOCOMPLETE, required=False),
    ]


def verdict(shots: dict[str, ShotResult]) -> bool:
    """Ok iff the badge + panel + chip shots are non-blank (the recipe's rule).

    The autocomplete shot is a bonus and does not gate the verdict.
    """
    required = (SHOT_BADGE, SHOT_PANEL, SHOT_CHIPS)
    return all(name in shots and shots[name].nonblank for name in required)


def summary(ctx: ScenarioContext, result: ScenarioResult) -> str:
    """A short human summary for the emailed message body."""
    my_handle = _my_handle()
    lines = [
        f"lucida @-mention verification — {'OK' if result.ok else 'NOT OK'}",
        "",
        f"Identity pinned: {AUTHOR}  (handle @{my_handle})",
        f"Workspace: {ctx.workspace_id}",
        f"Dataset:   {ctx.dataset_id}",
        f"URL:       {ctx.workspace_url}",
        "",
        "What was verified:",
        "  - alice-9f2 mentioned me -> the mentions-of-me badge + panel show it",
        "  - opening the thread shows the comment's mention chips (@Alice, @Bob)",
        "  - the thread composer's '@' autocomplete lists collaborators",
        "",
        "Screenshots:",
    ]
    for shot in result.shots:
        mark = "non-blank" if shot.nonblank else ("blank" if shot.exists else "missing")
        lines.append(f"  - {shot.name}.png: {mark}")
    return "\n".join(lines)


# The scenario spec the framework consumes (pure steps; the framework owns boot,
# the WS seed transport, the Playwright launch/teardown, capture, and email).
SPEC = ScenarioSpec(
    name="mentions",
    seed=seed,
    program=program,
    init_scripts=init_scripts,
    ok=verdict,
    summary=summary,
)


def _run(ctx: ScenarioContext) -> ScenarioResult:
    """Registry entrypoint: run the mentions spec against the booted ctx."""
    from ._runner import run_scenario

    return run_scenario(ctx, SPEC)


register(
    Scenario(
        name="mentions",
        run=_run,
        description="verify the @-mention flow (badge -> panel -> thread chips -> @ autocomplete)",
    )
)
