from __future__ import annotations

import uuid

from lucida.client import LucidaClient


def test_usage_client_queries_and_agent_headers(
    local_omezarr_uri: str,
    rust_daemon_base_url: str,
) -> None:
    run_id = f"run-{uuid.uuid4().hex}"
    with LucidaClient(
        base_url=rust_daemon_base_url,
        agent_run_id=run_id,
        agent_name="pytest-agent",
    ) as client:
        session = client.create_session(agent_step_id="step-session")
        opened = client.open_dataset(
            uri=local_omezarr_uri,
            session_id=session.session_id,
            agent_step_id="step-open",
        )
        created = client.create_view(
            dataset_id=opened.dataset_summary.dataset_id,
            session_id=session.session_id,
            mode="2d",
            agent_step_id="step-view",
        )
        rendered = client.render_image(
            view_id=created.view_state.view_id,
            session_id=session.session_id,
            width_px=64,
            height_px=48,
            agent_step_id="step-render",
        )
        assert rendered.status == "ok"

        events = client.list_usage_events(run_id=run_id, limit=200)
        assert events.events, "usage events should be recorded"
        assert all(event.agent_run_id == run_id for event in events.events)
        assert any(event.endpoint == "/render/image" for event in events.events)
        assert any(event.agent_step_id == "step-render" for event in events.events)

        runs = client.list_usage_runs(limit=200)
        matching_runs = [run for run in runs.runs if run.agent_run_id == run_id]
        assert matching_runs, "usage runs should include the current run id"
        assert matching_runs[0].event_count >= 4

        run_detail = client.get_usage_run(run_id=run_id, event_limit=200)
        assert run_detail.run.agent_run_id == run_id
        assert len(run_detail.events) >= 4

        stream_url = client.usage_events_stream_url(run_id=run_id)
        assert "/usage/events/stream" in stream_url
        assert "run_id=" in stream_url


def test_usage_client_per_call_run_override(
    rust_daemon_base_url: str,
) -> None:
    default_run_id = f"default-{uuid.uuid4().hex}"
    override_run_id = f"override-{uuid.uuid4().hex}"

    with LucidaClient(base_url=rust_daemon_base_url, agent_run_id=default_run_id) as client:
        client.create_session()
        client.create_session(agent_run_id=override_run_id)

        default_events = client.list_usage_events(run_id=default_run_id, limit=100)
        override_events = client.list_usage_events(run_id=override_run_id, limit=100)

        assert any(event.endpoint == "/session/create" for event in default_events.events)
        assert any(event.endpoint == "/session/create" for event in override_events.events)
