from __future__ import annotations

from lucida.client import LucidaClient


def test_capabilities_client_integration(rust_daemon_base_url: str) -> None:
    with LucidaClient(base_url=rust_daemon_base_url) as client:
        capabilities = client.get_capabilities()

    assert capabilities.schema_version == 1
    assert "2d" in capabilities.render_modes
    assert "png" in capabilities.output_formats
    assert isinstance(capabilities.gpu.available, bool)
