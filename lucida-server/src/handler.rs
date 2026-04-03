use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ChunkMessage, ClientId, ClientMessage, ServerMessage};
use lucida_store::cache::CachedStore;
use object_store::path::Path;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::session::{Session, ServerStore};
use crate::{BroadcastItem, UnicastRoutes};

pub async fn handle_client(
    id: ClientId,
    ws: WebSocket,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
) {
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Per-client unicast channel for targeted messages (chunk routing).
    let (unicast_tx, mut unicast_rx) = mpsc::unbounded_channel::<Message>();
    unicast_routes.lock().await.insert(id, unicast_tx);

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
        unicast_routes.lock().await.remove(&id);
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
                                BroadcastItem::DatasetPresenceUpdate { sender, json } => {
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
                            // All commands in ClientMessage are DocumentCommands
                            // by construction — no runtime guard needed.
                            let seq = {
                                let mut sess = session.lock().await;
                                let seq = sess.apply(command.clone());
                                match &command {
                                    DocumentCommand::AddDataset {
                                        id: dataset_id, ..
                                    } => {
                                        sess.data_sources
                                            .insert(dataset_id.clone(), id);
                                    }
                                    DocumentCommand::RemoveDataset { id: dataset_id } => {
                                        sess.data_sources.remove(dataset_id);
                                    }
                                    DocumentCommand::SetVolumeScale { .. } => {}
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
                        ClientMessage::Steer { client } => {
                            let changes = {
                                let mut sess = session.lock().await;
                                sess.set_follow(client, Some(id))
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
                        ClientMessage::OpenRemoteDataset { url } => {
                            eprintln!("client {id}: opening remote dataset from {url}");
                            let session_clone = Arc::clone(&session);
                            let tx_clone = tx.clone();
                            let unicast_routes_clone = Arc::clone(&unicast_routes);
                            let url_clone = url.clone();
                            tokio::spawn(async move {
                                handle_open_remote_dataset(
                                    id, url_clone, session_clone, tx_clone, unicast_routes_clone,
                                ).await;
                            });
                        }
                        ClientMessage::DatasetPresence {
                            dataset_order,
                            dataset_settings,
                        } => {
                            {
                                let mut sess = session.lock().await;
                                sess.update_dataset_presence(
                                    id,
                                    dataset_order.clone(),
                                    dataset_settings.clone(),
                                );
                            }
                            let update = ServerMessage::DatasetPresenceUpdate {
                                client_id: id,
                                dataset_order,
                                dataset_settings,
                            };
                            let _ = tx.send(BroadcastItem::DatasetPresenceUpdate {
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
                        ChunkMessage::ChunkRequest { dataset_id, key, store_prefix } => {
                            // Check server-hosted first, then peer relay.
                            let server_entry = {
                                let sess = session.lock().await;
                                sess.server_stores.get(&dataset_id).cloned()
                            };
                            if let Some(entry) = server_entry {
                                // Server-hosted: read chunk from StorageBackend.
                                let unicast_routes_clone = Arc::clone(&unicast_routes);
                                let ds_id = dataset_id;
                                let chunk_key = key;
                                tokio::spawn(async move {
                                    serve_chunk_from_store(
                                        id, &ds_id, &chunk_key, store_prefix.as_deref(),
                                        &entry.store, &entry.axes, &unicast_routes_clone,
                                    ).await;
                                });
                            } else {
                                // Peer-hosted: relay to data source.
                                let source_id = {
                                    let sess = session.lock().await;
                                    sess.data_sources.get(&dataset_id).copied()
                                };
                                if let Some(source_id) = source_id {
                                    let fetch = ChunkMessage::ChunkFetch {
                                        client_id: id,
                                        dataset_id,
                                        key,
                                        store_prefix,
                                    };
                                    let fetch_json =
                                        serde_json::to_string(&fetch).unwrap();
                                    let senders = unicast_routes.lock().await;
                                    if let Some(sender) = senders.get(&source_id) {
                                        let _ = sender.send(Message::Text(
                                            fetch_json.into(),
                                        ));
                                    }
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

                let senders = unicast_routes.lock().await;
                if let Some(sender) = senders.get(&target_id) {
                    let _ = sender.send(Message::Binary(data));
                }
            }
            _ => {}
        }
    }

    // Cleanup on disconnect.
    outbound.abort();
    unicast_routes.lock().await.remove(&id);

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
}

/// Handle OpenRemoteDataset: open a StorageBackend, read metadata, broadcast AddDataset.
async fn handle_open_remote_dataset(
    client_id: ClientId,
    url: String,
    session: Arc<Mutex<Session>>,
    tx: broadcast::Sender<BroadcastItem>,
    unicast_routes: UnicastRoutes,
) {
    // Open storage backend.
    let store = match lucida_store::backend::open(&url) {
        Ok(s) => s,
        Err(e) => {
            send_open_failed(client_id, &url, &e.to_string(), &unicast_routes).await;
            return;
        }
    };

    // Extract dataset name from URL (last path component).
    let name = url
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or("dataset")
        .to_string();

    // Generate a dataset ID.
    let dataset_id = format!("srv-{:016x}", {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        url.hash(&mut h);
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .hash(&mut h);
        h.finish()
    });

    // Read metadata.
    let meta = match lucida_store::metadata::read_dataset_info(&store, &dataset_id, &name).await {
        Ok(m) => m,
        Err(e) => {
            send_open_failed(client_id, &url, &e.to_string(), &unicast_routes).await;
            return;
        }
    };

    // Extract axes from the parsed metadata.
    let axes_names = meta.axes_names.clone();

    // Build AddDataset command from the parsed metadata.
    let ds = &meta.dataset;
    let command = DocumentCommand::AddDataset {
        id: ds.id.clone(),
        name: ds.name.clone(),
        kind: ds.kind.clone(),
        layers: ds.layers.clone(),
        volume_shape: ds.volume_shape,
        volume_scale: ds.volume_transform.as_ref().map(|_| {
            // Reconstruct scale from client_metadata (stored there during parsing).
            if let Some(cm) = &ds.client_metadata {
                if let Some(levels) = cm.get("levels").and_then(|v| v.as_array()) {
                    if let Some(l0) = levels.first() {
                        if let Some(scale) = l0.get("scale").and_then(|v| v.as_array()) {
                            if scale.len() >= 5 {
                                return [
                                    scale[2].as_f64().unwrap_or(1.0),
                                    scale[3].as_f64().unwrap_or(1.0),
                                    scale[4].as_f64().unwrap_or(1.0),
                                ];
                            }
                        }
                    }
                }
            }
            [1.0, 1.0, 1.0]
        }),
        members: ds.members.clone(),
        client_metadata: ds.client_metadata.clone(),
    };

    // Wrap in a 512 MB LRU cache and register.
    let cached = Arc::new(CachedStore::new(store, 512 * 1024 * 1024));

    // Apply command and register server store with axes.
    let seq = {
        let mut sess = session.lock().await;
        let seq = sess.apply(command.clone());
        sess.server_stores.insert(
            dataset_id.clone(),
            ServerStore {
                store: cached,
                axes: axes_names,
            },
        );
        seq
    };

    // Broadcast to ALL clients including the requester.
    // Use u64::MAX as sender so no client matches — everyone gets the
    // CommandBroadcast (not an Ack), since the requester hasn't applied
    // the AddDataset locally.
    let broadcast_msg = ServerMessage::CommandBroadcast {
        seq,
        command,
    };

    let _ = tx.send(BroadcastItem::CommandBroadcast {
        sender: u64::MAX,
        broadcast_json: serde_json::to_string(&broadcast_msg).unwrap(),
        ack_json: String::new(), // unused — no client will match
    });

    eprintln!("server: opened remote dataset {dataset_id} from {url}");
}

/// Read a chunk from a StorageBackend and send it to the requesting client.
///
/// When `store_prefix` is `Some("A/1/0")`, the store path becomes
/// `A/1/0/{level_path}/c/{chunk_coords}` instead of just `{level_path}/c/{chunk_coords}`.
/// This enables plate FOV routing where each member's chunks live under a sub-path.
async fn serve_chunk_from_store(
    client_id: ClientId,
    dataset_id: &str,
    chunk_key: &str,
    store_prefix: Option<&str>,
    store: &Arc<CachedStore>,
    axes: &[String],
    unicast_routes: &UnicastRoutes,
) {
    let relative_path = lucida_store::chunk_key_to_store_path(chunk_key, axes);
    let file_path = match store_prefix {
        Some(prefix) => format!("{}/{}", prefix, relative_path),
        None => relative_path,
    };
    let obj_path = Path::from(file_path.as_str());

    let bytes = match store.get_bytes(&obj_path).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("server: failed to read chunk {chunk_key} for {dataset_id}: {e}");
            return;
        }
    };

    // Build binary response: [client_id: u32 LE][key_len: u16 LE][key][data]
    // The key sent back is "{dataset_id}[/{store_prefix}]/{chunk_key}" (composite key).
    let composite_key = match store_prefix {
        Some(prefix) => format!("{dataset_id}/{prefix}/{chunk_key}"),
        None => format!("{dataset_id}/{chunk_key}"),
    };
    let key_bytes = composite_key.as_bytes();
    let key_len = key_bytes.len() as u16;

    let mut buf = Vec::with_capacity(4 + 2 + key_bytes.len() + bytes.len());
    buf.extend_from_slice(&(client_id as u32).to_le_bytes());
    buf.extend_from_slice(&key_len.to_le_bytes());
    buf.extend_from_slice(key_bytes);
    buf.extend_from_slice(&bytes);

    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Binary(buf.into()));
    }
}

/// Send an OpenDatasetFailed message to the requesting client.
async fn send_open_failed(
    client_id: ClientId,
    url: &str,
    error: &str,
    unicast_routes: &UnicastRoutes,
) {
    eprintln!("server: failed to open {url}: {error}");
    let msg = ServerMessage::OpenDatasetFailed {
        url: url.to_string(),
        error: error.to_string(),
    };
    let json = serde_json::to_string(&msg).unwrap();
    let senders = unicast_routes.lock().await;
    if let Some(sender) = senders.get(&client_id) {
        let _ = sender.send(Message::Text(json.into()));
    }
}
