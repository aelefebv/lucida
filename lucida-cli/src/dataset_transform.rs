//! `lucida dataset transform`: read where a dataset was placed by hand, or
//! place it, as the viewer's Move and scale tool does. The transform is
//! shared workspace state, so every viewer of the workspace sees the move.

use std::time::Duration;

use futures_util::{Stream, StreamExt};
use lucida_core::DatasetId;
use lucida_core::command::DocumentCommand;
use lucida_core::placement::UserTransform;
use lucida_core::protocol::{ClientMessage, ServerMessage};
use serde::Serialize;

use crate::config::EffectiveServer;
use crate::credentials::EffectiveToken;
use crate::dataset::{DatasetSummary, dataset_summaries_from_document, resolve_dataset_summary};
use crate::error::{CliError, ErrorKind};
use crate::session::{
    IncomingSessionMessage, SessionWait, connect_workspace_socket, incoming_messages,
    observe_until, send_client_message, wait_for_workspace_snapshot,
};
use crate::workspace::{WorkspaceRecord, WorkspaceRole, WorkspaceTarget};

/// What a `dataset transform` call asks to change. Nothing named keeps the
/// transform as it is.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TransformChange {
    /// `[x, y, z]` in the dataset's own declared units.
    pub offset: Option<[f64; 3]>,
    /// `[x, y, z]` multipliers on the dataset's declared sample size.
    pub scale: Option<[f64; 3]>,
    /// Put the dataset back where its metadata places it, before the rest.
    pub reset: bool,
}

impl TransformChange {
    pub fn is_empty(&self) -> bool {
        self.offset.is_none() && self.scale.is_none() && !self.reset
    }

    /// `current` with this change made. Refused when the result is a
    /// transform no viewer can place a dataset by.
    pub fn applied_to(&self, current: UserTransform) -> Result<UserTransform, CliError> {
        let mut next = if self.reset {
            UserTransform::IDENTITY
        } else {
            current
        };
        if let Some(offset) = self.offset {
            next.translation = offset;
        }
        if let Some(scale) = self.scale {
            next.scale = scale;
        }
        if !next.is_valid() {
            return Err(CliError::config(
                "a transform needs finite numbers and a scale above zero on every axis",
            ));
        }
        Ok(next)
    }
}

