//! Finite, truthful ownership for durable mutations.
//!
//! A backend issues a [`PersistenceOperation`] instead of lending its raw
//! future to a request. The operation has a finite deadline. On expiry it
//! aborts only that backend-owned worker, runs a separately bounded backend
//! quiescence barrier, and returns an indeterminate result with an operation
//! identity. Callers can then fail-close before releasing heavyweight session,
//! revocation, broadcast, and terminal guards without ever claiming that a
//! write failed while it may have committed.

use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
#[cfg(test)]
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
#[cfg(test)]
use std::{collections::HashSet, sync::PoisonError};

use tokio::sync::oneshot;

const MIN_PERSISTENCE_DEADLINE: Duration = Duration::from_millis(1);
const MAX_PERSISTENCE_DEADLINE: Duration = Duration::from_secs(30);
pub const DEFAULT_PERSISTENCE_DEADLINE: Duration = Duration::from_secs(5);

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_OPERATIONS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_BACKEND_WORKERS: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static ACTIVE_OPERATION_IDS: LazyLock<Mutex<HashSet<PersistenceOperationId>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
#[cfg(test)]
static ACTIVE_BACKEND_WORKER_IDS: LazyLock<Mutex<HashSet<PersistenceOperationId>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

struct ActivityGuard(&'static AtomicUsize);

impl ActivityGuard {
    fn acquire(counter: &'static AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(counter)
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct OperationResourceGuard {
    #[cfg(test)]
    operation_id: PersistenceOperationId,
    #[cfg(test)]
    backend_worker: bool,
}

impl OperationResourceGuard {
    fn acquire(operation_id: PersistenceOperationId, backend_worker: bool) -> Self {
        #[cfg(test)]
        {
            let active = if backend_worker {
                &ACTIVE_BACKEND_WORKER_IDS
            } else {
                &ACTIVE_OPERATION_IDS
            };
            active
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(operation_id);
        }
        #[cfg(not(test))]
        let _ = (operation_id, backend_worker);
        Self {
            #[cfg(test)]
            operation_id,
            #[cfg(test)]
            backend_worker,
        }
    }
}

impl Drop for OperationResourceGuard {
    fn drop(&mut self) {
        #[cfg(test)]
        {
            let active = if self.backend_worker {
                &ACTIVE_BACKEND_WORKER_IDS
            } else {
                &ACTIVE_OPERATION_IDS
            };
            active
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.operation_id);
        }
    }
}

/// A non-zero, process-bounded deadline. Construction clamps every backend
/// choice into `[1ms, 30s]`, so a trait implementation cannot accidentally
/// issue an unbounded accepted mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PersistenceDeadline(Duration);

impl PersistenceDeadline {
    pub fn bounded(duration: Duration) -> Self {
        Self(duration.clamp(MIN_PERSISTENCE_DEADLINE, MAX_PERSISTENCE_DEADLINE))
    }

    pub fn duration(self) -> Duration {
        self.0
    }
}

impl Default for PersistenceDeadline {
    fn default() -> Self {
        Self(DEFAULT_PERSISTENCE_DEADLINE)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PersistenceOperationId(u64);

impl PersistenceOperationId {
    fn next() -> Self {
        let mut id = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        if id == 0 {
            id = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
        }
        Self(id)
    }
}

impl fmt::Display for PersistenceOperationId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "persist-{}", self.0)
    }
}

/// Whether in-process durable reads are safe after an indeterminate outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistenceRecoveryDisposition {
    /// The backend's cancellation/quiescence barrier completed. No work from
    /// this operation can commit after the caller's next durable read.
    Quiesced,
    /// Quiescence could not be proved within its own finite deadline. The
    /// affected scope must remain fail-closed for this process. No task or
    /// future is retained; after restart the first restore reads final durable
    /// state before creating a live runtime.
    RestartRequired,
}

#[derive(Debug)]
pub enum PersistenceWorkerOutcome<T, E> {
    Committed(T),
    DefinitelyNotCommitted(E),
    RecoverablyIndeterminate(E),
}

#[derive(Debug)]
pub enum PersistenceIndeterminateCause<E> {
    Backend(E),
    DeadlineExceeded { deadline: Duration },
    WorkerLost(String),
}

#[derive(Debug)]
pub struct PersistenceIndeterminate<E> {
    operation_id: PersistenceOperationId,
    cause: PersistenceIndeterminateCause<E>,
    recovery: PersistenceRecoveryDisposition,
    deadline: PersistenceDeadline,
}

