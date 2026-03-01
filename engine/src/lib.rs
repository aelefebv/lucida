#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub session_rev: u64,
}

#[derive(Debug, Default)]
pub struct SessionService {
    next_session_index: u64,
    next_session_rev: u64,
}

impl SessionService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_session(&mut self) -> SessionSnapshot {
        self.next_session_index += 1;
        self.next_session_rev += 1;

        SessionSnapshot {
            session_id: format!("sess_{:08}", self.next_session_index),
            session_rev: self.next_session_rev,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionService;

    #[test]
    fn create_session_returns_monotonic_revisions() {
        let mut service = SessionService::new();

        let first = service.create_session();
        let second = service.create_session();

        assert_eq!(first.session_rev, 1);
        assert_eq!(second.session_rev, 2);
        assert_ne!(first.session_id, second.session_id);
    }
}
