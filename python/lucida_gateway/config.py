"""Configuration contract for the Step 11 remote web gateway."""

from __future__ import annotations

from dataclasses import dataclass

from lucida_core.errors import invalid_params


_LOCALHOST_HOSTS = {"127.0.0.1", "localhost", "::1"}


@dataclass(frozen=True)
class GatewayConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    token: str = ""
    local_ipc_uri: str | None = None
    tls_termination: bool = False
    frame_rate_hz: int = 15
    tile_size_px: int = 256
    jpeg_quality: int = 75
    render_queue_capacity: int = 2
    overflow_close_threshold: int = 10
    event_poll_interval_s: float = 0.05
    auto_launch_daemon: bool = True

    def validate(self) -> None:
        if not isinstance(self.host, str) or not self.host:
            raise invalid_params("host must be a non-empty string", {"host": self.host})
        if not isinstance(self.port, int) or not (1 <= self.port <= 65535):
            raise invalid_params("port must be between 1 and 65535", {"port": self.port})
        if not isinstance(self.token, str) or len(self.token) < 8:
            raise invalid_params(
                "token must be set with at least 8 characters",
                {"token_set": isinstance(self.token, str)},
            )
        if not isinstance(self.frame_rate_hz, int) or self.frame_rate_hz <= 0:
            raise invalid_params(
                "frame_rate_hz must be a positive integer",
                {"frame_rate_hz": self.frame_rate_hz},
            )
        if not isinstance(self.tile_size_px, int) or self.tile_size_px <= 0:
            raise invalid_params(
                "tile_size_px must be a positive integer",
                {"tile_size_px": self.tile_size_px},
            )
        if not isinstance(self.jpeg_quality, int) or not (1 <= self.jpeg_quality <= 100):
            raise invalid_params(
                "jpeg_quality must be between 1 and 100",
                {"jpeg_quality": self.jpeg_quality},
            )
        if not isinstance(self.render_queue_capacity, int) or self.render_queue_capacity <= 0:
            raise invalid_params(
                "render_queue_capacity must be a positive integer",
                {"render_queue_capacity": self.render_queue_capacity},
            )
        if not isinstance(self.overflow_close_threshold, int) or self.overflow_close_threshold <= 0:
            raise invalid_params(
                "overflow_close_threshold must be a positive integer",
                {"overflow_close_threshold": self.overflow_close_threshold},
            )
        if not isinstance(self.event_poll_interval_s, (int, float)) or self.event_poll_interval_s <= 0:
            raise invalid_params(
                "event_poll_interval_s must be a positive number",
                {"event_poll_interval_s": self.event_poll_interval_s},
            )
        if self.host not in _LOCALHOST_HOSTS and not self.tls_termination:
            raise invalid_params(
                "non-local host bind requires tls_termination=true",
                {"host": self.host, "tls_termination": self.tls_termination},
            )

    @property
    def is_localhost_bind(self) -> bool:
        return self.host in _LOCALHOST_HOSTS


__all__ = ["GatewayConfig"]
