from __future__ import annotations

from dataclasses import dataclass

from .client import LucidaClient


@dataclass(frozen=True)
class WidgetConfig:
    base_url: str
    session_id: str
    client_id: str
    width: int = 960
    height: int = 600


class LucidaWidgetShell:
    def __init__(self, config: WidgetConfig, client: LucidaClient) -> None:
        self._config = config
        self._client = client

    @property
    def client(self) -> LucidaClient:
        return self._client

    @property
    def config(self) -> WidgetConfig:
        return self._config

    def iframe_html(self) -> str:
        src = (
            f"{self._config.base_url.rstrip('/')}/viewer?"
            f"session_id={self._config.session_id}&client_id={self._config.client_id}"
        )
        return (
            "<iframe "
            f"src=\"{src}\" "
            f"width=\"{self._config.width}\" "
            f"height=\"{self._config.height}\" "
            "style=\"border:0;\" "
            "allow=\"clipboard-read; clipboard-write\" "
            "></iframe>"
        )

    def display(self) -> object:
        html = self.iframe_html()
        try:
            from IPython.display import HTML
        except Exception:  # pragma: no cover - optional dependency
            return html
        return HTML(html)


def create_widget_shell(
    base_url: str,
    session_id: str,
    client_id: str,
    width: int = 960,
    height: int = 600,
) -> LucidaWidgetShell:
    client = LucidaClient(session_id=session_id, client_id=client_id)
    return LucidaWidgetShell(
        config=WidgetConfig(
            base_url=base_url,
            session_id=session_id,
            client_id=client_id,
            width=width,
            height=height,
        ),
        client=client,
    )
