use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use lucida_content::{DatasetId, ImageId};
use lucida_core::command::DocumentCommand;
use lucida_core::protocol::{ChunkMessage, ClientId, ClientMessage, ServerMessage};
use lucida_protocol::RegisterDataset;
use lucida_store::cache::CachedStore;
use object_store::path::Path;
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::binding::{ChunkResolver, ServerBinding};
use crate::session::Session;
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
                                sess.apply(command.clone())
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
                        ChunkMessage::ChunkRequest { dataset_id, image_id, key } => {
                            // Look up the server binding for this dataset.
                            let binding = {
                                let sess = session.lock().await;
                                sess.server_bindings.get(&dataset_id).map(|b| {
                                    let compression = b.resolver.storage_compression(&image_id);
                                    (b.resolver.resolve(&image_id, &key), compression, b.cache.clone())
                                })
                            };
                            if let Some((resolved, compression, cache)) = binding {
                                let unicast_routes_clone = Arc::clone(&unicast_routes);
                                tokio::spawn(async move {
                                    serve_chunk_from_store(
                                        id, &dataset_id, &image_id, &key,
                                        resolved.as_deref(), compression, &cache,
                                        &unicast_routes_clone,
                                    ).await;
                                });
                            } else {
                                eprintln!("server: no binding for dataset {dataset_id} (chunk {key} dropped)");
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

/// Handle OpenRemoteDataset: open a StorageBackend, import dataset, broadcast RegisterDataset.
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

    // Import dataset via the new pipeline.
    tracing::info!(url = %url, id = %dataset_id, name = %name, "importing dataset");
    let result = match lucida_store::import::import_dataset(&store, &dataset_id, &name).await {
        Ok(r) => r,
        Err(e) => {
            send_open_failed(client_id, &url, &e.to_string(), &unicast_routes).await;
            return;
        }
    };

    // Log import result summary.
    let n_entities = result.content.entities().len();
    let n_images = result.content.images().len();
    let n_levels = result.content.images().first().map(|i| i.multiscale.levels.len()).unwrap_or(0);
    tracing::info!(
        id = %dataset_id,
        kind = ?result.content.kind,
        entities = n_entities,
        images = n_images,
        levels = n_levels,
        binding_images = result.binding_seed.images.len(),
        "import complete"
    );

    // Build operational binding.
    let cached = Arc::new(CachedStore::new(store.clone(), 512 * 1024 * 1024));
    let resolver = ChunkResolver::new(&result.binding_seed);
    let binding = ServerBinding {
        source_url: url.clone(),
        store: store.clone(),
        resolver,
        cache: cached,
    };

    // Build RegisterDataset command (content + fetch, no server-private state).
    let command = DocumentCommand::RegisterDataset(RegisterDataset {
        content: result.content,
        fetch: result.fetch,
    });

    let dataset_id_key = DatasetId(dataset_id.clone());

    // Apply command and register server binding.
    let seq = {
        let mut sess = session.lock().await;
        let seq = sess.apply(command.clone());
        sess.server_bindings.insert(dataset_id_key, binding);
        seq
    };

    // Broadcast to ALL clients including the requester.
    // Use u64::MAX as sender so no client matches — everyone gets the
    // CommandBroadcast (not an Ack), since the requester hasn't applied
    // the RegisterDataset locally.
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

/// Read a chunk from a CachedStore and send it to the requesting client.
///
/// `object_path` is the pre-resolved object store path from the ChunkResolver.
/// If `None`, the image_id was unknown and the request is rejected.
async fn serve_chunk_from_store(
    client_id: ClientId,
    dataset_id: &DatasetId,
    image_id: &ImageId,
    chunk_key: &str,
    object_path: Option<&str>,
    storage_compression: crate::binding::StorageCompression,
    cache: &Arc<CachedStore>,
    unicast_routes: &UnicastRoutes,
) {
    let object_path = match object_path {
        Some(p) => p,
        None => {
            eprintln!(
                "server: unknown image_id {image_id} for dataset {dataset_id}, key {chunk_key}"
            );
            return;
        }
    };

    tracing::trace!(dataset = %dataset_id, image = %image_id, key = chunk_key, path = object_path, "serving chunk");
    let obj_path = Path::from(object_path);
    let storage_bytes = match cache.get_bytes(&obj_path).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("server: failed to read chunk {chunk_key} for {dataset_id}: {e}");
            return;
        }
    };

    // Decode storage compression → raw bytes (WireFormat::Raw for phase 1).
    let bytes: Vec<u8> = match storage_compression {
        crate::binding::StorageCompression::Lz4 => {
            match lz4_flex::decompress_size_prepended(&storage_bytes) {
                Ok(raw) => {
                    tracing::debug!(
                        key = chunk_key,
                        compressed = storage_bytes.len(),
                        decompressed = raw.len(),
                        "lz4 decoded"
                    );
                    raw
                }
                Err(e) => {
                    eprintln!("server: lz4 decompress failed for {chunk_key}: {e}");
                    return;
                }
            }
        }
        crate::binding::StorageCompression::Zstd => {
            match zstd::stream::decode_all(std::io::Cursor::new(&storage_bytes)) {
                Ok(raw) => {
                    tracing::debug!(
                        key = chunk_key,
                        compressed = storage_bytes.len(),
                        decompressed = raw.len(),
                        "zstd decoded"
                    );
                    raw
                }
                Err(e) => {
                    eprintln!("server: zstd decompression failed for {chunk_key}: {e}");
                    return;
                }
            }
        }
        crate::binding::StorageCompression::None => storage_bytes.to_vec(),
    };

    // Build binary response: [client_id: u32 LE][key_len: u16 LE][key][data]
    // The composite key is "{dataset_id}/{image_id}/{chunk_key}".
    let composite_key = format!("{dataset_id}/{image_id}/{chunk_key}");
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
