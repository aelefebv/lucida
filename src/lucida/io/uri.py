from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlparse


def normalize_uri(uri: str) -> str:
    """Normalize local paths and file:// URIs into canonical file URIs."""
    parsed = urlparse(uri)
    if parsed.scheme == "":
        return Path(uri).expanduser().resolve(strict=False).as_uri()
    if parsed.scheme == "file":
        return Path(unquote(parsed.path)).expanduser().resolve(strict=False).as_uri()
    return uri


def is_remote_uri(uri: str) -> bool:
    parsed = urlparse(uri)
    return bool(parsed.scheme) and parsed.scheme != "file"

