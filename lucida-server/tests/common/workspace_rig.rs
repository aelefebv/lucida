//! A real workspace socket on an ephemeral port: one workspace, served by
//! the workspace router `main.rs` mounts, with its owner's principal on
//! every request where the auth middleware would put one.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Extension;
use lucida_core::auth_principal::AuthPrincipal;
use lucida_server::GeneratedConfig;
use lucida_server::dataset_open::WorkspaceScope;
use lucida_server::storage::{self, DatabaseUrl};
use lucida_server::workspace::{LiveWorkspace, WorkspaceManager, WorkspaceRuntimeConfig};

pub struct WorkspaceRig {
    pub addr: SocketAddr,
    pub workspace_id: String,
    pub manager: Arc<WorkspaceManager>,
    /// The workspace the socket serves, already live, so a test can reach
    /// its session and broadcast hub directly.
    pub live: Arc<LiveWorkspace>,
    server: tokio::task::JoinHandle<()>,
}

impl WorkspaceRig {
    pub async fn start(generated_config: GeneratedConfig) -> Self {
        Self::start_with(generated_config, WorkspaceRuntimeConfig::default()).await
    }

    pub async fn start_with(
        generated_config: GeneratedConfig,
        runtime: WorkspaceRuntimeConfig,
    ) -> Self {
        let storage = storage::open(&DatabaseUrl::in_memory()).await.unwrap();
        let workspace = storage
            .workspaces()
            .create_workspace(&owner(), Some("Rig"))
            .await
            .unwrap();
        let manager = Arc::new(WorkspaceManager::new_with_runtime_config(
            storage.workspaces(),
            generated_config,
            runtime,
        ));
        let live = manager
            .live_workspace(&workspace.id, &owner())
            .await
            .unwrap();
        let app = lucida_server::workspace::router(Arc::clone(&manager)).layer(Extension(owner()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });
        Self {
            addr,
            workspace_id: workspace.id,
            manager,
            live,
            server,
        }
    }

    pub fn ws_url(&self) -> String {
        format!(
            "ws://{}/ws/workspaces/{}",
            self.addr,
            urlencoding::encode(&self.workspace_id)
        )
    }

    /// The scope a dataset open runs under, as the owner's socket would.
    pub fn scope(&self) -> WorkspaceScope {
        WorkspaceScope {
            live: Arc::clone(&self.live),
            manager: Arc::clone(&self.manager),
            principal: owner(),
        }
    }
}

impl Drop for WorkspaceRig {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub fn owner() -> AuthPrincipal {
    AuthPrincipal {
        email: "owner@example.com".into(),
        display_name: "Owner".into(),
        picture_url: None,
        is_admin: false,
    }
}
