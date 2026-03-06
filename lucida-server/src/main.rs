mod session;

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use lucida_core::command::Command;
use lucida_core::protocol::ServerMessage;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use session::Session;

type ClientId = u64;

#[derive(Clone)]
struct BroadcastItem {
    sender: ClientId,
    broadcast_json: String,
    ack_json: String,
}

#[tokio::main]
async fn main() {
    let session = Arc::new(Mutex::new(Session::new([800, 600])));
    let (tx, _) = broadcast::channel::<BroadcastItem>(256);
    let next_id = Arc::new(std::sync::atomic::AtomicU64::new(0));

    let listener = TcpListener::bind("0.0.0.0:9876")
        .await
        .expect("failed to bind to port 9876");
    eprintln!("lucida-server listening on ws://0.0.0.0:9876");

    loop {
        let (stream, addr) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };

        let ws = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("websocket handshake error from {addr}: {e}");
                continue;
            }
        };

        let id = next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!("client {id} connected from {addr}");

        let session = Arc::clone(&session);
        let tx = tx.clone();

        tokio::spawn(async move {
            let (mut ws_tx, mut ws_rx) = ws.split();

            // Lock session, subscribe (before unlock — no gap), snapshot, unlock.
            let (snapshot_json, mut rx) = {
                let sess = session.lock().await;
                let rx = tx.subscribe();
                let snapshot = sess.snapshot();
                let json = serde_json::to_string(&snapshot).unwrap();
                (json, rx)
            };

            // Send snapshot as first message.
            if ws_tx
                .send(Message::Text(snapshot_json.into()))
                .await
                .is_err()
            {
                eprintln!("client {id}: failed to send snapshot");
                return;
            }

            // Outbound: forward broadcast messages to this client.
            let outbound = tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(item) => {
                            let json = if item.sender == id {
                                &item.ack_json
                            } else {
                                &item.broadcast_json
                            };
                            if ws_tx
                                .send(Message::Text(json.clone().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("client {id} lagged by {n} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // Inbound: parse commands, apply to session, broadcast.
            while let Some(Ok(msg)) = ws_rx.next().await {
                if let Message::Text(text) = msg {
                    let json = text.to_string();
                    match serde_json::from_str::<Command>(&json) {
                        Ok(cmd) => {
                            let seq = session.lock().await.apply(cmd.clone());

                            let broadcast_msg = ServerMessage::CommandBroadcast {
                                seq,
                                command: cmd,
                            };
                            let ack_msg = ServerMessage::Ack { seq };

                            let _ = tx.send(BroadcastItem {
                                sender: id,
                                broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
                                ack_json: serde_json::to_string(&ack_msg).unwrap(),
                            });
                        }
                        Err(e) => {
                            eprintln!("client {id}: bad command: {e}");
                        }
                    }
                }
            }

            outbound.abort();
            eprintln!("client {id} disconnected");
        });
    }
}
