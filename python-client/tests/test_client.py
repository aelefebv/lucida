from lucida_py.client import AttachMode, LucidaClient, PermissionScope


def test_attach_payload_supports_open_and_control_modes() -> None:
    client = LucidaClient(session_id="sess_00000001", client_id="cli_00000001")

    open_payload = client.attach_session(client_label="notebook")
    assert open_payload["requested_permission"] == "view"
    assert open_payload["auth"]["mode"] == AttachMode.OPEN_VIEW.value

    control_payload = client.attach_session(
        client_label="notebook",
        mode=AttachMode.CONTROL,
        token="control-token",
    )
    assert control_payload["requested_permission"] == "control"
    assert control_payload["auth"]["token"] == "control-token"


def test_attach_requires_token_for_control_and_token_view() -> None:
    client = LucidaClient(session_id="sess_00000001", client_id="cli_00000001")
    try:
        client.attach_session(client_label="notebook", mode=AttachMode.TOKEN_VIEW)
    except ValueError as error:
        assert "token is required" in str(error)
    else:
        raise AssertionError("expected token validation error")


def test_viewer_commands_use_canonical_envelope_schema() -> None:
    client = LucidaClient(session_id="sess_00000001", client_id="cli_00000001")
    add_image = client.add_image(name="cells", source_uri="/tmp/cells.ome.zarr")
    set_point = client.set_point(x=1.5, y=2.5, z=4, t=0)
    set_camera = client.set_camera(center_x=10, center_y=12, zoom=2.0)

    assert add_image.scope == PermissionScope.SCENE_SHARED
    assert add_image.requires_lease is True
    assert add_image.client_seq == 1
    assert add_image.args["name"] == "cells"

    assert set_point.op == "view.set_point"
    assert set_point.client_seq == 2

    assert set_camera.op == "view.set_camera"
    assert set_camera.client_seq == 3

    drained = client.queue().drain()
    assert [command.op for command in drained] == [
        "scene.add_source",
        "view.set_point",
        "view.set_camera",
    ]