/// Three comma-separated numbers, `x,y,z`.
pub fn parse_triple(raw: &str) -> Result<[f64; 3], String> {
    let numbers = raw
        .split(',')
        .map(|part| {
            part.trim()
                .parse::<f64>()
                .map_err(|e| format!("{part:?}: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    <[f64; 3]>::try_from(numbers).map_err(|_| "expected three numbers, x,y,z".to_string())
}

/// One number for every axis, or three, `x,y,z`.
pub fn parse_scale(raw: &str) -> Result<[f64; 3], String> {
    if raw.contains(',') {
        parse_triple(raw)
    } else {
        let s = raw
            .trim()
            .parse::<f64>()
            .map_err(|e| format!("{raw:?}: {e}"))?;
        Ok([s; 3])
    }
}

#[derive(Debug, Serialize)]
pub struct DatasetTransformOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub dataset: DatasetSummary,
    /// The workspace sequence of the change, absent when nothing changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// The dataset's transform now, the identity when it sits where its
    /// metadata places it.
    pub user_transform: UserTransform,
    /// The unit each axis declares, `[x, y, z]`, which the offset is in.
    pub units: [Option<String>; 3],
}

pub struct DatasetTransformClient {
    ws_url: String,
    token: Option<String>,
}

impl DatasetTransformClient {
    pub fn new(ws_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            ws_url: ws_url.into(),
            token: token.map(|effective| effective.token),
        }
    }

    /// Make `change` to the dataset `selector` names and wait for the
    /// server to take it. An empty change, or one that leaves the transform
    /// as it was, sends nothing.
    pub async fn transform(
        &self,
        selector: &str,
        change: &TransformChange,
        workspace: &WorkspaceRecord,
        wait: Duration,
    ) -> Result<TransformResult, CliError> {
        if !change.is_empty() && workspace.role == WorkspaceRole::Viewer {
            return Err(CliError::new(
                ErrorKind::Unauthorized,
                "workspace role cannot place datasets",
            ));
        }
        let socket = connect_workspace_socket(&self.ws_url, self.token.as_deref()).await?;
        let (mut write, read) = socket.split();
        let mut incoming = incoming_messages(read);
        let snapshot = wait_for_workspace_snapshot(&mut incoming, wait).await?;
        let datasets = dataset_summaries_from_document(&snapshot.document);
        let dataset = resolve_dataset_summary(selector, &datasets)?;
        let id = DatasetId(dataset.workspace_dataset_id.clone());
        let current = snapshot
            .document
            .user_transforms
            .get(&id)
            .copied()
            .unwrap_or_default();
        let units = snapshot
            .document
            .manifests
            .get(&id)
            .and_then(|manifest| manifest.space())
            .map_or([None, None, None], |space| {
                let [z, y, x] = space.units.clone();
                [x, y, z]
            });
        let next = change.applied_to(current)?;
        let seq = if next == current {
            None
        } else {
            let message = ClientMessage::Command {
                command: DocumentCommand::SetUserTransform {
                    dataset_id: id.clone(),
                    transform: next,
                },
            };
            send_client_message(&mut write, &message).await?;
            Some(wait_for_transform_ack(&mut incoming, &id, wait).await?)
        };
        Ok(TransformResult {
            dataset,
            seq,
            user_transform: next,
            units,
        })
    }
}

pub struct TransformResult {
    pub dataset: DatasetSummary,
    pub seq: Option<u64>,
    pub user_transform: UserTransform,
    pub units: [Option<String>; 3],
}

pub fn format_dataset_transform_human(output: &DatasetTransformOutput) -> String {
    let t = &output.user_transform;
    let numbers = |v: &[f64; 3]| {
        v.iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    // A flat image declares no Z unit, and its Z offset reads in X's.
    let unit = match &output.units {
        [Some(x), Some(y), z] if x == y && z.as_ref().is_none_or(|z| z == x) => format!(" {x}"),
        _ => String::new(),
    };
    let mut lines = vec![format!(
        "Dataset: {} ({})",
        output.dataset.name, output.dataset.workspace_dataset_id
    )];
    if t.is_identity() {
        lines.push("Placement: where its metadata puts it".to_string());
    } else {
        lines.push("Placement: moved by hand".to_string());
        lines.push(format!("Offset: {}{unit}", numbers(&t.translation)));
        lines.push(format!("Scale: {}", numbers(&t.scale)));
    }
    lines.push(format!(
        "Workspace: {} ({})",
        output.workspace.name, output.workspace.id
    ));
    if let Some(seq) = output.seq {
        lines.push(format!("Sequence: {seq}"));
    }
    lines.join("\n")
}

async fn wait_for_transform_ack<S>(
    messages: &mut S,
    dataset_id: &DatasetId,
    wait: Duration,
) -> Result<u64, CliError>
where
    S: Stream<Item = Result<IncomingSessionMessage, CliError>> + Unpin,
{
    const TRANSFORM_WAIT: SessionWait = SessionWait {
        expectation: "transform confirmation",
        archived_outcome: "the dataset was placed",
        timeout_subject: "dataset transform confirmation",
        timeout_kind: ErrorKind::RejectedCommand,
    };
    observe_until(messages, wait, &TRANSFORM_WAIT, |message| match message {
        ServerMessage::Ack { seq } => Ok(Some(seq)),
        ServerMessage::CommandBroadcast {
            seq,
            command:
                DocumentCommand::SetUserTransform {
                    dataset_id: observed,
                    ..
                },
        } if &observed == dataset_id => Ok(Some(seq)),
        _ => Ok(None),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_replaces_what_it_names_and_keeps_the_rest() {
        let current = UserTransform {
            translation: [1.0, 2.0, 3.0],
            scale: [2.0; 3],
            ..UserTransform::IDENTITY
        };
        let scale_only = TransformChange {
            scale: Some([4.0, 4.0, 1.0]),
            ..Default::default()
        };
        let next = scale_only.applied_to(current).unwrap();
        assert_eq!(next.translation, [1.0, 2.0, 3.0]);
        assert_eq!(next.scale, [4.0, 4.0, 1.0]);

        let reset_then_move = TransformChange {
            offset: Some([5.0, 0.0, 0.0]),
            reset: true,
            ..Default::default()
        };
        let next = reset_then_move.applied_to(current).unwrap();
        assert_eq!(next.translation, [5.0, 0.0, 0.0]);
        assert_eq!(next.scale, [1.0; 3]);
        assert!(TransformChange::default().is_empty());
    }

    #[test]
    fn a_change_to_no_size_is_refused() {
        let flat = TransformChange {
            scale: Some([1.0, 0.0, 1.0]),
            ..Default::default()
        };
        assert!(flat.applied_to(UserTransform::IDENTITY).is_err());
    }

    #[test]
    fn numbers_parse_as_three_or_as_one_for_every_axis() {
        assert_eq!(parse_triple("1.5,-2,0"), Ok([1.5, -2.0, 0.0]));
        assert!(parse_triple("1,2").is_err());
        assert!(parse_triple("1,x,2").is_err());
        assert_eq!(parse_scale("2"), Ok([2.0; 3]));
        assert_eq!(parse_scale("2, 2, 1"), Ok([2.0, 2.0, 1.0]));
    }
}
