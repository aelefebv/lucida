use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use lucida_core::command::Command;
use lucida_core::scene::Scene;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

type ClientId = u64;

#[derive(Clone)]
struct TaggedMessage {
    sender: ClientId,
    json: String,
}

#[tokio::main]
async fn main() {
    let scene = Arc::new(Mutex::new(Scene::new([800, 600])));
    let (tx, _) = broadcast::channel::<TaggedMessage>(256);
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

        let scene = Arc::clone(&scene);
        let tx = tx.clone();
        let mut rx = tx.subscribe();

        tokio::spawn(async move {
            let (mut ws_tx, mut ws_rx) = ws.split();

            // Outbound: forward broadcast messages to this client (skip own messages)
            let outbound = tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(msg) if msg.sender != id => {
                            if ws_tx.send(Message::Text(msg.json.into())).await.is_err() {
                                break;
                            }
                        }
                        Ok(_) => {} // skip own messages
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("client {id} lagged by {n} messages");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // Inbound: parse commands, apply to scene, rebroadcast
            while let Some(Ok(msg)) = ws_rx.next().await {
                if let Message::Text(text) = msg {
                    let json = text.to_string();
                    match serde_json::from_str::<Command>(&json) {
                        Ok(cmd) => {
                            scene.lock().await.apply(cmd);
                            let _ = tx.send(TaggedMessage { sender: id, json });
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
