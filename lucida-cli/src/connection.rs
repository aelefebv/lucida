use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use lucida_core::camera::Camera;
use lucida_core::protocol::{ClientId, ClientMessage, PresenceState, ServerMessage};
use lucida_core::scene::{DisplayState, DocumentState};
use lucida_core::view::ViewState;

pub struct Snapshot {
    pub seq: u64,
    pub document: DocumentState,
    pub peers: Vec<PresenceState>,
    pub your_id: ClientId,
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
