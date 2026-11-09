//! `LUCIDA_METADATA_READ_CONCURRENCY` sizes the metadata-read cap of every
//! store. The cap is read once per process, so this test has a binary of its
//! own, where nothing has built a store before it sets the variable.

use std::sync::Arc;

use lucida_store::cache::CachedStore;

#[test]
fn the_metadata_read_cap_follows_its_setting() {
    // SAFETY: the only test in this binary, so no other thread reads the
    // environment while it is written.
    unsafe { std::env::set_var("LUCIDA_METADATA_READ_CONCURRENCY", "12") };

    let store = CachedStore::new(Arc::new(object_store::memory::InMemory::new()), 1024);

    assert_eq!(store.metadata_read_concurrency(), 12);
}
