mod session;

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use lucida_core::command::Command;
use lucida_core::protocol::{ChunkMessage, ClientId, ClientMessage, ServerMessage};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use session::Session;

#[derive(Clone)]
enum BroadcastItem {
    /// Document command broadcast (sequenced).
    CommandBroadcast {
        sender: ClientId,
        broadcast_json: String,
        ack_json: String,
    },
    /// Presence update from a client (ephemeral).
    PresenceUpdate {
        sender: ClientId,
        json: String,
    },
    /// Cursor update from a client.
    CursorUpdate {
        sender: ClientId,
        json: String,
    },
    /// Peer joined.
    PeerJoined {
        sender: ClientId,
        json: String,
    },
    /// Peer left.
    PeerLeft {
        json: String,
    },
    /// Follow changed.
    FollowChanged {
        json: String,
    },
    /// Layer presence update from a client.
    LayerPresenceUpdate {
        sender: ClientId,
        json: String,
    },
}

/// Per-client targeted message channels for unicast (chunk routing).
type ClientSenders = Arc<Mutex<HashMap<ClientId, mpsc::UnboundedSender<Message>>>>;

#[tokio::main]
async fn main() {
    let session = Arc::new(Mutex::new(Session::new()));
    let (tx, _) = broadcast::channel::<BroadcastItem>(256);
    let next_id = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let clients: ClientSenders = Arc::new(Mutex::new(HashMap::new()));

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
        let clients = Arc::clone(&clients);

        tokio::spawn(async move {
            let (mut ws_tx, mut ws_rx) = ws.split();

            // Per-client unicast channel for targeted messages (chunk routing).
            let (unicast_tx, mut unicast_rx) = mpsc::unbounded_channel::<Message>();
            clients.lock().await.insert(id, unicast_tx);

            // Lock session, subscribe (before unlock — no gap), add client, snapshot, unlock.
            let (snapshot_json, mut rx, peer_joined_json) = {
                let mut sess = session.lock().await;
                let rx = tx.subscribe();
                let presence = sess.add_client(id);
                let snapshot = sess.snapshot(id);
                let snapshot_json = serde_json::to_string(&snapshot).unwrap();
                let peer_joined = ServerMessage::PeerJoined {
                    client_id: id,
                    presence,
                };
                let peer_joined_json = serde_json::to_string(&peer_joined).unwrap();
                (snapshot_json, rx, peer_joined_json)
            };

            // Send snapshot as first message.
            if ws_tx
                .send(Message::Text(snapshot_json.into()))
                .await
                .is_err()
            {
                eprintln!("client {id}: failed to send snapshot");
                let mut sess = session.lock().await;
                sess.remove_client(id);
                clients.lock().await.remove(&id);
                return;
            }

            // Broadcast PeerJoined to others.
            let _ = tx.send(BroadcastItem::PeerJoined {
                sender: id,
                json: peer_joined_json,
            });

            // Outbound: forward broadcast + unicast messages to this client.
            let outbound = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        result = rx.recv() => {
                            match result {
                                Ok(item) => {
                                    let json = match &item {
                                        BroadcastItem::CommandBroadcast { sender, broadcast_json, ack_json } => {
                                            if *sender == id {
                                                ack_json
                                            } else {
                                                broadcast_json
                                            }
                                        }
                                        BroadcastItem::PresenceUpdate { sender, json } => {
                                            if *sender == id { continue; }
                                            json
                                        }
                                        BroadcastItem::CursorUpdate { sender, json } => {
                                            if *sender == id { continue; }
                                            json
                                        }
                                        BroadcastItem::PeerJoined { sender, json } => {
                                            if *sender == id { continue; }
                                            json
                                        }
                                        BroadcastItem::PeerLeft { json } => json,
                                        BroadcastItem::FollowChanged { json } => json,
                                        BroadcastItem::LayerPresenceUpdate { sender, json } => {
                                            if *sender == id { continue; }
                                            json
                                        }
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
                        msg = unicast_rx.recv() => {
                            match msg {
                                Some(msg) => {
                                    if ws_tx.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                                None => break,
                            }
                        }
                    }
                }
            });

            // Inbound: parse client messages, apply/route.
            while let Some(Ok(msg)) = ws_rx.next().await {
                match msg {
                    Message::Text(text) => {
                        let json = text.to_string();

                        // Try as ClientMessage (new protocol).
                        if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&json) {
                            match client_msg {
                                ClientMessage::Command { command } => {
                                    if command.is_document_command() {
                                        // Document command — apply and broadcast.
                                        let seq = {
                                            let mut sess = session.lock().await;
                                            let seq = sess.apply(command.clone());
                                            match &command {
                                                Command::AddDataset {
                                                    id: dataset_id, ..
                                                } => {
                                                    sess.data_sources
                                                        .insert(dataset_id.clone(), id);
                                                }
                                                Command::RemoveDataset { id: dataset_id } => {
                                                    sess.data_sources.remove(dataset_id);
                                                }
                                                _ => {}
                                            }
                                            seq
                                        };

                                        let broadcast_msg = ServerMessage::CommandBroadcast {
                                            seq,
                                            command,
                                        };
                                        let ack_msg = ServerMessage::Ack { seq };

                                        let _ = tx.send(BroadcastItem::CommandBroadcast {
                                            sender: id,
                                            broadcast_json: serde_json::to_string(&broadcast_msg)
                                                .unwrap(),
                                            ack_json: serde_json::to_string(&ack_msg).unwrap(),
                                        });
                                    }
                                }
                                ClientMessage::Presence {
                                    camera,
                                    view,
                                    display,
                                } => {
                                    {
                                        let mut sess = session.lock().await;
                                        sess.update_presence(
                                            id,
                                            camera.clone(),
                                            view.clone(),
                                            display.clone(),
                                        );
                                    }
                                    let update = ServerMessage::PresenceUpdate {
                                        client_id: id,
                                        camera,
                                        view,
                                        display,
                                    };
                                    let _ = tx.send(BroadcastItem::PresenceUpdate {
                                        sender: id,
                                        json: serde_json::to_string(&update).unwrap(),
                                    });
                                }
                                ClientMessage::Cursor { position } => {
                                    {
                                        let mut sess = session.lock().await;
                                        sess.update_cursor(id, position);
                                    }
                                    let update = ServerMessage::CursorUpdate {
                                        client_id: id,
                                        position,
                                    };
                                    let _ = tx.send(BroadcastItem::CursorUpdate {
                                        sender: id,
                                        json: serde_json::to_string(&update).unwrap(),
                                    });
                                }
                                ClientMessage::Follow { target } => {
                                    let changes = {
                                        let mut sess = session.lock().await;
                                        sess.set_follow(id, target)
                                    };
                                    for (cid, new_target) in changes {
                                        let msg = ServerMessage::FollowChanged {
                                            client_id: cid,
                                            target: new_target,
                                        };
                                        let _ = tx.send(BroadcastItem::FollowChanged {
                                            json: serde_json::to_string(&msg).unwrap(),
                                        });
                                    }
                                }
                                ClientMessage::LayerPresence {
                                    layer_order,
                                    layer_settings,
                                } => {
                                    {
                                        let mut sess = session.lock().await;
                                        sess.update_layer_presence(
                                            id,
                                            layer_order.clone(),
                                            layer_settings.clone(),
                                        );
                                    }
                                    let update = ServerMessage::LayerPresenceUpdate {
                                        client_id: id,
                                        layer_order,
                                        layer_settings,
                                    };
                                    let _ = tx.send(BroadcastItem::LayerPresenceUpdate {
                                        sender: id,
                                        json: serde_json::to_string(&update).unwrap(),
                                    });
                                }
                            }
                            continue;
                        }

                        // Try as ChunkMessage.
                        if let Ok(chunk_msg) = serde_json::from_str::<ChunkMessage>(&json) {
                            match chunk_msg {
                                ChunkMessage::ChunkRequest { dataset_id, key } => {
                                    let source_id = {
                                        let sess = session.lock().await;
                                        sess.data_sources.get(&dataset_id).copied()
                                    };
                                    if let Some(source_id) = source_id {
                                        let fetch = ChunkMessage::ChunkFetch {
                                            client_id: id,
                                            dataset_id,
                                            key,
                                        };
                                        let fetch_json =
                                            serde_json::to_string(&fetch).unwrap();
                                        let senders = clients.lock().await;
                                        if let Some(sender) = senders.get(&source_id) {
                                            let _ = sender.send(Message::Text(
                                                fetch_json.into(),
                                            ));
                                        }
                                    }
                                }
                                ChunkMessage::ChunkFetch { .. } => {
                                    // Clients should not send ChunkFetch — ignore.
                                }
                            }
                            continue;
                        }

                        eprintln!("client {id}: unrecognized message");
                    }
                    Message::Binary(data) => {
                        // Binary chunk data: [client_id: u32 LE][key_len: u16 LE][key][data]
                        if data.len() < 6 {
                            continue;
                        }
                        let target_id = u32::from_le_bytes([
                            data[0], data[1], data[2], data[3],
                        ]) as u64;

                        let senders = clients.lock().await;
                        if let Some(sender) = senders.get(&target_id) {
                            let _ = sender.send(Message::Binary(data));
                        }
                    }
                    _ => {}
                }
            }

            // Cleanup on disconnect.
            outbound.abort();
            clients.lock().await.remove(&id);

            // Remove client from session, get affected followers.
            let (affected_followers, peer_left_json) = {
                let mut sess = session.lock().await;
                let affected = sess.remove_client(id);
                sess.data_sources.retain(|_, &mut src| src != id);
                let peer_left = ServerMessage::PeerLeft { client_id: id };
                let json = serde_json::to_string(&peer_left).unwrap();
                (affected, json)
            };

            // Broadcast PeerLeft.
            let _ = tx.send(BroadcastItem::PeerLeft {
                json: peer_left_json,
            });

            // Broadcast FollowChanged for any followers that were redirected.
            for follower_id in affected_followers {
                let msg = ServerMessage::FollowChanged {
                    client_id: follower_id,
                    target: None,
                };
                let _ = tx.send(BroadcastItem::FollowChanged {
                    json: serde_json::to_string(&msg).unwrap(),
                });
            }

            eprintln!("client {id} disconnected");
        });
    }
}
