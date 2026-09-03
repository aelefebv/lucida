//! Conformance suite for `WorkspaceStore`.
//!
//! Two implementations, SQLite and PostgreSQL, and every case runs
//! against both. The PostgreSQL one is in `when_available:` because it
//! needs a server the machine may not have.

use std::sync::Arc;

use lucida_content::{DatasetId, DatasetKind, DatasetManifest};
use lucida_core::auth_principal::AuthPrincipal;
use lucida_core::saved_view::SavedView;
use lucida_core::scene::DocumentState;

use crate::storage::StorageBackend;
use crate::storage::test_support::{postgres_backend, sqlite_backend};
use crate::workspace::{
    SavedViewVisibility, WorkspaceLinkAccess, WorkspaceRecord, WorkspaceRole, WorkspaceSavedView,
    WorkspaceStore,
};

conformance_suite! {
    cases: [
        a_created_workspace_reads_back,
        a_blank_name_falls_back_to_the_default,
        an_absent_workspace_reads_as_none,
        the_creator_is_the_only_member_and_owns_it,
        a_stranger_has_no_role_and_an_admin_owns_everything,
        the_admin_surface_reaches_a_workspace_nobody_shared,
        the_admin_search_matches_without_regard_to_case,
        an_admin_search_with_no_query_returns_every_workspace,
        an_orphaned_workspace_can_be_given_an_owner,
        promoting_a_member_to_owner_leaves_one_membership,
        rename_changes_the_name_and_leaves_the_document,
        renaming_an_absent_workspace_is_none,
        archiving_moves_a_workspace_between_the_two_lists,
        archiving_twice_is_none_and_restoring_brings_it_back,
        a_persisted_document_reads_back_with_its_sequence,
        a_sequence_past_a_32_bit_integer_reads_back_whole,
        opening_a_dataset_persists_membership_and_document_together,
        reopening_the_same_source_keeps_the_first_workspace_local_id,
        reopening_a_source_refreshes_where_it_points,
        one_source_gets_its_own_workspace_local_id_in_each_workspace,
        a_rejected_dataset_open_leaves_the_workspace_untouched,
        datasets_list_in_the_order_they_were_opened,
        renaming_a_dataset_stays_inside_its_own_workspace,
        removing_a_dataset_drops_the_membership,
        members_can_be_added_promoted_and_removed,
        re_adding_a_member_replaces_the_role_and_the_name,
        member_emails_are_matched_case_insensitively,
        removing_an_absent_member_is_false,
        writing_a_member_into_an_absent_workspace_is_none,
        link_access_reads_back_through_the_sharing_settings,
        a_saved_view_reads_back_and_is_scoped_to_its_workspace,
        saved_views_list_most_recently_updated_first,
        a_personal_view_stays_with_its_author,
        an_editor_sees_every_proposed_view,
        a_saved_view_survives_every_hop_between_the_three_visibilities,
        re_scoping_an_absent_saved_view_is_none,
        updating_a_saved_view_changes_only_what_was_passed,
        deleting_a_saved_view_clears_the_default_that_pointed_at_it,
        deleting_an_absent_saved_view_is_false,
        a_viewer_profile_is_private_to_one_member_and_profile,
        opening_and_pinning_are_recorded_per_member,
        each_write_of_one_members_state_leaves_the_rest_of_it_alone,
        recording_a_last_view_leaves_the_shared_default_alone,
        duplicating_copies_the_content_and_none_of_the_sharing,
        duplicating_an_absent_workspace_is_none,
    ],
    over: [sqlite],
    when_available: [postgres],
}

async fn sqlite() -> Arc<dyn WorkspaceStore> {
    sqlite_backend().await.workspaces()
}

/// `None` when no PostgreSQL was offered. The harness says so once, on
/// stderr, rather than letting the whole suite pass without running.
async fn postgres() -> Option<Arc<dyn WorkspaceStore>> {
    Some(postgres_backend().await?.backend.workspaces())
}

fn member(email: &str) -> AuthPrincipal {
    AuthPrincipal {
        email: email.to_string(),
        display_name: format!("{email} display name"),
        picture_url: None,
        is_admin: false,
    }
}

fn admin(email: &str) -> AuthPrincipal {
    AuthPrincipal {
        is_admin: true,
        ..member(email)
    }
}

/// A document carrying one manifest per `(id, name)` pair, which is as
/// much of the document as the store has an opinion about: it stores the
/// blob and hands it back.
fn document_over(datasets: &[(&DatasetId, &str)]) -> DocumentState {
    let mut document = DocumentState::default();
    for (id, name) in datasets {
        document.register_dataset(DatasetManifest::new(
            (*id).clone(),
            (*name).to_string(),
            DatasetKind::Single,
            vec![],
            vec![],
            vec![],
            vec![],
            None,
        ));
    }
    document
}

/// Open `url` into `workspace_id` under a fresh workspace-local id, the
/// way the runtime does: a manifest in the document and a membership row
/// in the same call.
async fn open_dataset(
    store: &Arc<dyn WorkspaceStore>,
    workspace_id: &str,
    owner: &AuthPrincipal,
    source_id: &str,
    url: &str,
    display_name: &str,
    seq: u64,
) -> DatasetId {
    let dataset_id = DatasetId(format!("wds-{source_id}"));
    let document = document_over(&[(&dataset_id, display_name)]);
    store
        .persist_dataset_opened(
            workspace_id,
            &dataset_id,
            source_id,
            url,
            display_name,
            &owner.email,
            seq,
            &document,
        )
        .await
        .unwrap();
    dataset_id
}

async fn workspace_named(
    store: &Arc<dyn WorkspaceStore>,
    owner: &AuthPrincipal,
    name: &str,
) -> WorkspaceRecord {
    store.create_workspace(owner, Some(name)).await.unwrap()
}

/// The source id two workspaces share in [`two_workspaces_over_one_source`].
const SHARED_SOURCE: &str = "source-shared";

