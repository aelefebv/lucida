from lucida_py.jupyter import WidgetConfig, create_widget_shell


def test_widget_shell_generates_iframe_html() -> None:
    shell = create_widget_shell(
        base_url="http://localhost:4000",
        session_id="sess_00000001",
        client_id="cli_00000001",
        width=800,
        height=400,
    )

    html = shell.iframe_html()
    assert "iframe" in html
    assert "session_id=sess_00000001" in html
    assert "client_id=cli_00000001" in html
    assert "width=\"800\"" in html
    assert "height=\"400\"" in html


def test_widget_shell_exposes_underlying_client() -> None:
    shell = create_widget_shell(
        base_url="http://localhost:4000",
        session_id="sess_00000001",
        client_id="cli_00000001",
    )
    command = shell.client.set_point(x=1.0, y=2.0, z=3, t=4)
    assert command.op == "view.set_point"
    assert command.client_seq == 1


def test_widget_config_is_preserved() -> None:
    shell = create_widget_shell(
        base_url="http://localhost:4000",
        session_id="sess_00000099",
        client_id="cli_00000099",
    )
    assert shell.config == WidgetConfig(
        base_url="http://localhost:4000",
        session_id="sess_00000099",
        client_id="cli_00000099",
        width=960,
        height=600,
    )
