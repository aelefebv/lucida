//! Hard process-resident byte accounting shared by source caching, decode
//! work, and generated chunks.
//!
//! A reservation is RAII-owned: cancellation, early returns, and panics all
//! release their bytes. The total is claimed with one compare-and-swap before
//! category accounting changes, so concurrent categories can never jointly
//! exceed the configured ceiling.

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;

/// Resident byte classes exposed in process-budget telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum MemoryCategory {
    SourceCached = 0,
    SourceInFlight = 1,
    Decoded = 2,
    GeneratedReady = 3,
    MetadataParsed = 4,
}

impl MemoryCategory {
    const COUNT: usize = 5;

    const fn index(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MemoryBudgetSnapshot {
    pub max_bytes: usize,
    pub total_bytes: usize,
    pub source_cached_bytes: usize,
    pub source_in_flight_bytes: usize,
    pub decoded_bytes: usize,
    pub generated_ready_bytes: usize,
    pub metadata_parsed_bytes: usize,
    pub rejected_reservations: u64,
}

/// One hard ceiling for all configured resident byte categories.
pub struct MemoryBudget {
    max_bytes: usize,
    total: AtomicUsize,
    categories: [AtomicUsize; MemoryCategory::COUNT],
    rejected: AtomicUsize,
}

impl fmt::Debug for MemoryBudget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryBudget")
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

impl MemoryBudget {
    pub fn new(max_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            max_bytes,
            total: AtomicUsize::new(0),
            categories: [
                AtomicUsize::new(0),
                AtomicUsize::new(0),
                AtomicUsize::new(0),
                AtomicUsize::new(0),
                AtomicUsize::new(0),
            ],
            rejected: AtomicUsize::new(0),
        })
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Claim bytes without ever crossing the process ceiling.
    pub fn try_reserve(
        self: &Arc<Self>,
        category: MemoryCategory,
        bytes: usize,
    ) -> Option<MemoryReservation> {
        let mut observed = self.total.load(Ordering::Acquire);
        loop {
            let next = match observed.checked_add(bytes) {
                Some(next) if next <= self.max_bytes => next,
                _ => {
                    self.rejected.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
            };
            match self.total.compare_exchange_weak(
                observed,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => observed = actual,
            }
        }
        self.categories[category.index()].fetch_add(bytes, Ordering::AcqRel);
        Some(MemoryReservation {
            budget: Arc::clone(self),
            category,
            bytes,
            active: true,
        })
    }

    pub fn snapshot(&self) -> MemoryBudgetSnapshot {
        MemoryBudgetSnapshot {
            max_bytes: self.max_bytes,
            total_bytes: self.total.load(Ordering::Acquire),
            source_cached_bytes: self.categories[MemoryCategory::SourceCached.index()]
                .load(Ordering::Acquire),
            source_in_flight_bytes: self.categories[MemoryCategory::SourceInFlight.index()]
                .load(Ordering::Acquire),
            decoded_bytes: self.categories[MemoryCategory::Decoded.index()].load(Ordering::Acquire),
            generated_ready_bytes: self.categories[MemoryCategory::GeneratedReady.index()]
                .load(Ordering::Acquire),
            metadata_parsed_bytes: self.categories[MemoryCategory::MetadataParsed.index()]
                .load(Ordering::Acquire),
            rejected_reservations: self.rejected.load(Ordering::Relaxed) as u64,
        }
    }
}

/// An owned claim against [`MemoryBudget`].
pub struct MemoryReservation {
    budget: Arc<MemoryBudget>,
    category: MemoryCategory,
    bytes: usize,
    active: bool,
}

impl fmt::Debug for MemoryReservation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryReservation")
            .field("category", &self.category)
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}

impl MemoryReservation {
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Transfer the same bytes between telemetry categories without changing
    /// the hard total (used when an in-flight source body becomes cached).
    pub fn reclassify(&mut self, category: MemoryCategory) {
        if self.category == category {
            return;
        }
        self.budget.categories[self.category.index()].fetch_sub(self.bytes, Ordering::AcqRel);
        self.budget.categories[category.index()].fetch_add(self.bytes, Ordering::AcqRel);
        self.category = category;
    }

    /// Permanently release an unused suffix of this reservation.
    pub fn shrink_to(&mut self, bytes: usize) {
        assert!(bytes <= self.bytes, "reservation cannot grow via shrink_to");
        let released = self.bytes - bytes;
        if released == 0 {
            return;
        }
        self.budget.categories[self.category.index()].fetch_sub(released, Ordering::AcqRel);
        self.budget.total.fetch_sub(released, Ordering::AcqRel);
        self.bytes = bytes;
    }
}

impl Drop for MemoryReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        self.budget.categories[self.category.index()].fetch_sub(self.bytes, Ordering::AcqRel);
        self.budget.total.fetch_sub(self.bytes, Ordering::AcqRel);
        self.active = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservations_are_hard_bounded_reclassified_and_raii_released() {
        let budget = MemoryBudget::new(10);
        let mut first = budget
            .try_reserve(MemoryCategory::SourceInFlight, 7)
            .unwrap();
        assert!(
            budget
                .try_reserve(MemoryCategory::GeneratedReady, 4)
                .is_none()
        );
        first.reclassify(MemoryCategory::SourceCached);
        let snapshot = budget.snapshot();
        assert_eq!(snapshot.total_bytes, 7);
        assert_eq!(snapshot.source_in_flight_bytes, 0);
        assert_eq!(snapshot.source_cached_bytes, 7);
        assert_eq!(snapshot.rejected_reservations, 1);
        drop(first);
        assert_eq!(budget.snapshot().total_bytes, 0);
    }

    #[test]
    fn concurrent_categories_never_jointly_cross_ceiling() {
        let budget = MemoryBudget::new(64);
        std::thread::scope(|scope| {
            for category in [
                MemoryCategory::SourceCached,
                MemoryCategory::SourceInFlight,
                MemoryCategory::Decoded,
                MemoryCategory::GeneratedReady,
                MemoryCategory::MetadataParsed,
            ] {
                let budget = Arc::clone(&budget);
                scope.spawn(move || {
                    for _ in 0..1_000 {
                        if let Some(reservation) = budget.try_reserve(category, 8) {
                            assert!(budget.snapshot().total_bytes <= 64);
                            std::hint::black_box(&reservation);
                        }
                    }
                });
            }
        });
        assert_eq!(budget.snapshot().total_bytes, 0);
    }
}
