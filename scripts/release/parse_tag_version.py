#!/usr/bin/env python3
"""Parse Lucida release tags and derive artifact version metadata."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
import re
import shlex
from typing import Any


TAG_RE = re.compile(
    r"^v(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)(?:-rc\.(?P<rc>[1-9]\d*))?$"
)


@dataclass(frozen=True)
class ReleaseTag:
    tag: str
    major: int
    minor: int
    patch: int
    rc: int | None

    @property
    def semver(self) -> str:
        base = f"{self.major}.{self.minor}.{self.patch}"
        if self.rc is None:
            return base
        return f"{base}-rc.{self.rc}"

    @property
    def python_version(self) -> str:
        base = f"{self.major}.{self.minor}.{self.patch}"
        if self.rc is None:
            return base
        return f"{base}rc{self.rc}"

    @property
    def is_prerelease(self) -> bool:
        return self.rc is not None

    @property
    def channel(self) -> str:
        return "testpypi" if self.is_prerelease else "pypi"


class TagParseError(ValueError):
    pass


def normalize_tag(value: str) -> str:
    if value.startswith("refs/tags/"):
        return value.removeprefix("refs/tags/")
    return value


def parse_tag(value: str) -> ReleaseTag:
    tag = normalize_tag(value.strip())
    match = TAG_RE.fullmatch(tag)
    if match is None:
        raise TagParseError(
            f"Invalid release tag '{value}'. Expected vX.Y.Z or vX.Y.Z-rc.N"
        )

    rc = match.group("rc")
    return ReleaseTag(
        tag=tag,
        major=int(match.group("major")),
        minor=int(match.group("minor")),
        patch=int(match.group("patch")),
        rc=int(rc) if rc is not None else None,
    )


def release_payload(tag: ReleaseTag) -> dict[str, Any]:
    return {
        "tag": tag.tag,
        "semver": tag.semver,
        "python_version": tag.python_version,
        "major": str(tag.major),
        "minor": str(tag.minor),
        "patch": str(tag.patch),
        "rc": "" if tag.rc is None else str(tag.rc),
        "is_prerelease": "true" if tag.is_prerelease else "false",
        "channel": tag.channel,
    }


def env_lines(payload: dict[str, Any]) -> str:
    env_map = {
        "RELEASE_TAG": payload["tag"],
        "RELEASE_SEMVER": payload["semver"],
        "RELEASE_PYTHON_VERSION": payload["python_version"],
        "RELEASE_MAJOR": payload["major"],
        "RELEASE_MINOR": payload["minor"],
        "RELEASE_PATCH": payload["patch"],
        "RELEASE_RC": payload["rc"],
        "RELEASE_IS_PRERELEASE": payload["is_prerelease"],
        "RELEASE_PYPI_CHANNEL": payload["channel"],
    }
    ordered_keys = [
        "RELEASE_TAG",
        "RELEASE_SEMVER",
        "RELEASE_PYTHON_VERSION",
        "RELEASE_MAJOR",
        "RELEASE_MINOR",
        "RELEASE_PATCH",
        "RELEASE_RC",
        "RELEASE_IS_PRERELEASE",
        "RELEASE_PYPI_CHANNEL",
    ]
    return "\n".join(
        f"{key}={shlex.quote(str(env_map[key]))}" for key in ordered_keys
    )


def write_github_output(path: str, payload: dict[str, Any]) -> None:
    mapped = {
        "tag": payload["tag"],
        "semver": payload["semver"],
        "python_version": payload["python_version"],
        "major": payload["major"],
        "minor": payload["minor"],
        "patch": payload["patch"],
        "rc": payload["rc"],
        "is_prerelease": payload["is_prerelease"],
        "channel": payload["channel"],
    }
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in mapped.items():
            handle.write(f"{key}={value}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tag",
        default=os.environ.get("RELEASE_TAG") or os.environ.get("GITHUB_REF_NAME") or "",
        help="Release tag, e.g. v1.2.3 or v1.2.3-rc.1",
    )
    parser.add_argument(
        "--format",
        choices=("json", "env", "semver", "python"),
        default="json",
        help="Output format",
    )
    parser.add_argument(
        "--github-output",
        default=os.environ.get("GITHUB_OUTPUT", ""),
        help="Optional path for GitHub Actions output variables",
    )
    args = parser.parse_args()

    if not args.tag:
        print("Missing release tag. Pass --tag or set GITHUB_REF_NAME/RELEASE_TAG.")
        return 1

    try:
        parsed = parse_tag(args.tag)
    except TagParseError as exc:
        print(str(exc))
        return 1

    payload = release_payload(parsed)

    if args.github_output:
        write_github_output(args.github_output, payload)

    if args.format == "json":
        print(json.dumps(payload, sort_keys=True))
    elif args.format == "env":
        print(env_lines(payload))
    elif args.format == "semver":
        print(payload["semver"])
    else:
        print(payload["python_version"])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
