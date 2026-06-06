use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use lucida_core::camera::Camera;
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ClientId, ClientMessage, PresenceState, ServerMessage};
use lucida_core::scene::{DisplayState, DocumentState};
use lucida_core::view::ViewState;

pub struct Snapshot {
    pub seq: u64,
    pub document: DocumentState,
    pub peers: Vec<PresenceState>,
    pub your_id: ClientId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenDatasetOutcome {
    pub seq: u64,
    pub dataset_id: String,
    pub name: String,
    pub image_count: usize,
    pub entity_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenDatasetFailure {
    pub url: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OpenDatasetEvent {
    Opened(OpenDatasetOutcome),
    Failed(OpenDatasetFailure),
    Ignore,
}

type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// Connect to the server and receive the initial Snapshot.
pub async fn connect(
    url: &str,
) -> Result<(WsSink, WsStream, Snapshot), Box<dyn std::error::Error>> {
    let (ws, _) = connect_async(url).await?;
    let (sink, mut stream) = ws.split();

    // First message must be a Snapshot.
    let msg = stream
        .next()
        .await
        .ok_or("server closed before sending snapshot")??;

    let text = msg
        .into_text()
        .map_err(|_| "expected text message for snapshot")?;

    let server_msg: ServerMessage = serde_json::from_str(&text)?;
    match server_msg {
        ServerMessage::Snapshot {
            seq,
            document,
            peers,
            your_id,
            ..
        } => Ok((
            sink,
            stream,
            Snapshot {
                seq,
                document,
                peers,
                your_id,
            },
        )),
        _ => Err("first message was not a snapshot".into()),
    }
}

/// Send a steer message to make another client follow the sender.
pub async fn send_steer(
    sink: &mut WsSink,
    client: ClientId,
) -> Result<(), Box<dyn std::error::Error>> {
    let msg = ClientMessage::Steer { client };
    let json = serde_json::to_string(&msg)?;
    sink.send(Message::Text(json.into())).await?;
    Ok(())
}

/// Ask the server to open a dataset URL/path.
pub async fn send_open_remote_dataset(
    sink: &mut WsSink,
    url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let msg = ClientMessage::OpenRemoteDataset {
        url: url.to_string(),
    };
    let json = serde_json::to_string(&msg)?;
    sink.send(Message::Text(json.into())).await?;
    Ok(())
}

/// Wait until the server reports that an open request succeeded or failed.
pub async fn wait_for_open_dataset(
    stream: &mut WsStream,
    timeout: std::time::Duration,
) -> Result<OpenDatasetOutcome, Box<dyn std::error::Error>> {
    let wait = async {
        loop {
            let msg = stream
                .next()
                .await
                .ok_or("server closed before dataset open completed")??;

            match msg {
                Message::Text(text) => match classify_open_dataset_message(&text)? {
                    OpenDatasetEvent::Opened(outcome) => return Ok(outcome),
                    OpenDatasetEvent::Failed(failure) => {
                        return Err(
                            format!("failed to open {}: {}", failure.url, failure.error).into()
                        );
                    }
                    OpenDatasetEvent::Ignore => {}
                },
                Message::Close(_) => {
                    return Err("server closed before dataset open completed".into());
                }
                _ => {}
            }
        }
    };

    match tokio::time::timeout(timeout, wait).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "timed out after {}s waiting for dataset open",
            timeout.as_secs()
        )
        .into()),
    }
}

/// Send a presence update to the server.
pub async fn send_presence(
    sink: &mut WsSink,
    camera: &Camera,
    view: &ViewState,
    display: &DisplayState,
) -> Result<(), Box<dyn std::error::Error>> {
    let msg = ClientMessage::Presence {
        camera: camera.clone(),
        view: view.clone(),
        display: display.clone(),
    };
    let json = serde_json::to_string(&msg)?;
    sink.send(Message::Text(json.into())).await?;
    Ok(())
}

fn classify_open_dataset_message(text: &str) -> Result<OpenDatasetEvent, serde_json::Error> {
    let server_msg: ServerMessage = serde_json::from_str(text)?;
    Ok(match server_msg {
        ServerMessage::CommandBroadcast {
            seq,
            command: DocumentCommand::DatasetOpened(opened),
        } => {
            let image_count = opened.manifest.images().len();
            let entity_count = opened.manifest.entities().len();
            OpenDatasetEvent::Opened(OpenDatasetOutcome {
                seq,
                dataset_id: opened.manifest.dataset_id.0,
                name: opened.manifest.name,
                image_count,
                entity_count,
            })
        }
        ServerMessage::OpenDatasetFailed { url, error } => {
            OpenDatasetEvent::Failed(OpenDatasetFailure { url, error })
        }
        _ => OpenDatasetEvent::Ignore,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use lucida_content::{DatasetId, DatasetKind, DatasetManifest};
    use lucida_core::command::DocumentCommand;
    use lucida_core::protocol::ServerMessage;
    use lucida_protocol::{AssetCatalog, DatasetOpened, FetchSource, ProxiedFetchDescriptor};

    fn make_dataset_opened() -> DatasetOpened {
        DatasetOpened {
            manifest: DatasetManifest::new(
                DatasetId("ds-test".into()),
                "test dataset".into(),
                DatasetKind::Single,
                vec![],
                vec![],
                vec![],
                vec![],
                None,
            ),
            fetch: FetchSource::Proxied(ProxiedFetchDescriptor { images: vec![] }),
            catalog: AssetCatalog { entries: vec![] },
        }
    }

    #[test]
    fn command_broadcast_dataset_opened_is_success() {
        let msg = ServerMessage::CommandBroadcast {
            seq: 7,
            command: DocumentCommand::DatasetOpened(make_dataset_opened()),
        };
        let json = serde_json::to_string(&msg).unwrap();

        let event = classify_open_dataset_message(&json).unwrap();

        assert_eq!(
            event,
            OpenDatasetEvent::Opened(OpenDatasetOutcome {
                seq: 7,
                dataset_id: "ds-test".into(),
                name: "test dataset".into(),
                image_count: 0,
                entity_count: 0,
            })
        );
    }

    #[test]
    fn open_dataset_failed_is_failure() {
        let msg = ServerMessage::OpenDatasetFailed {
            url: "/tmp/nope.zarr".into(),
            error: "not found".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();

        let event = classify_open_dataset_message(&json).unwrap();

        assert_eq!(
            event,
            OpenDatasetEvent::Failed(OpenDatasetFailure {
                url: "/tmp/nope.zarr".into(),
                error: "not found".into(),
            })
        );
    }

    #[test]
    fn unrelated_server_message_is_ignored() {
        let msg = ServerMessage::Ack { seq: 3 };
        let json = serde_json::to_string(&msg).unwrap();

        let event = classify_open_dataset_message(&json).unwrap();

        assert_eq!(event, OpenDatasetEvent::Ignore);
    }
}