impl<E> PersistenceIndeterminate<E> {
    pub fn operation_id(&self) -> PersistenceOperationId {
        self.operation_id
    }

    pub fn cause(&self) -> &PersistenceIndeterminateCause<E> {
        &self.cause
    }

    pub fn recovery(&self) -> PersistenceRecoveryDisposition {
        self.recovery
    }

    pub fn deadline(&self) -> PersistenceDeadline {
        self.deadline
    }

    pub fn into_parts(
        self,
    ) -> (
        PersistenceOperationId,
        PersistenceIndeterminateCause<E>,
        PersistenceRecoveryDisposition,
        PersistenceDeadline,
    ) {
        (self.operation_id, self.cause, self.recovery, self.deadline)
    }

    #[cfg(test)]
    pub(crate) fn resolved_backend(error: E) -> Self {
        Self {
            operation_id: PersistenceOperationId::next(),
            cause: PersistenceIndeterminateCause::Backend(error),
            recovery: PersistenceRecoveryDisposition::Quiesced,
            deadline: PersistenceDeadline::default(),
        }
    }
}

impl<E: fmt::Display> fmt::Display for PersistenceIndeterminate<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "operation {}: ", self.operation_id)?;
        match &self.cause {
            PersistenceIndeterminateCause::Backend(error) => write!(formatter, "{error}"),
            PersistenceIndeterminateCause::DeadlineExceeded { deadline } => {
                write!(formatter, "deadline exceeded after {deadline:?}")
            }
            PersistenceIndeterminateCause::WorkerLost(error) => {
                write!(formatter, "backend worker lost: {error}")
            }
        }
    }
}

#[derive(Debug)]
pub enum PersistenceCompletion<T, E> {
    Committed(T),
    DefinitelyNotCommitted(E),
    RecoverablyIndeterminate(PersistenceIndeterminate<E>),
}

/// Backend-issued finite handle. Both the mutation and its quiescence barrier
/// are backend-owned. A handle cannot be constructed without finite deadlines
/// for both phases.
pub struct PersistenceOperation<T, E> {
    operation_id: PersistenceOperationId,
    deadline: PersistenceDeadline,
    result: oneshot::Receiver<PersistenceCompletion<T, E>>,
}

impl<T, E> fmt::Debug for PersistenceOperation<T, E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PersistenceOperation")
            .field("operation_id", &self.operation_id)
            .finish_non_exhaustive()
    }
}

