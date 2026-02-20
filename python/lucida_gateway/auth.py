"""Bearer token helpers for gateway HTTP/WS authentication."""

from __future__ import annotations

from aiohttp import web


def extract_bearer_token(auth_header: str | None) -> str | None:
    if auth_header is None:
        return None
    raw = auth_header.strip()
    if not raw:
        return None
    prefix = "Bearer "
    if not raw.startswith(prefix):
        return None
    token = raw[len(prefix) :].strip()
    return token or None


def is_authorized(
    *,
    auth_header: str | None,
    query_token: str | None,
    expected_token: str,
) -> bool:
    provided = extract_bearer_token(auth_header)
    if provided is None and isinstance(query_token, str) and query_token:
        provided = query_token
    return isinstance(provided, str) and provided == expected_token


def unauthorized_response() -> web.Response:
    return web.json_response(
        {
            "error": {
                "code": "UNAUTHORIZED",
                "message": "Missing or invalid bearer token",
            }
        },
        status=401,
    )


__all__ = ["extract_bearer_token", "is_authorized", "unauthorized_response"]
