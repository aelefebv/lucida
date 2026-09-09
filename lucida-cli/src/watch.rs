//! `lucida trace watch`: follow a live session's watch stream (#1068).
//!
//! The pull path needs a run that ends. This is the case where there is
//! none — a session that keeps fetching after the view looks loaded, on
//! somebody else's machine, in a tab this command did not open. A person
//! turns the watch toggle on in their monitor, and this subscribes to the
//! workspace socket and prints what their page publishes.
//!
//! **Line-delimited JSON, and only that.** One object per line, flushed as it
//! arrives, so a long-running job can block on the stream and wake on a
//! finding. There is no text rendering and no closing summary: a stream has
//! no end to summarise, and a half-written table is worse than no table. The
//! rest of the CLI's text-then-JSON convention is about answers, and this
//! command has no answer, only a feed.
//!
//! **It computes nothing.** Each line is what the page published, inside the
//! envelope the server relayed it in. The derivation lives behind the trace
//! seam ([ADR 0051]), so a watcher that reduced or re-judged what it received
//! would be a second opinion nobody asked for; `lucida trace show` reads the
//! run when it closes.

use std::time::Duration;

use futures_util::StreamExt;
use lucida_core::protocol::{ClientId, ClientMessage, ServerMessage};

use crate::error::{CliError, ErrorKind};
use crate::output::Output;
use crate::session::{
    IncomingSessionMessage, connect_workspace_socket, incoming_messages, send_client_message,
};

/// How long to wait for the connect handshake before giving up. The same
/// order as every other one-shot session helper: a socket that has not
/// answered by now is not going to.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

pub struct WatchOptions {
    /// Follow one publishing page. Every page in the workspace when absent.
    pub client_id: Option<ClientId>,
    /// Stop after this long. Runs until the socket closes or the reader quits
    /// when absent, which is the point of the command.
    pub duration: Option<Duration>,
}

/// What one frame off the socket means to a watch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchFrame<'a> {
    /// Print this, as it arrived.
    Line(&'a str),
    /// The workspace was archived; the watch ends with an error.
    Archived,
    /// Somebody else's frame, or a page this watch is not following.
    Skip,
}

/// Read one frame off the socket.
///
/// A relayed item prints as the frame the server sent, not as a rendering of
/// it. Parsing it back out and re-serialising would silently drop whatever
/// the page published that this binary predates, which is the one thing a
/// watcher must not do: the stream carries the trace's own objects, and their
/// vocabulary is versioned by the trace rather than by the CLI.
///
/// A frame that does not parse is skipped rather than fatal. A newer server
/// may notify with message types this binary does not know, and none of them
/// can be the stream.
pub fn read_frame(filter: Option<ClientId>, text: &str) -> WatchFrame<'_> {
    match serde_json::from_str::<ServerMessage>(text) {
        Ok(ServerMessage::WorkspaceArchived { .. }) => WatchFrame::Archived,
        Ok(ServerMessage::WatchUpdate { client_id, .. })
            if filter.is_none_or(|wanted| wanted == client_id) =>
        {
            WatchFrame::Line(text)
        }
        _ => WatchFrame::Skip,
    }
}

