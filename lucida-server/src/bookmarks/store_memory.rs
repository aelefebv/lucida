//! In-memory `BookmarkStore`, for tests.
//!
//! Lives behind a regular module (not `cfg(test)`) so integration tests
//! in `tests/` can construct it without dragging in a database.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Mutex;

use lucida_core::saved_view::SavedView;

use super::store::{Bookmark, BookmarkStore, StoreError, attachment_set};

/// Test-only in-memory implementation. Mutex is uncontended in tests;
/// the overhead is irrelevant.
///
/// The `BookmarkStore` conformance suite in [`crate::storage`] runs
/// against this store and the SQL ones, so they all answer alike.
#[derive(Debug, Default)]
pub struct MemoryBookmarkStore {
    rows: Mutex<HashMap<String, Bookmark>>,
}

impl MemoryBookmarkStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.rows
            .lock()
            .expect("memory bookmark store mutex poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[async_trait]
impl BookmarkStore for MemoryBookmarkStore {
    async fn create(
        &self,
        name: &str,
        created_by: &str,
        created_by_name: &str,
        datasets: Vec<String>,
        view: SavedView,
    ) -> Result<Bookmark, StoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        let bookmark = Bookmark {
            id: id.clone(),
            name: name.to_string(),
            created_by: created_by.to_string(),
            created_by_name: created_by_name.to_string(),
            created_at: Utc::now(),
            datasets: attachment_set(datasets),
            view,
        };
        let mut rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        rows.insert(id, bookmark.clone());
        Ok(bookmark)
    }

    async fn get(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        let rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        Ok(rows.get(id).cloned())
    }

    async fn list_by_dataset_overlap(
        &self,
        dataset_urls: &[String],
    ) -> Result<Vec<Bookmark>, StoreError> {
        if dataset_urls.is_empty() {
            return self.list_all().await;
        }
        let needle: std::collections::HashSet<&str> =
            dataset_urls.iter().map(String::as_str).collect();
        let rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        let mut out: Vec<Bookmark> = rows
            .values()
            .filter(|b| b.datasets.iter().any(|u| needle.contains(u.as_str())))
            .cloned()
            .collect();
        out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(out)
    }

    async fn list_all(&self) -> Result<Vec<Bookmark>, StoreError> {
        let rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        let mut out: Vec<Bookmark> = rows.values().cloned().collect();
        out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(out)
    }

    async fn patch_name(&self, id: &str, new_name: &str) -> Result<Option<Bookmark>, StoreError> {
        let mut rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        let Some(row) = rows.get_mut(id) else {
            return Ok(None);
        };
        row.name = new_name.to_string();
        Ok(Some(row.clone()))
    }

    async fn delete(&self, id: &str) -> Result<Option<Bookmark>, StoreError> {
        let mut rows = self
            .rows
            .lock()
            .expect("memory bookmark store mutex poisoned");
        Ok(rows.remove(id))
    }
}