impl<T, E> PersistenceOperation<T, E>
where
    T: Send + 'static,
    E: Send + 'static,
{
    pub fn spawn<F, R, RF>(deadline: PersistenceDeadline, worker: F, recover: R) -> Self
    where
        F: Future<Output = PersistenceWorkerOutcome<T, E>> + Send + 'static,
        R: FnOnce() -> RF + Send + 'static,
        RF: Future<Output = bool> + Send + 'static,
    {
        let operation_id = PersistenceOperationId::next();
        let (result_tx, result) = oneshot::channel();
        let mut worker = tokio::spawn(async move {
            let _activity = ActivityGuard::acquire(&ACTIVE_BACKEND_WORKERS);
            let _resource = OperationResourceGuard::acquire(operation_id, true);
            worker.await
        });
        tokio::spawn(async move {
            let activity = ActivityGuard::acquire(&ACTIVE_OPERATIONS);
            let resource = OperationResourceGuard::acquire(operation_id, false);
            let (cause, worker_stopped) = tokio::select! {
                joined = &mut worker => {
                    match joined {
                        Ok(PersistenceWorkerOutcome::Committed(value)) => {
                            drop(resource);
                            drop(activity);
                            let _ = result_tx.send(PersistenceCompletion::Committed(value));
                            return;
                        }
                        Ok(PersistenceWorkerOutcome::DefinitelyNotCommitted(error)) => {
                            drop(resource);
                            drop(activity);
                            let _ = result_tx.send(
                                PersistenceCompletion::DefinitelyNotCommitted(error),
                            );
                            return;
                        }
                        Ok(PersistenceWorkerOutcome::RecoverablyIndeterminate(error)) => {
                            (PersistenceIndeterminateCause::Backend(error), true)
                        }
                        Err(error) => {
                            (
                                PersistenceIndeterminateCause::WorkerLost(error.to_string()),
                                true,
                            )
                        }
                    }
                }
                () = tokio::time::sleep(deadline.duration()) => {
                    worker.abort();
                    let worker_stopped = tokio::time::timeout(deadline.duration(), &mut worker)
                        .await
                        .is_ok();
                    (
                        PersistenceIndeterminateCause::DeadlineExceeded {
                            deadline: deadline.duration(),
                        },
                        worker_stopped,
                    )
                }
            };
            let recovery = if worker_stopped {
                bounded_recovery(deadline, recover).await
            } else {
                PersistenceRecoveryDisposition::RestartRequired
            };
            let completion =
                PersistenceCompletion::RecoverablyIndeterminate(PersistenceIndeterminate {
                    operation_id,
                    cause,
                    recovery,
                    deadline,
                });
            // Release operation-scoped accounting before waking the caller.
            // A resolved completion must never race a still-held controller
            // guard, including the recoverably-indeterminate path.
            drop(resource);
            drop(activity);
            let _ = result_tx.send(completion);
        });
        Self {
            operation_id,
            deadline,
            result,
        }
    }

    pub fn ready(outcome: PersistenceWorkerOutcome<T, E>) -> Self {
        let operation_id = PersistenceOperationId::next();
        let (result_tx, result) = oneshot::channel();
        let completion = match outcome {
            PersistenceWorkerOutcome::Committed(value) => PersistenceCompletion::Committed(value),
            PersistenceWorkerOutcome::DefinitelyNotCommitted(error) => {
                PersistenceCompletion::DefinitelyNotCommitted(error)
            }
            PersistenceWorkerOutcome::RecoverablyIndeterminate(error) => {
                PersistenceCompletion::RecoverablyIndeterminate(PersistenceIndeterminate {
                    operation_id,
                    cause: PersistenceIndeterminateCause::Backend(error),
                    recovery: PersistenceRecoveryDisposition::Quiesced,
                    deadline: PersistenceDeadline::default(),
                })
            }
        };
        let _ = result_tx.send(completion);
        Self {
            operation_id,
            deadline: PersistenceDeadline::default(),
            result,
        }
    }

    pub fn operation_id(&self) -> PersistenceOperationId {
        self.operation_id
    }

    pub async fn resolve(self) -> PersistenceCompletion<T, E> {
        match self.result.await {
            Ok(completion) => completion,
            Err(error) => {
                PersistenceCompletion::RecoverablyIndeterminate(PersistenceIndeterminate {
                    operation_id: self.operation_id,
                    cause: PersistenceIndeterminateCause::WorkerLost(error.to_string()),
                    recovery: PersistenceRecoveryDisposition::RestartRequired,
                    deadline: self.deadline,
                })
            }
        }
    }
}

async fn bounded_recovery<R, RF>(
    deadline: PersistenceDeadline,
    recover: R,
) -> PersistenceRecoveryDisposition
where
    R: FnOnce() -> RF,
    RF: Future<Output = bool>,
{
    match tokio::time::timeout(deadline.duration(), recover()).await {
        Ok(true) => PersistenceRecoveryDisposition::Quiesced,
        Ok(false) | Err(_) => PersistenceRecoveryDisposition::RestartRequired,
    }
}

#[cfg(test)]
pub(crate) fn persistence_operation_resources(
    operation_id: PersistenceOperationId,
) -> (bool, bool) {
    (
        ACTIVE_OPERATION_IDS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&operation_id),
        ACTIVE_BACKEND_WORKER_IDS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&operation_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn never_completing_worker_is_aborted_and_resources_return_to_baseline() {
        let operation = PersistenceOperation::<(), &'static str>::spawn(
            PersistenceDeadline::bounded(Duration::from_millis(10)),
            std::future::pending(),
            || async { true },
        );
        let started = tokio::time::Instant::now();
        let completion = operation.resolve().await;
        assert!(started.elapsed() < Duration::from_millis(250));
        let PersistenceCompletion::RecoverablyIndeterminate(indeterminate) = completion else {
            panic!("deadline must not claim commit or non-commit");
        };
        let operation_id = indeterminate.operation_id();
        assert_eq!(
            indeterminate.recovery(),
            PersistenceRecoveryDisposition::Quiesced
        );
        tokio::time::timeout(Duration::from_millis(100), async {
            while persistence_operation_resources(operation_id) != (false, false) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("operation-specific resources must return to baseline");
    }
}
