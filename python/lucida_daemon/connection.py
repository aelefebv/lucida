"""Connection tracking for Step 07 daemon handshake/session ownership behavior."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass
class ConnectionState:
    connection_id: str
    connected_at: datetime
    handshake_complete: bool = False
    client_name: str | None = None
    client_version: str | None = None
    selected_version: str | None = None

    def record_hello(self, *, params: dict[str, Any], result: dict[str, Any]) -> None:
        self.handshake_complete = True
        client_name = params.get("client_name")
        client_version = params.get("client_version")
        selected_version = result.get("selected_version")
        self.client_name = client_name if isinstance(client_name, str) else None
        self.client_version = client_version if isinstance(client_version, str) else None
        self.selected_version = selected_version if isinstance(selected_version, str) else None
