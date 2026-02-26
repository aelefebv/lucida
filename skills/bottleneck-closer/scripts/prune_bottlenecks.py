#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

BOTTLENECK_HEADING_RE = re.compile(r"^###\s+(\d+)\)\s+(.*)$")
NUMBERED_ITEM_RE = re.compile(r"^(\d+)\.\s+(.*)$")


@dataclass(frozen=True)
class BottleneckSection:
    start: int
    end: int
    number: int
    title: str


def parse_sections(lines: list[str]) -> list[BottleneckSection]:
    sections: list[BottleneckSection] = []
    for idx, line in enumerate(lines):
        match = BOTTLENECK_HEADING_RE.match(line.rstrip("\n"))
        if match is None:
            continue
        end = idx + 1
        while end < len(lines):
            next_line = lines[end]
            if next_line.startswith("### ") or next_line.startswith("## "):
                break
            end += 1
        sections.append(
            BottleneckSection(
                start=idx,
                end=end,
                number=int(match.group(1)),
                title=match.group(2),
            )
        )
    return sections


def select_section(sections: list[BottleneckSection], selector: str) -> BottleneckSection:
    if selector.isdigit():
        number = int(selector)
        for section in sections:
            if section.number == number:
                return section
        raise ValueError(f"bottleneck number '{selector}' not found")

    lowered = selector.casefold()
    matches = [section for section in sections if lowered in section.title.casefold()]
    if not matches:
        raise ValueError(f"bottleneck title match '{selector}' not found")
    if len(matches) > 1:
        raise ValueError(
            f"bottleneck title match '{selector}' is ambiguous; use a number instead"
        )
    return matches[0]


def renumber_headings(lines: list[str]) -> list[str]:
    output: list[str] = []
    counter = 1
    for line in lines:
        match = BOTTLENECK_HEADING_RE.match(line.rstrip("\n"))
        if match is None:
            output.append(line)
            continue
        newline = "\n" if line.endswith("\n") else ""
        output.append(f"### {counter}) {match.group(2)}{newline}")
        counter += 1
    return output


def rewrite_implementation_order(lines: list[str], removed_number: int) -> list[str]:
    section_start: int | None = None
    for idx, line in enumerate(lines):
        if line.strip() == "## Suggested implementation order":
            section_start = idx
            break
    if section_start is None:
        return lines

    section_end = len(lines)
    for idx in range(section_start + 1, len(lines)):
        if lines[idx].startswith("## "):
            section_end = idx
            break

    rewritten: list[str] = []
    next_item_number = 1
    for line in lines[section_start + 1 : section_end]:
        stripped = line.rstrip("\n")
        match = NUMBERED_ITEM_RE.match(stripped)
        if match is None:
            rewritten.append(line)
            continue
        item_number = int(match.group(1))
        if item_number == removed_number:
            continue
        newline = "\n" if line.endswith("\n") else ""
        rewritten.append(f"{next_item_number}. {match.group(2)}{newline}")
        next_item_number += 1

    return lines[: section_start + 1] + rewritten + lines[section_end:]


def prune_bottleneck(path: Path, selector: str) -> str:
    content = path.read_text(encoding="utf-8")
    lines = content.splitlines(keepends=True)
    sections = parse_sections(lines)
    if not sections:
        return ""

    target = select_section(sections, selector)
    remaining = lines[: target.start] + lines[target.end :]
    remaining = renumber_headings(remaining)
    remaining = rewrite_implementation_order(remaining, target.number)

    if not parse_sections(remaining):
        return ""
    return "".join(remaining)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Remove a completed bottleneck section from BOTTLENECKS.md, renumber remaining "
            "sections, and clear the file if no bottlenecks remain."
        )
    )
    parser.add_argument("--file", default="BOTTLENECKS.md", help="Path to BOTTLENECKS file.")
    parser.add_argument(
        "--remove",
        required=True,
        help="Bottleneck number (preferred) or unique title substring to remove.",
    )
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"error: file not found: {path}", file=sys.stderr)
        return 1

    try:
        updated = prune_bottleneck(path, args.remove)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    path.write_text(updated, encoding="utf-8")
    if updated:
        print(f"updated {path} and removed bottleneck '{args.remove}'")
    else:
        print(f"cleared {path}; no bottlenecks remain")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