/// Two workspaces with the same dataset source open in both, each under
/// its own workspace-local id. Returns their ids; the local id in each is
/// `wds-<workspace id>`.
async fn two_workspaces_over_one_source(
    store: &Arc<dyn WorkspaceStore>,
    owner: &AuthPrincipal,
) -> (String, String) {
    let here = workspace_named(store, owner, "Here").await;
    let there = workspace_named(store, owner, "There").await;
    for workspace in [&here.id, &there.id] {
        let dataset_id = DatasetId(format!("wds-{workspace}"));
        store
            .persist_dataset_opened(
                workspace,
                &dataset_id,
                SHARED_SOURCE,
                "file:///data/shared.zarr",
                "Shared",
                &owner.email,
                1,
                &document_over(&[(&dataset_id, "Shared")]),
            )
            .await
            .unwrap();
    }
    (here.id, there.id)
}

/// A shared saved view named `name`, over the default empty view.
async fn shared_view(
    store: &Arc<dyn WorkspaceStore>,
    workspace_id: &str,
    author: &AuthPrincipal,
    name: &str,
) -> WorkspaceSavedView {
    store
        .create_saved_view(
            workspace_id,
            name,
            author,
            SavedView::empty([800, 600]),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap()
        .unwrap()
}

/// The saved views `viewer_email` can see, in the order the store listed
/// them, as an id list an ordering assertion can name.
async fn listed_ids(
    store: &Arc<dyn WorkspaceStore>,
    workspace_id: &str,
    viewer_email: &str,
) -> Vec<String> {
    store
        .list_saved_views(workspace_id, viewer_email, true)
        .await
        .unwrap()
        .into_iter()
        .map(|view| view.id)
        .collect()
}

async fn a_created_workspace_reads_back(store: Arc<dyn WorkspaceStore>) {
    let owner = member("Owner@Example.com");
    let created = workspace_named(&store, &owner, "  Demo  ").await;

    assert_eq!(created.name, "Demo", "the name is trimmed on the way in");
    assert_eq!(
        created.created_by, "owner@example.com",
        "the creator is stored normalized, so a differently-cased sign-in still matches",
    );
    assert_eq!(created.seq, 0);
    assert!(created.archived_at.is_none());
    assert!(created.default_saved_view_id.is_none());
    assert!(created.document.manifests.is_empty());

    let found = store.get_workspace(&created.id).await.unwrap().unwrap();
    assert_eq!(found.id, created.id);
    assert_eq!(found.name, "Demo");
    assert_eq!(found.created_by, "owner@example.com");
    assert_eq!(found.created_at, created.created_at);
    assert_eq!(found.seq, 0);
}

async fn a_blank_name_falls_back_to_the_default(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");

    let unnamed = store.create_workspace(&owner, None).await.unwrap();
    assert_eq!(unnamed.name, "Untitled workspace");

    let blank = workspace_named(&store, &owner, "   ").await;
    assert_eq!(blank.name, "Untitled workspace");
}

async fn an_absent_workspace_reads_as_none(store: Arc<dyn WorkspaceStore>) {
    assert!(
        store
            .get_workspace("never-created")
            .await
            .unwrap()
            .is_none()
    );
}

async fn the_creator_is_the_only_member_and_owns_it(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let listed = store.list_workspaces(&owner).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);
    assert_eq!(listed[0].role, WorkspaceRole::Owner);

    let sharing = store.sharing_settings(&created.id).await.unwrap().unwrap();
    assert_eq!(sharing.link_access, WorkspaceLinkAccess::Restricted);
    assert_eq!(sharing.members.len(), 1);
    assert_eq!(sharing.members[0].email, "owner@example.com");
    assert_eq!(sharing.members[0].role, WorkspaceRole::Owner);
}

