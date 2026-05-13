mod connection;

use clap::{Parser, Subcommand};

use lucida_core::camera::Camera;
use lucida_core::command::ViewportCommand;
use lucida_core::protocol::ClientId;
use lucida_core::scene::Scene;

#[derive(Parser)]
#[command(name = "lucida-cli", about = "CLI client for lucida-server")]
struct Cli {
    /// Server WebSocket URL
    #[arg(long, default_value = "ws://localhost:9876/ws", global = true)]
    server: String,

    /// Start from a peer's viewport instead of defaults
    #[arg(long, global = true)]
    peer: Option<ClientId>,

    /// Steer a client (make it follow the CLI) before sending viewport commands
    #[arg(long, global = true)]
    steer: Option<ClientId>,

    #[command(subcommand)]
    command: Sub,
}

#[derive(Subcommand)]
enum Sub {
    /// Print document state and peers as JSON
    State,
    /// Print chunk plan for the current viewport
    VisibleChunks,
    /// Pan the viewport
    Pan {
        #[arg(long, default_value_t = 0.0)]
        dx: f64,
        #[arg(long, default_value_t = 0.0)]
        dy: f64,
    },
    /// Zoom by a factor
    Zoom {
        #[arg(long)]
        factor: f64,
    },
    /// Set z/t/c slice
    Slice {
        #[arg(long)]
        axis: String,
        #[arg(long)]
        index: u32,
    },
    /// Set contrast window
    Contrast {
        #[arg(long)]
        min: f64,
        #[arg(long)]
        max: f64,
    },
    /// Set gamma
    Gamma {
        #[arg(long)]
        gamma: f64,
    },
    /// Set camera center
    Center {
        #[arg(long)]
        x: f64,
        #[arg(long)]
        y: f64,
    },
    /// Set absolute zoom level
    SetZoom {
        #[arg(long)]
        value: f64,
    },
    /// Rotate the 3D camera
    Rotate {
        /// Horizontal rotation in degrees
        #[arg(long, default_value_t = 0.0)]
        theta: f64,
        /// Vertical rotation in degrees
        #[arg(long, default_value_t = 0.0)]
        phi: f64,
        /// Interpret angles as radians instead of degrees
        #[arg(long, default_value_t = false)]
        radians: bool,
    },
    /// Switch to 2D mode
    #[command(name = "set-mode-2d")]
    SetMode2d,
    /// Switch to 3D mode
    #[command(name = "set-mode-3d")]
    SetMode3d,
    /// Make a client follow the CLI (standalone steer)
    Steer {
        #[arg(long)]
        client: ClientId,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let (mut sink, _stream, snapshot) = connection::connect(&cli.server).await?;

    // If --steer is set, send a steer message first.
    if let Some(steer_client) = cli.steer {
        connection::send_steer(&mut sink, steer_client).await?;
    }

    match cli.command {
        Sub::State => {
            let out = serde_json::json!({
                "seq": snapshot.seq,
                "document": snapshot.document,
                "peers": snapshot.peers,
                "your_id": snapshot.your_id,
            });
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        Sub::VisibleChunks => {
            let scene = build_scene(&snapshot, cli.peer);
            let plan = scene.chunk_plan();
            println!("{}", serde_json::to_string_pretty(&plan)?);
        }
        Sub::Steer { client } => {
            connection::send_steer(&mut sink, client).await?;
        }
        cmd => {
            let mut scene = build_scene(&snapshot, cli.peer);
            let command = match cmd {
                Sub::Pan { dx, dy } => ViewportCommand::Pan { dx, dy },
                Sub::Zoom { factor } => match scene.camera {
                    Camera::Slice(_) => ViewportCommand::ZoomBy { factor },
                    Camera::Arcball(_) | Camera::Fly(_) => ViewportCommand::Zoom3D { delta: 1.0 / factor - 1.0 },
                },
                Sub::Slice { axis, index } => match axis.as_str() {
                    "z" => ViewportCommand::SetZ { z: index },
                    "t" => ViewportCommand::SetT { t: index },
                    "c" => ViewportCommand::SetC { c: index },
                    _ => return Err(format!("unknown axis: {axis}").into()),
                },
                Sub::Contrast { min, max } => ViewportCommand::SetContrast { min, max },
                Sub::Gamma { gamma } => ViewportCommand::SetGamma { gamma },
                Sub::Center { x, y } => ViewportCommand::SetCenter { x, y },
                Sub::SetZoom { value } => match scene.camera {
                    Camera::Slice(_) => ViewportCommand::SetZoom { value },
                    Camera::Arcball(_) | Camera::Fly(_) => return Err("set-zoom is only supported in 2D mode".into()),
                },
                Sub::Rotate { theta, phi, radians } => {
                    let (t, p) = if radians {
                        (theta, phi)
                    } else {
                        (theta.to_radians(), phi.to_radians())
                    };
                    ViewportCommand::Rotate3D { d_theta: t, d_phi: p }
                }
                Sub::SetMode2d => ViewportCommand::SetMode2D,
                Sub::SetMode3d => ViewportCommand::SetMode3D,
                Sub::State | Sub::VisibleChunks | Sub::Steer { .. } => unreachable!(),
            };

            scene.apply(command.into());
            connection::send_presence(&mut sink, &scene.camera, &scene.view, &scene.display)
                .await?;
        }
    }

    Ok(())
}

/// Reconstruct a Scene from the snapshot, optionally starting from a peer's viewport.
fn build_scene(snapshot: &connection::Snapshot, peer_id: Option<ClientId>) -> Scene {
    let mut scene = Scene::new([800, 600]);
    // Restore document state
    scene.document = snapshot.document.clone();
    // Rebuild derived state (not serialized, so must be reconstructed)
    scene.rebuild_derived();

    // If --peer was specified, adopt that peer's viewport
    if let Some(pid) = peer_id {
        if let Some(peer) = snapshot.peers.iter().find(|p| p.client_id == pid) {
            scene.camera = peer.camera.clone();
            scene.view = peer.view.clone();
            scene.display = peer.display.clone();
            scene.dataset_order = peer.dataset_order.clone();
            scene.dataset_settings = peer.dataset_settings.clone();
            return scene;
        }
        eprintln!("warning: peer {pid} not found, using defaults");
    }

    // Use defaults — if any peer exists, adopt the first peer's viewport
    if let Some(peer) = snapshot.peers.first() {
        scene.camera = peer.camera.clone();
        scene.view = peer.view.clone();
        scene.display = peer.display.clone();
        scene.dataset_order = peer.dataset_order.clone();
        scene.dataset_settings = peer.dataset_settings.clone();
    }

    scene
}
