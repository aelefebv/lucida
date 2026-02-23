"""Utilities for normalizing and classifying dataset URIs."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote, urlparse


def normalize_uri(uri: str) -> str:
    """Normalize local paths and file URIs into canonical `file://` URIs.

    Parameters
    ----------
    uri:
        Raw URI or local filesystem path.

    Returns
    -------
    str
        Normalized ``file://`` URI or original remote URI.
    """
    parsed = urlparse(uri)
    if parsed.scheme == "":
        return Path(uri).expanduser().resolve(strict=False).as_uri()
    if parsed.scheme == "file":
        return Path(unquote(parsed.path)).expanduser().resolve(strict=False).as_uri()
    return uri


def is_remote_uri(uri: str) -> bool:
    """Return true when the URI has a non-file scheme.

    Parameters
    ----------
    uri:
        URI string to inspect.

    Returns
    -------
    bool
        ``True`` when scheme exists and is not ``file``.
    """
    parsed = urlparse(uri)
    return bool(parsed.scheme) and parsed.scheme != "file"