async fn a_stranger_has_no_role_and_an_admin_owns_everything(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let stranger = member("stranger@example.com");
    let support = admin("support@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    assert_eq!(store.role_for(&created.id, &stranger).await.unwrap(), None);
    assert!(store.list_workspaces(&stranger).await.unwrap().is_empty());
    assert_eq!(
        store.role_for(&created.id, &support).await.unwrap(),
        Some(WorkspaceRole::Owner),
    );
    assert_eq!(
        store.role_for("never-created", &support).await.unwrap(),
        None,
        "owning everything is not owning a workspace that does not exist",
    );
}

async fn the_admin_surface_reaches_a_workspace_nobody_shared(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Quarterly rollup").await;
    store.archive_workspace(&created.id).await.unwrap();

    // One query string can be a name, an id, or a member's address.
    for query in ["quarterly", &created.id, "owner@example"] {
        let hits = store
            .admin_search_workspaces(Some(query), true, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1, "{query} should find the workspace");
        assert_eq!(hits[0].id, created.id);
        assert_eq!(hits[0].member_count, 1);
        assert_eq!(hits[0].owner_count, 1);
    }
    assert!(
        store
            .admin_search_workspaces(Some("quarterly"), false, 10)
            .await
            .unwrap()
            .is_empty(),
        "an archived workspace is out of the default search",
    );

    let details = store
        .admin_workspace_details(&created.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(details.workspace.id, created.id);
    assert_eq!(details.members.len(), 1);
    assert_eq!(details.members[0].email, "owner@example.com");
    assert!(
        store
            .admin_workspace_details("never-created")
            .await
            .unwrap()
            .is_none()
    );
}

/// The admin search folds case on every field it matches, and folds it
/// the same way whichever engine is answering.
///
/// Only ASCII is asserted. The fold is the engine's own `LOWER`, and the
/// two do not agree past ASCII — see `admin_search_query` in the store's
/// shared statements for what that costs and why no portable spelling
/// closes it.
async fn the_admin_search_matches_without_regard_to_case(store: Arc<dyn WorkspaceStore>) {
    let owner = member("Owner@Example.com");
    let created = workspace_named(&store, &owner, "Quarterly ROLLUP").await;

    // Name, address, and id, each queried in a casing the stored value
    // does not have.
    for query in [
        "quarterly rollup",
        "QUARTERLY ROLLUP",
        "OWNER@EXAMPLE.COM",
        &created.id.to_ascii_uppercase(),
    ] {
        let hits = store
            .admin_search_workspaces(Some(query), false, 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1, "{query} should find the workspace");
        assert_eq!(hits[0].id, created.id);
    }

    assert!(
        store
            .admin_search_workspaces(Some("nothing like it"), true, 10)
            .await
            .unwrap()
            .is_empty(),
    );
}

/// The search assembles four shapes — query or not, archived or not — and
/// the two without a query are the ones no other case reaches. The limit
/// is bound rather than interpolated, so it is asserted here too.
async fn an_admin_search_with_no_query_returns_every_workspace(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let live = workspace_named(&store, &owner, "Live").await;
    let shelved = workspace_named(&store, &owner, "Shelved").await;
    store.archive_workspace(&shelved.id).await.unwrap();

    let default_search = store
        .admin_search_workspaces(None, false, 10)
        .await
        .unwrap();
    assert_eq!(default_search.len(), 1);
    assert_eq!(default_search[0].id, live.id);

    let everything = store.admin_search_workspaces(None, true, 10).await.unwrap();
    assert_eq!(everything.len(), 2);
    assert_eq!(
        everything[0].id, live.id,
        "a live workspace sorts ahead of an archived one",
    );

    // A limit below one is raised to one rather than returning nothing.
    let capped = store.admin_search_workspaces(None, true, 0).await.unwrap();
    assert_eq!(capped.len(), 1);
}

async fn an_orphaned_workspace_can_be_given_an_owner(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let successor = member("successor@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    assert!(
        store
            .remove_member(&created.id, &owner.email)
            .await
            .unwrap()
    );
    assert_eq!(
        store
            .owner_role_for_any_state(&created.id, &owner)
            .await
            .unwrap(),
        None,
    );

    let installed = store
        .admin_upsert_owner(&created.id, "Successor@Example.com", "Successor")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(installed.email, "successor@example.com");
    assert_eq!(installed.role, WorkspaceRole::Owner);
    assert_eq!(
        store
            .owner_role_for_any_state(&created.id, &successor)
            .await
            .unwrap(),
        Some(WorkspaceRole::Owner),
    );

    // Ownership survives archiving, which is what makes an archived
    // workspace restorable by the person who owns it.
    store.archive_workspace(&created.id).await.unwrap();
    assert_eq!(
        store
            .owner_role_for_any_state(&created.id, &successor)
            .await
            .unwrap(),
        Some(WorkspaceRole::Owner),
    );
    assert!(
        store
            .admin_upsert_owner("never-created", &successor.email, "Successor")
            .await
            .unwrap()
            .is_none()
    );
}

/// Handing an existing member the owner role rewrites the row they
/// already have rather than adding a second one.
async fn promoting_a_member_to_owner_leaves_one_membership(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    store
        .upsert_member(
            &created.id,
            &colleague.email,
            "Colleague",
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap()
        .unwrap();

    let promoted = store
        .admin_upsert_owner(&created.id, "Colleague@Example.com", "Colleague, renamed")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(promoted.role, WorkspaceRole::Owner);
    assert_eq!(promoted.display_name, "Colleague, renamed");

    let sharing = store.sharing_settings(&created.id).await.unwrap().unwrap();
    assert_eq!(
        sharing.members.len(),
        2,
        "promoting a member is a rewrite, not a second membership",
    );
}

async fn rename_changes_the_name_and_leaves_the_document(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Old name").await;
    let dataset_id = DatasetId("wds-a".to_string());
    store
        .persist_document(&created.id, 4, &document_over(&[(&dataset_id, "Alpha")]))
        .await
        .unwrap();

    let renamed = store
        .rename_workspace(&created.id, "New name")
        .await
        .unwrap()
        .unwrap();

    assert_eq!(renamed.name, "New name");
    assert_eq!(renamed.seq, 4);
    assert!(renamed.document.manifests.contains_key(&dataset_id));
}

async fn renaming_an_absent_workspace_is_none(store: Arc<dyn WorkspaceStore>) {
    assert!(
        store
            .rename_workspace("never-created", "New name")
            .await
            .unwrap()
            .is_none()
    );
}

async fn archiving_moves_a_workspace_between_the_two_lists(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let archived = store.archive_workspace(&created.id).await.unwrap().unwrap();
    assert!(archived.archived_at.is_some());

    assert!(store.list_workspaces(&owner).await.unwrap().is_empty());
    let shelved = store.list_archived_workspaces(&owner).await.unwrap();
    assert_eq!(shelved.len(), 1);
    assert_eq!(shelved[0].id, created.id);

    assert_eq!(
        store.role_for(&created.id, &owner).await.unwrap(),
        None,
        "an archived workspace grants nobody a working role",
    );
    assert_eq!(
        store
            .member_role_for_any_state(&created.id, &owner)
            .await
            .unwrap(),
        Some(WorkspaceRole::Owner),
        "the owner is still a member, which is how an archived workspace can say so rather than \
         look missing",
    );
}

async fn archiving_twice_is_none_and_restoring_brings_it_back(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    store.archive_workspace(&created.id).await.unwrap();

    assert!(
        store
            .archive_workspace(&created.id)
            .await
            .unwrap()
            .is_none(),
        "only the caller who actually archived the workspace is told so",
    );

    let restored = store.restore_workspace(&created.id).await.unwrap().unwrap();
    assert!(restored.archived_at.is_none());
    assert_eq!(store.list_workspaces(&owner).await.unwrap().len(), 1);
    assert!(
        store
            .list_archived_workspaces(&owner)
            .await
            .unwrap()
            .is_empty()
    );
}

async fn a_persisted_document_reads_back_with_its_sequence(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let dataset_id = DatasetId("wds-a".to_string());

    store
        .persist_document(&created.id, 9, &document_over(&[(&dataset_id, "Alpha")]))
        .await
        .unwrap();

    let reread = store.get_workspace(&created.id).await.unwrap().unwrap();
    assert_eq!(reread.seq, 9);
    assert_eq!(reread.document.manifests[&dataset_id].name, "Alpha");
}

/// A long-lived workspace outgrows a 32-bit counter: the sequence advances
/// once per persisted command, and nothing resets it.
///
/// The trait takes a `u64` and the column is 64-bit on both engines, so
/// this is a value the store owes rather than a limit it may impose. The
/// number is one past the range of a signed 32-bit integer, which is where
/// a column declared too narrow would fail.
async fn a_sequence_past_a_32_bit_integer_reads_back_whole(store: Arc<dyn WorkspaceStore>) {
    const BEYOND_32_BITS: u64 = 2_147_483_648;

    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let dataset_id = DatasetId("wds-a".to_string());

    store
        .persist_document(
            &created.id,
            BEYOND_32_BITS,
            &document_over(&[(&dataset_id, "Alpha")]),
        )
        .await
        .unwrap();

    assert_eq!(
        store.get_workspace(&created.id).await.unwrap().unwrap().seq,
        BEYOND_32_BITS,
    );
    // The listings decode the same column through their own mappers.
    assert_eq!(
        store.list_workspaces(&owner).await.unwrap()[0].seq,
        BEYOND_32_BITS,
    );
    assert_eq!(
        store
            .admin_search_workspaces(None, false, 10)
            .await
            .unwrap()[0]
            .seq,
        BEYOND_32_BITS,
    );
}

async fn opening_a_dataset_persists_membership_and_document_together(
    store: Arc<dyn WorkspaceStore>,
) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let dataset_id = open_dataset(
        &store,
        &created.id,
        &owner,
        "source-a",
        "file:///data/a.zarr",
        "Alpha",
        1,
    )
    .await;

    // Membership and document are one write, so a reader never sees a
    // manifest whose membership row is missing, or the reverse.
    let reread = store.get_workspace(&created.id).await.unwrap().unwrap();
    assert_eq!(reread.seq, 1);
    assert!(reread.document.manifests.contains_key(&dataset_id));

    let attached = store
        .dataset_by_source(&created.id, "source-a")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(attached.workspace_dataset_id, dataset_id);
    assert_eq!(attached.canonical_url, "file:///data/a.zarr");
    assert_eq!(attached.display_name, "Alpha");

    let by_local_id = store
        .dataset_by_workspace_dataset(&created.id, &dataset_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(by_local_id.dataset_source_id, "source-a");
}

async fn reopening_the_same_source_keeps_the_first_workspace_local_id(
    store: Arc<dyn WorkspaceStore>,
) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let first = open_dataset(
        &store,
        &created.id,
        &owner,
        "source-a",
        "file:///data/a.zarr",
        "Alpha",
        1,
    )
    .await;

    let second_id = DatasetId("wds-a-second-attempt".to_string());
    store
        .persist_dataset_opened(
            &created.id,
            &second_id,
            "source-a",
            "file:///data/a.zarr",
            "Alpha again",
            &owner.email,
            2,
            &document_over(&[(&first, "Alpha")]),
        )
        .await
        .unwrap();

    let attached = store.list_dataset_sources(&created.id).await.unwrap();
    assert_eq!(
        attached.len(),
        1,
        "one source is loaded into a workspace once"
    );
    assert_eq!(
        attached[0].workspace_dataset_id, first,
        "reopening keeps the id the document already refers to",
    );
    assert_eq!(attached[0].display_name, "Alpha");
}

/// A source's identity is refreshed by the open that names it, in every
/// workspace holding it at once — unlike the workspace-local display name,
/// which the same call leaves alone.
async fn reopening_a_source_refreshes_where_it_points(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let (here, there) = two_workspaces_over_one_source(&store, &owner).await;

    let dataset_id = DatasetId(format!("wds-{here}"));
    store
        .persist_dataset_opened(
            &here,
            &dataset_id,
            SHARED_SOURCE,
            "file:///data/moved.zarr",
            "Moved",
            &owner.email,
            2,
            &document_over(&[(&dataset_id, "Shared")]),
        )
        .await
        .unwrap();

    for workspace in [&here, &there] {
        let attached = store
            .dataset_by_source(workspace, SHARED_SOURCE)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            attached.canonical_url, "file:///data/moved.zarr",
            "the source moved, and it is one source",
        );
        assert_eq!(
            attached.display_name, "Shared",
            "the workspace-local name is not the source's to change",
        );
    }
}

async fn one_source_gets_its_own_workspace_local_id_in_each_workspace(
    store: Arc<dyn WorkspaceStore>,
) {
    let owner = member("owner@example.com");
    let (here, there) = two_workspaces_over_one_source(&store, &owner).await;

    let mine = store
        .dataset_by_source(&here, SHARED_SOURCE)
        .await
        .unwrap()
        .unwrap();
    let theirs = store
        .dataset_by_source(&there, SHARED_SOURCE)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(mine.canonical_url, theirs.canonical_url);
    assert_ne!(
        mine.workspace_dataset_id, theirs.workspace_dataset_id,
        "the source is shared; the workspace-local identity is not",
    );
}

async fn a_rejected_dataset_open_leaves_the_workspace_untouched(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let landed = open_dataset(
        &store,
        &created.id,
        &owner,
        "source-a",
        "file:///data/a.zarr",
        "Alpha",
        1,
    )
    .await;

    // Reusing a taken workspace-local id fails partway: the source
    // registration lands before the membership row breaks, so the call
    // has to roll that back along with the document and sequence it
    // carries.
    let result = store
        .persist_dataset_opened(
            &created.id,
            &landed,
            "source-b",
            "file:///data/b.zarr",
            "Beta",
            &owner.email,
            2,
            &document_over(&[(&landed, "Beta")]),
        )
        .await;
    assert!(result.is_err(), "one workspace-local id names one dataset");

    let reread = store.get_workspace(&created.id).await.unwrap().unwrap();
    assert_eq!(
        reread.seq, 1,
        "the rejected open did not advance the sequence"
    );
    assert_eq!(reread.document.manifests[&landed].name, "Alpha");
    let attached = store.list_dataset_sources(&created.id).await.unwrap();
    assert_eq!(attached.len(), 1);
    assert_eq!(attached[0].dataset_source_id, "source-a");

    // A URL belongs to one source, so had the rolled-back registration
    // survived, opening the same URL under another source id would be
    // refused.
    let recovered = open_dataset(
        &store,
        &created.id,
        &owner,
        "source-c",
        "file:///data/b.zarr",
        "Beta",
        2,
    )
    .await;
    assert_eq!(
        store
            .dataset_by_source(&created.id, "source-c")
            .await
            .unwrap()
            .unwrap()
            .workspace_dataset_id,
        recovered,
    );
}

async fn datasets_list_in_the_order_they_were_opened(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let mut opened = Vec::new();
    for (seq, source) in ["source-c", "source-a", "source-b"].into_iter().enumerate() {
        opened.push(
            open_dataset(
                &store,
                &created.id,
                &owner,
                source,
                &format!("file:///data/{source}.zarr"),
                source,
                seq as u64 + 1,
            )
            .await,
        );
    }

    let listed: Vec<DatasetId> = store
        .list_dataset_sources(&created.id)
        .await
        .unwrap()
        .into_iter()
        .map(|source| source.workspace_dataset_id)
        .collect();
    assert_eq!(
        listed, opened,
        "the layer panel's order is the order datasets were opened, not their names",
    );
}

async fn renaming_a_dataset_stays_inside_its_own_workspace(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let (here, there) = two_workspaces_over_one_source(&store, &owner).await;

    let renamed_id = DatasetId(format!("wds-{here}"));
    store
        .persist_dataset_renamed(
            &here,
            &renamed_id,
            "My own name",
            2,
            &document_over(&[(&renamed_id, "My own name")]),
        )
        .await
        .unwrap();

    assert_eq!(
        store
            .dataset_by_source(&here, SHARED_SOURCE)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "My own name",
    );
    assert_eq!(
        store
            .dataset_by_source(&there, SHARED_SOURCE)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "Shared",
        "a rename is per workspace, not a rename of the shared source",
    );
}

async fn removing_a_dataset_drops_the_membership(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let dataset_id = open_dataset(
        &store,
        &created.id,
        &owner,
        "source-a",
        "file:///data/a.zarr",
        "Alpha",
        1,
    )
    .await;

    store
        .persist_dataset_removed(&created.id, &dataset_id, 2, &DocumentState::default())
        .await
        .unwrap();

    assert!(
        store
            .list_dataset_sources(&created.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .dataset_by_workspace_dataset(&created.id, &dataset_id)
            .await
            .unwrap()
            .is_none()
    );
    let reread = store.get_workspace(&created.id).await.unwrap().unwrap();
    assert_eq!(reread.seq, 2);
    assert!(reread.document.manifests.is_empty());
}

async fn members_can_be_added_promoted_and_removed(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let added = store
        .upsert_member(
            &created.id,
            &colleague.email,
            &colleague.display_name,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(added.role, WorkspaceRole::Viewer);
    assert_eq!(
        store.role_for(&created.id, &colleague).await.unwrap(),
        Some(WorkspaceRole::Viewer),
    );

    let promoted = store
        .update_member_role(&created.id, &colleague.email, WorkspaceRole::Editor)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(promoted.role, WorkspaceRole::Editor);
    assert_eq!(
        promoted.display_name, added.display_name,
        "a role change is not a rename",
    );

    assert!(
        store
            .remove_member(&created.id, &colleague.email)
            .await
            .unwrap()
    );
    assert_eq!(store.role_for(&created.id, &colleague).await.unwrap(), None);
}

/// Inviting someone already in the workspace rewrites their row rather
/// than failing on the membership they already have.
async fn re_adding_a_member_replaces_the_role_and_the_name(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    store
        .upsert_member(
            &created.id,
            "colleague@example.com",
            "Colleague",
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap()
        .unwrap();

    let reinvited = store
        .upsert_member(
            &created.id,
            "colleague@example.com",
            "Colleague, renamed",
            WorkspaceRole::Editor,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reinvited.role, WorkspaceRole::Editor);
    assert_eq!(reinvited.display_name, "Colleague, renamed");

    let sharing = store.sharing_settings(&created.id).await.unwrap().unwrap();
    assert_eq!(sharing.members.len(), 2, "the owner and one colleague");
}

async fn member_emails_are_matched_case_insensitively(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    store
        .upsert_member(
            &created.id,
            "  Colleague@Example.COM  ",
            "Colleague",
            WorkspaceRole::Editor,
        )
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        store
            .role_for(&created.id, &member("colleague@example.com"))
            .await
            .unwrap(),
        Some(WorkspaceRole::Editor),
        "an invitation typed with different casing still names the person who signs in",
    );
    let sharing = store.sharing_settings(&created.id).await.unwrap().unwrap();
    assert!(
        sharing
            .members
            .iter()
            .any(|m| m.email == "colleague@example.com")
    );
}

async fn removing_an_absent_member_is_false(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    assert!(
        !store
            .remove_member(&created.id, "stranger@example.com")
            .await
            .unwrap()
    );
    assert!(
        store
            .update_member_role(&created.id, "stranger@example.com", WorkspaceRole::Editor)
            .await
            .unwrap()
            .is_none()
    );
}

async fn writing_a_member_into_an_absent_workspace_is_none(store: Arc<dyn WorkspaceStore>) {
    assert!(
        store
            .upsert_member(
                "never-created",
                "colleague@example.com",
                "Colleague",
                WorkspaceRole::Editor,
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .sharing_settings("never-created")
            .await
            .unwrap()
            .is_none()
    );
}

async fn link_access_reads_back_through_the_sharing_settings(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let stranger = member("stranger@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let opened = store
        .update_link_access(
            &created.id,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened.link_access, WorkspaceLinkAccess::AnyoneWithLink);
    assert_eq!(opened.link_role, WorkspaceRole::Editor);
    assert_eq!(
        store.role_for(&created.id, &stranger).await.unwrap(),
        Some(WorkspaceRole::Editor),
        "an open link is what gives a non-member a role",
    );

    store
        .update_link_access(
            &created.id,
            WorkspaceLinkAccess::Restricted,
            WorkspaceRole::Viewer,
        )
        .await
        .unwrap();
    assert_eq!(store.role_for(&created.id, &stranger).await.unwrap(), None);
    assert!(
        store
            .update_link_access(
                "never-created",
                WorkspaceLinkAccess::AnyoneWithLink,
                WorkspaceRole::Viewer,
            )
            .await
            .unwrap()
            .is_none()
    );
}

async fn a_saved_view_reads_back_and_is_scoped_to_its_workspace(store: Arc<dyn WorkspaceStore>) {
    let owner = member("Owner@Example.com");
    let here = workspace_named(&store, &owner, "Here").await;
    let there = workspace_named(&store, &owner, "There").await;
    let view = SavedView::empty([1024, 768]);

    let created = store
        .create_saved_view(
            &here.id,
            "Overview",
            &owner,
            view.clone(),
            SavedViewVisibility::Shared,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(created.created_by, "owner@example.com");
    assert_eq!(created.visibility, SavedViewVisibility::Shared);

    let found = store
        .get_saved_view(&here.id, &created.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.name, "Overview");
    assert_eq!(found.view, view);
    assert_eq!(found.created_at, created.created_at);

    assert!(
        store
            .get_saved_view(&there.id, &created.id)
            .await
            .unwrap()
            .is_none(),
        "a saved view belongs to one workspace, so its id does not resolve in another",
    );
    assert!(
        store
            .create_saved_view(
                "never-created",
                "Overview",
                &owner,
                view,
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap()
            .is_none()
    );
}

async fn saved_views_list_most_recently_updated_first(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let mut ids = Vec::new();
    for name in ["first", "second", "third"] {
        ids.push(shared_view(&store, &created.id, &owner, name).await.id);
    }

    let listed = listed_ids(&store, &created.id, &owner.email).await;
    assert_eq!(listed, [ids[2].clone(), ids[1].clone(), ids[0].clone()]);

    // An edit is what moves a view to the front, not its creation order.
    store
        .update_saved_view(&created.id, &ids[0], Some("first, edited"), None)
        .await
        .unwrap()
        .unwrap();
    let relisted = listed_ids(&store, &created.id, &owner.email).await;
    assert_eq!(relisted, [ids[0].clone(), ids[2].clone(), ids[1].clone()]);
}

async fn a_personal_view_stays_with_its_author(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let private = store
        .create_saved_view(
            &created.id,
            "Mine",
            &colleague,
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap()
        .unwrap();

    let author_sees = store
        .list_saved_views(&created.id, &colleague.email, false)
        .await
        .unwrap();
    assert_eq!(author_sees.len(), 1);
    assert_eq!(author_sees[0].id, private.id);

    for can_edit in [false, true] {
        assert!(
            store
                .list_saved_views(&created.id, &owner.email, can_edit)
                .await
                .unwrap()
                .is_empty(),
            "nobody else sees a personal view, editing rights included",
        );
    }
}

async fn an_editor_sees_every_proposed_view(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let onlooker = member("onlooker@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let proposal = store
        .create_saved_view(
            &created.id,
            "Worth sharing?",
            &colleague,
            SavedView::empty([800, 600]),
            SavedViewVisibility::Proposed,
        )
        .await
        .unwrap()
        .unwrap();

    let reviewer_sees = store
        .list_saved_views(&created.id, &owner.email, true)
        .await
        .unwrap();
    assert_eq!(reviewer_sees.len(), 1);
    assert_eq!(reviewer_sees[0].id, proposal.id);

    assert!(
        store
            .list_saved_views(&created.id, &onlooker.email, false)
            .await
            .unwrap()
            .is_empty(),
        "a proposal is a bid to share, not a share",
    );

    let shared = store
        .set_saved_view_visibility(&created.id, &proposal.id, SavedViewVisibility::Shared)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(shared.visibility, SavedViewVisibility::Shared);
    assert_eq!(
        shared.created_by, "colleague@example.com",
        "approving a proposal does not make the reviewer its author",
    );
    assert_eq!(
        store
            .list_saved_views(&created.id, &onlooker.email, false)
            .await
            .unwrap()
            .len(),
        1,
    );
}

/// The approval workflow, walked end to end: a member keeps a view to
/// themselves, bids to share it, an editor approves, and an editor sends
/// it back. Every hop re-scopes who can see the view and changes nothing
/// else about it.
async fn a_saved_view_survives_every_hop_between_the_three_visibilities(
    store: Arc<dyn WorkspaceStore>,
) {
    // Three people watching one view, and whether each can edit. The
    // reviewer can; the author and the onlooker cannot.
    const AUTHOR: (&str, bool) = ("author@example.com", false);
    const REVIEWER: (&str, bool) = ("reviewer@example.com", true);
    const ONLOOKER: (&str, bool) = ("onlooker@example.com", false);

    let created = workspace_named(&store, &member(REVIEWER.0), "Demo").await;
    let captured = SavedView::empty([1024, 768]);

    let personal = store
        .create_saved_view(
            &created.id,
            "Worth a look",
            &member(AUTHOR.0),
            captured.clone(),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap()
        .unwrap();

    /// Which of the three can see the view, in the order they are named
    /// above.
    async fn audience(
        store: &Arc<dyn WorkspaceStore>,
        workspace_id: &str,
        saved_view_id: &str,
        watchers: [(&str, bool); 3],
    ) -> (bool, bool, bool) {
        let mut seen = Vec::new();
        for (email, can_edit) in watchers {
            seen.push(
                store
                    .list_saved_views(workspace_id, email, can_edit)
                    .await
                    .unwrap()
                    .iter()
                    .any(|view| view.id == saved_view_id),
            );
        }
        (seen[0], seen[1], seen[2])
    }

    let watchers = [AUTHOR, REVIEWER, ONLOOKER];

    assert_eq!(
        audience(&store, &created.id, &personal.id, watchers).await,
        (true, false, false),
        "a personal view is its author's alone, editing rights included",
    );

    for (visibility, expected, why) in [
        (
            SavedViewVisibility::Proposed,
            (true, true, false),
            "a proposal reaches the review queue and nobody else",
        ),
        (
            SavedViewVisibility::Shared,
            (true, true, true),
            "approval puts the view in front of the whole workspace",
        ),
        (
            SavedViewVisibility::Personal,
            (true, false, false),
            "sending it back returns it to its author alone",
        ),
    ] {
        let moved = store
            .set_saved_view_visibility(&created.id, &personal.id, visibility)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(moved.visibility, visibility);
        assert_eq!(
            moved.created_by, "author@example.com",
            "a transition never re-attributes the view",
        );
        assert_eq!(moved.name, "Worth a look", "a transition is not a rename");
        assert_eq!(
            moved.view, captured,
            "a transition does not recapture the view",
        );
        assert_eq!(moved.created_at, personal.created_at);
        assert_eq!(
            audience(&store, &created.id, &personal.id, watchers).await,
            expected,
            "{why}"
        );
    }

    // The onlooker never gains editing rights, so the shared stop above is
    // the only one where they could read the payload back by id.
    let read_back = store
        .get_saved_view(&created.id, &personal.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read_back.view, captured);
    assert_eq!(read_back.visibility, SavedViewVisibility::Personal);
}

async fn re_scoping_an_absent_saved_view_is_none(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    assert!(
        store
            .set_saved_view_visibility(&created.id, "never-created", SavedViewVisibility::Shared)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .set_saved_view_visibility(
                "never-created",
                "never-created",
                SavedViewVisibility::Shared,
            )
            .await
            .unwrap()
            .is_none()
    );
}

async fn updating_a_saved_view_changes_only_what_was_passed(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let original = SavedView::empty([800, 600]);
    let view = shared_view(&store, &created.id, &owner, "Overview").await;

    let renamed = store
        .update_saved_view(&created.id, &view.id, Some("Overview, revised"), None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renamed.name, "Overview, revised");
    assert_eq!(
        renamed.view, original,
        "a rename does not recapture the view"
    );

    let recaptured = SavedView::empty([1024, 768]);
    let moved = store
        .update_saved_view(&created.id, &view.id, None, Some(recaptured.clone()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved.name, "Overview, revised");
    assert_eq!(moved.view, recaptured);

    assert!(
        store
            .update_saved_view(&created.id, "never-created", Some("x"), None)
            .await
            .unwrap()
            .is_none()
    );
}

async fn deleting_a_saved_view_clears_the_default_that_pointed_at_it(
    store: Arc<dyn WorkspaceStore>,
) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let view = shared_view(&store, &created.id, &owner, "Overview").await;
    let pointed = store
        .set_default_saved_view(&created.id, Some(&view.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        pointed.default_saved_view_id.as_deref(),
        Some(view.id.as_str())
    );

    assert!(
        store
            .delete_saved_view(&created.id, &view.id)
            .await
            .unwrap()
    );

    let reread = store.get_workspace(&created.id).await.unwrap().unwrap();
    assert!(
        reread.default_saved_view_id.is_none(),
        "the default cannot point at a view that no longer exists",
    );
    assert!(
        store
            .get_saved_view(&created.id, &view.id)
            .await
            .unwrap()
            .is_none()
    );
}

async fn deleting_an_absent_saved_view_is_false(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    assert!(
        !store
            .delete_saved_view(&created.id, "never-created")
            .await
            .unwrap()
    );
    assert!(
        !store
            .delete_saved_view("never-created", "never-created")
            .await
            .unwrap()
    );
}

async fn a_viewer_profile_is_private_to_one_member_and_profile(store: Arc<dyn WorkspaceStore>) {
    let owner = member("Owner@Example.com");
    let colleague = member("colleague@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let view = SavedView::empty([1024, 768]);

    let written = store
        .upsert_viewer_profile(&created.id, &owner, "default", Some("seed"), view.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(written.user_email, "owner@example.com");
    assert_eq!(written.seed_source.as_deref(), Some("seed"));
    assert_eq!(written.view, view);

    assert!(
        store
            .get_viewer_profile(&created.id, &colleague.email, "default")
            .await
            .unwrap()
            .is_none(),
        "a viewer profile is one member's own headless state",
    );
    assert!(
        store
            .get_viewer_profile(&created.id, &owner.email, "another")
            .await
            .unwrap()
            .is_none()
    );

    // Passing no seed leaves the one the slot was first opened from
    // rather than clearing it.
    let replaced = SavedView::empty([640, 480]);
    let updated = store
        .upsert_viewer_profile(&created.id, &owner, "default", None, replaced.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.view, replaced);
    assert_eq!(updated.seed_source.as_deref(), Some("seed"));
}

async fn opening_and_pinning_are_recorded_per_member(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let opened = store
        .record_workspace_open(&created.id, &owner)
        .await
        .unwrap();
    assert!(opened.last_opened_at.is_some());
    assert!(opened.pinned_at.is_none());

    let pinned = store
        .set_workspace_pinned(&created.id, &owner, true)
        .await
        .unwrap();
    assert!(pinned.pinned_at.is_some());
    assert!(
        pinned.last_opened_at.is_some(),
        "pinning does not forget when the workspace was last opened",
    );

    let theirs = store
        .get_user_workspace_state_for(&created.id, &colleague)
        .await
        .unwrap();
    assert!(theirs.last_opened_at.is_none());
    assert!(theirs.pinned_at.is_none());

    let unpinned = store
        .set_workspace_pinned(&created.id, &owner, false)
        .await
        .unwrap();
    assert!(unpinned.pinned_at.is_none());
}

/// A member's dashboard state is three independent facts in one row —
/// when they last opened the workspace, whether they pinned it, and where
/// they left off — and each is written by a call that must not disturb the
/// other two, however many times it runs.
async fn each_write_of_one_members_state_leaves_the_rest_of_it_alone(
    store: Arc<dyn WorkspaceStore>,
) {
    let owner = member("owner@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;

    let opened = store
        .record_workspace_open(&created.id, &owner)
        .await
        .unwrap();
    let first_open = opened.last_opened_at.unwrap();
    store
        .set_workspace_pinned(&created.id, &owner, true)
        .await
        .unwrap();

    let first = SavedView::empty([800, 600]);
    let state = store
        .set_user_workspace_last_view(&created.id, &owner, first.clone())
        .await
        .unwrap();
    assert_eq!(state.last_view.as_ref(), Some(&first));
    assert_eq!(state.last_opened_at, Some(first_open));
    assert!(state.pinned_at.is_some());

    // The same call again replaces only the view.
    let second = SavedView::empty([1024, 768]);
    let state = store
        .set_user_workspace_last_view(&created.id, &owner, second.clone())
        .await
        .unwrap();
    assert_eq!(state.last_view.as_ref(), Some(&second));
    assert_eq!(state.last_opened_at, Some(first_open));
    assert!(state.pinned_at.is_some());

    // Reopening moves the recent mark and leaves the pin and the view.
    let reopened = store
        .record_workspace_open(&created.id, &owner)
        .await
        .unwrap();
    assert!(reopened.last_opened_at.unwrap() >= first_open);
    assert!(reopened.pinned_at.is_some());
    assert_eq!(reopened.last_view.as_ref(), Some(&second));

    // Unpinning keeps the row, because it still records something.
    let unpinned = store
        .set_workspace_pinned(&created.id, &owner, false)
        .await
        .unwrap();
    assert!(unpinned.pinned_at.is_none());
    assert!(unpinned.last_opened_at.is_some());
    assert_eq!(unpinned.last_view.as_ref(), Some(&second));
}

async fn recording_a_last_view_leaves_the_shared_default_alone(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let created = workspace_named(&store, &owner, "Demo").await;
    let shared = shared_view(&store, &created.id, &owner, "Overview").await;
    store
        .set_default_saved_view(&created.id, Some(&shared.id))
        .await
        .unwrap();

    let mine = SavedView::empty([1024, 768]);
    let state = store
        .set_user_workspace_last_view(&created.id, &owner, mine.clone())
        .await
        .unwrap();
    assert_eq!(state.last_view.as_ref(), Some(&mine));

    assert_eq!(
        store
            .get_workspace(&created.id)
            .await
            .unwrap()
            .unwrap()
            .default_saved_view_id
            .as_deref(),
        Some(shared.id.as_str()),
        "where one member left off is not what the workspace opens on for everyone",
    );
    assert!(
        store
            .get_user_workspace_state_for(&created.id, &colleague)
            .await
            .unwrap()
            .last_view
            .is_none()
    );
}

async fn duplicating_copies_the_content_and_none_of_the_sharing(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    let colleague = member("colleague@example.com");
    let source = workspace_named(&store, &owner, "Source").await;
    let alpha = open_dataset(
        &store,
        &source.id,
        &owner,
        "source-a",
        "file:///data/a.zarr",
        "Alpha",
        1,
    )
    .await;
    let shared = shared_view(&store, &source.id, &owner, "Overview").await;
    store
        .create_saved_view(
            &source.id,
            "Mine",
            &colleague,
            SavedView::empty([800, 600]),
            SavedViewVisibility::Personal,
        )
        .await
        .unwrap();
    store
        .set_default_saved_view(&source.id, Some(&shared.id))
        .await
        .unwrap();
    store
        .upsert_member(
            &source.id,
            &colleague.email,
            &colleague.display_name,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();
    store
        .update_link_access(
            &source.id,
            WorkspaceLinkAccess::AnyoneWithLink,
            WorkspaceRole::Editor,
        )
        .await
        .unwrap();

    let copy = store
        .duplicate_workspace(&source.id, &colleague, "Copy of Source")
        .await
        .unwrap()
        .unwrap();

    assert_eq!(copy.name, "Copy of Source");
    assert_eq!(copy.created_by, "colleague@example.com");
    assert_ne!(copy.id, source.id);

    // The content comes across under the copy's own dataset ids.
    let copied_datasets = store.list_dataset_sources(&copy.id).await.unwrap();
    assert_eq!(copied_datasets.len(), 1);
    assert_eq!(copied_datasets[0].canonical_url, "file:///data/a.zarr");
    assert_eq!(copied_datasets[0].display_name, "Alpha");
    let copied_dataset_id = copied_datasets[0].workspace_dataset_id.clone();
    assert_ne!(copied_dataset_id, alpha);
    assert!(copy.document.manifests.contains_key(&copied_dataset_id));
    assert!(!copy.document.manifests.contains_key(&alpha));

    let copied_views = store
        .list_saved_views(&copy.id, &colleague.email, true)
        .await
        .unwrap();
    assert_eq!(copied_views.len(), 1, "only shared views are copied");
    assert_eq!(copied_views[0].name, "Overview");
    assert_eq!(
        copied_views[0].created_by, "colleague@example.com",
        "a copied view is attributed to whoever made the copy",
    );
    assert_eq!(
        copy.default_saved_view_id.as_deref(),
        Some(copied_views[0].id.as_str()),
        "the copy's default points at the copy's own view",
    );

    let sharing = store.sharing_settings(&copy.id).await.unwrap().unwrap();
    assert_eq!(sharing.link_access, WorkspaceLinkAccess::Restricted);
    assert_eq!(sharing.members.len(), 1);
    assert_eq!(sharing.members[0].email, "colleague@example.com");
    assert_eq!(
        store.role_for(&copy.id, &owner).await.unwrap(),
        None,
        "the source's members are not the copy's members",
    );

    // The source is left as it was.
    assert_eq!(
        store
            .get_workspace(&source.id)
            .await
            .unwrap()
            .unwrap()
            .default_saved_view_id
            .as_deref(),
        Some(shared.id.as_str()),
    );
    assert_eq!(
        store
            .list_saved_views(&source.id, &colleague.email, true)
            .await
            .unwrap()
            .len(),
        2,
    );
}

async fn duplicating_an_absent_workspace_is_none(store: Arc<dyn WorkspaceStore>) {
    let owner = member("owner@example.com");
    assert!(
        store
            .duplicate_workspace("never-created", &owner, "Copy")
            .await
            .unwrap()
            .is_none()
    );
}
