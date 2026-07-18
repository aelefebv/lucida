//! Server-owned policy for identity-bearing collaborative commands.
//!
//! Client `author` fields are display inputs, never authorization facts. Every
//! ingress path calls this module immediately before applying a command so the
//! authenticated principal is stamped onto new records and ownership checks
//! inspect the same document snapshot that will be mutated.

use lucida_content::DatasetId;
use lucida_core::command::DocumentCommand;
use lucida_core::scene::{Annotation, Comment, DocumentState};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CommandPolicyError {
    #[error("authenticated actor identity is empty")]
    MissingActor,
    #[error("the authenticated actor does not own the targeted {0}")]
    NotOwner(&'static str),
}

/// Stamp server identity and enforce author ownership.
///
/// Workspace owners may moderate another member's annotation or comment;
/// ordinary editors and legacy-session participants may only mutate their own.
/// Unknown targets remain harmless no-ops to preserve command idempotence.
pub fn authorize_and_stamp(
    document: &DocumentState,
    command: DocumentCommand,
    authenticated_email: &str,
    can_moderate: bool,
) -> Result<DocumentCommand, CommandPolicyError> {
    let actor = normalize_actor(authenticated_email);
    if actor.is_empty() {
        return Err(CommandPolicyError::MissingActor);
    }

    match command {
        DocumentCommand::AddAnnotation {
            dataset_id,
            id,
            position,
            end,
            z,
            t,
            c,
            author: _,
            kind,
            view,
        } => {
            if let Some(existing) = annotation(document, &dataset_id, &id) {
                require_owner(&existing.author, &actor, can_moderate, "annotation")?;
            }
            Ok(DocumentCommand::AddAnnotation {
                dataset_id,
                id,
                position,
                end,
                z,
                t,
                c,
                author: actor,
                kind,
                view,
            })
        }
        DocumentCommand::AddComment {
            dataset_id,
            annotation_id,
            id,
            author: _,
            text,
        } => {
            if let Some(existing) = comment(document, &dataset_id, &annotation_id, &id) {
                require_owner(&existing.author, &actor, can_moderate, "comment")?;
            }
            Ok(DocumentCommand::AddComment {
                dataset_id,
                annotation_id,
                id,
                author: actor,
                text,
            })
        }
        DocumentCommand::RemoveAnnotation { dataset_id, id } => {
            if let Some(existing) = annotation(document, &dataset_id, &id) {
                require_owner(&existing.author, &actor, can_moderate, "annotation")?;
            }
            Ok(DocumentCommand::RemoveAnnotation { dataset_id, id })
        }
        DocumentCommand::MoveAnnotation {
            dataset_id,
            id,
            position,
            end,
            z,
        } => {
            if let Some(existing) = annotation(document, &dataset_id, &id) {
                require_owner(&existing.author, &actor, can_moderate, "annotation")?;
            }
            Ok(DocumentCommand::MoveAnnotation {
                dataset_id,
                id,
                position,
                end,
                z,
            })
        }
        DocumentCommand::RemoveComment {
            dataset_id,
            annotation_id,
            id,
        } => {
            if let Some(existing) = comment(document, &dataset_id, &annotation_id, &id) {
                require_owner(&existing.author, &actor, can_moderate, "comment")?;
            }
            Ok(DocumentCommand::RemoveComment {
                dataset_id,
                annotation_id,
                id,
            })
        }
        DocumentCommand::EditComment {
            dataset_id,
            annotation_id,
            id,
            text,
        } => {
            if let Some(existing) = comment(document, &dataset_id, &annotation_id, &id) {
                require_owner(&existing.author, &actor, can_moderate, "comment")?;
            }
            Ok(DocumentCommand::EditComment {
                dataset_id,
                annotation_id,
                id,
                text,
            })
        }
        other => Ok(other),
    }
}

fn annotation<'a>(
    document: &'a DocumentState,
    dataset_id: &DatasetId,
    id: &str,
) -> Option<&'a Annotation> {
    document
        .annotations
        .get(dataset_id)?
        .iter()
        .find(|annotation| annotation.id == id)
}

fn comment<'a>(
    document: &'a DocumentState,
    dataset_id: &DatasetId,
    annotation_id: &str,
    id: &str,
) -> Option<&'a Comment> {
    annotation(document, dataset_id, annotation_id)?
        .comments
        .iter()
        .find(|comment| comment.id == id)
}

fn normalize_actor(actor: &str) -> String {
    actor.trim().to_ascii_lowercase()
}

fn require_owner(
    author: &str,
    actor: &str,
    can_moderate: bool,
    resource: &'static str,
) -> Result<(), CommandPolicyError> {
    if can_moderate || normalize_actor(author) == actor {
        Ok(())
    } else {
        Err(CommandPolicyError::NotOwner(resource))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_core::scene::{AnnotationKind, Comment};

    fn document_owned_by(author: &str) -> DocumentState {
        let mut document = DocumentState::default();
        document.annotations.insert(
            DatasetId("dataset".into()),
            vec![Annotation {
                id: "pin".into(),
                position: [0.0, 0.0],
                z: 0.0,
                t: 0,
                c: 0,
                author: author.into(),
                kind: AnnotationKind::Point,
                end: None,
                comments: vec![Comment {
                    id: "comment".into(),
                    author: author.into(),
                    text: "hello".into(),
                }],
                anchor: None,
                view: None,
            }],
        );
        document
    }

    #[test]
    fn add_annotation_discards_forged_author() {
        let command = DocumentCommand::AddAnnotation {
            dataset_id: DatasetId("dataset".into()),
            id: "new".into(),
            position: [1.0, 2.0],
            end: None,
            z: 0.0,
            t: 0,
            c: 0,
            author: "victim@example.com".into(),
            kind: AnnotationKind::Point,
            view: None,
        };
        let stamped = authorize_and_stamp(
            &DocumentState::default(),
            command,
            " Actor@Example.com ",
            false,
        )
        .unwrap();
        assert!(matches!(
            stamped,
            DocumentCommand::AddAnnotation { author, .. }
                if author == "actor@example.com"
        ));
    }

    #[test]
    fn editor_cannot_replace_move_or_delete_anothers_content() {
        let document = document_owned_by("owner@example.com");
        for command in [
            DocumentCommand::RemoveAnnotation {
                dataset_id: DatasetId("dataset".into()),
                id: "pin".into(),
            },
            DocumentCommand::EditComment {
                dataset_id: DatasetId("dataset".into()),
                annotation_id: "pin".into(),
                id: "comment".into(),
                text: "forged".into(),
            },
        ] {
            let resource = if matches!(command, DocumentCommand::EditComment { .. }) {
                "comment"
            } else {
                "annotation"
            };
            assert!(matches!(
                authorize_and_stamp(&document, command, "attacker@example.com", false),
                Err(CommandPolicyError::NotOwner(found)) if found == resource
            ));
        }
    }

    #[test]
    fn workspace_owner_can_moderate() {
        let document = document_owned_by("member@example.com");
        assert!(
            authorize_and_stamp(
                &document,
                DocumentCommand::RemoveAnnotation {
                    dataset_id: DatasetId("dataset".into()),
                    id: "pin".into(),
                },
                "owner@example.com",
                true,
            )
            .is_ok()
        );
    }
}