/// Subscribe to the workspace's watch stream and print it until the duration
/// elapses or the socket closes.
///
/// A closed socket ends the watch rather than failing it: the stream is over,
/// which is a result and not a fault. A transport failure is still an error.
pub async fn watch_workspace(
    ws_url: &str,
    token: Option<&str>,
    output: Output,
    options: WatchOptions,
) -> Result<(), CliError> {
    let socket = connect_workspace_socket(ws_url, token).await?;
    let (mut write, read) = socket.split();
    let mut messages = Box::pin(incoming_messages(read));

    crate::session::wait_for_workspace_snapshot(&mut messages, SNAPSHOT_TIMEOUT).await?;
    send_client_message(&mut write, &ClientMessage::WatchSubscribe).await?;

    // A duration that runs out ends the watch rather than failing it: what
    // was printed is what there was.
    let deadline = options
        .duration
        .map(|duration| tokio::time::Instant::now() + duration);

    loop {
        let message = match deadline {
            Some(at) => match tokio::time::timeout_at(at, messages.next()).await {
                Ok(message) => message,
                Err(_) => break,
            },
            None => messages.next().await,
        };
        let Some(message) = message else { break };
        let IncomingSessionMessage::Text(text) = message? else {
            continue;
        };
        match read_frame(options.client_id, &text) {
            WatchFrame::Line(line) => output.print_human(line),
            WatchFrame::Archived => {
                return Err(CliError::new(
                    ErrorKind::ArchivedWorkspace,
                    "workspace was archived while watching",
                ));
            }
            WatchFrame::Skip => continue,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_core::protocol::{
        WatchBoundaryEvent, WatchItem, WatchRunCause, WatchSendTally, WatchTick,
    };
    use std::collections::BTreeMap;

    /// One relayed frame, as the server puts it on the wire.
    fn relayed(seq: u64, publisher: ClientId, item: WatchItem) -> String {
        serde_json::to_string(&ServerMessage::WatchUpdate {
            client_id: publisher,
            seq,
            item,
        })
        .unwrap()
    }

    fn aggregate() -> WatchItem {
        WatchItem::Aggregate {
            at_epoch_ms: 1_767_225_600_250,
            run_id: Some("run-3".into()),
            reading: None,
            counted: BTreeMap::new(),
            sent: BTreeMap::from([(
                "chunkRequest".to_string(),
                WatchSendTally {
                    messages: 12,
                    bytes: 1_140,
                },
            )]),
            ticks: vec![WatchTick {
                at_us: 4_199_000,
                dataset_id: "wds-0f3a".into(),
                counters: BTreeMap::from([("laneDetail".to_string(), 12)]),
                levels: Vec::new(),
                levels_dropped: 0,
                target_level: None,
                level_pinned: false,
                displayed_level: None,
                availability_woken: false,
                extra: BTreeMap::new(),
            }],
        }
    }

    fn boundary() -> WatchItem {
        WatchItem::Boundary {
            at_epoch_ms: 1_767_225_604_700,
            event: WatchBoundaryEvent::RunClosed,
            run_id: Some("run-3".into()),
            cause: Some(WatchRunCause {
                epoch: Some("view".into()),
                dirty_kind: "interactive".into(),
                source: "orbit".into(),
            }),
            end_reason: Some("quiescent".into()),
            duration_us: Some(4_700_000),
        }
    }

    fn provisional() -> WatchItem {
        WatchItem::Provisional {
            at_epoch_ms: 1_767_225_602_000,
            provisional_reading: serde_json::json!({
                "provisional": true,
                "statement": "provisional — nothing crossed a threshold in the window",
            }),
        }
    }

    fn line_of(frame: WatchFrame<'_>) -> serde_json::Value {
        let WatchFrame::Line(line) = frame else {
            panic!("expected a line, got {frame:?}");
        };
        assert!(!line.contains('\n'), "a line is one object: {line}");
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn every_kind_the_page_publishes_prints_as_its_own_line() {
        let frames: Vec<String> = [aggregate(), boundary(), provisional()]
            .into_iter()
            .enumerate()
            .map(|(index, item)| relayed(index as u64 + 1, 3, item))
            .collect();
        let lines: Vec<serde_json::Value> = frames
            .iter()
            .map(|frame| line_of(read_frame(None, frame)))
            .collect();

        let kinds: Vec<&str> = lines
            .iter()
            .map(|line| line["item"]["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["aggregate", "boundary", "provisional"]);

        // `seq` is the workspace's one running count, which is the only way to
        // see a gap where the ring wrapped.
        assert_eq!(lines[0]["client_id"], 3);
        assert_eq!(lines[0]["seq"], 1);
        assert_eq!(lines[1]["seq"], 2);

        // The trace's own objects keep the trace's names inside the item.
        assert_eq!(lines[0]["item"]["sent"]["chunkRequest"]["bytes"], 1_140);
        assert_eq!(lines[0]["item"]["ticks"][0]["counters"]["laneDetail"], 12);
        assert_eq!(lines[1]["item"]["cause"]["dirtyKind"], "interactive");
        assert_eq!(lines[1]["item"]["end_reason"], "quiescent");
        assert_eq!(lines[2]["item"]["provisional_reading"]["provisional"], true);
    }

    /// A field the page publishes that this binary predates reaches the
    /// reader anyway: the frame prints as it arrived rather than being parsed
    /// out and rebuilt.
    #[test]
    fn a_line_is_the_frame_the_server_sent() {
        let frame = r#"{"type":"watch_update","client_id":3,"seq":7,"item":{"kind":"aggregate","at_epoch_ms":1,"run_id":null,"reading":null,"counted":{},"sent":{},"ticks":[],"somethingNewer":42}}"#;
        assert_eq!(read_frame(None, frame), WatchFrame::Line(frame));
    }

    #[test]
    fn a_watch_follows_every_page_unless_it_was_told_which_one() {
        let frame = relayed(1, 9, aggregate());
        assert!(matches!(read_frame(None, &frame), WatchFrame::Line(_)));
        assert!(matches!(read_frame(Some(9), &frame), WatchFrame::Line(_)));
        assert_eq!(read_frame(Some(3), &frame), WatchFrame::Skip);
    }

    #[test]
    fn frames_that_are_not_the_stream_are_skipped_and_an_archived_workspace_is_not() {
        assert_eq!(
            read_frame(None, r#"{"type":"ack","seq":3}"#),
            WatchFrame::Skip
        );
        assert_eq!(read_frame(None, "not json at all"), WatchFrame::Skip);
        assert_eq!(
            read_frame(None, r#"{"type":"workspace_archived","workspace_id":"w1"}"#),
            WatchFrame::Archived
        );
    }
}
