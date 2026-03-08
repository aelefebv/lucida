use std::collections::{HashMap, VecDeque};

use lucida_core::command::Command;
use lucida_core::protocol::ServerMessage;
use lucida_core::scene::Scene;

const HISTORY_CAPACITY: usize = 256;

pub struct Session {
    pub scene: Scene,
    pub seq: u64,
    history: VecDeque<(u64, Command)>,
    /// Maps dataset_id → client_id of the data source.
    pub data_sources: HashMap<String, u64>,
}

impl Session {
    pub fn new(viewport: [u32; 2]) -> Self {
        Self {
            scene: Scene::new(viewport),
            seq: 0,
            history: VecDeque::with_capacity(HISTORY_CAPACITY),
            data_sources: HashMap::new(),
        }
    }

    pub fn snapshot(&self) -> ServerMessage {
        ServerMessage::Snapshot {
            seq: self.seq,
            scene: self.scene.clone(),
        }
    }

    pub fn apply(&mut self, cmd: Command) -> u64 {
        self.scene.apply(cmd.clone());
        self.seq += 1;
        if self.history.len() == HISTORY_CAPACITY {
            self.history.pop_front();
        }
        self.history.push_back((self.seq, cmd));
        self.seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lucida_core::camera::Camera;

    #[test]
    fn new_session_starts_at_seq_zero() {
        let session = Session::new([800, 600]);
        assert_eq!(session.seq, 0);
    }

    #[test]
    fn apply_increments_seq() {
        let mut session = Session::new([800, 600]);
        let seq = session.apply(Command::Pan { dx: 10.0, dy: 0.0 });
        assert_eq!(seq, 1);
        let seq = session.apply(Command::Pan { dx: 5.0, dy: 0.0 });
        assert_eq!(seq, 2);
    }

    #[test]
    fn apply_mutates_scene() {
        let mut session = Session::new([800, 600]);
        session.apply(Command::Pan { dx: 100.0, dy: 0.0 });
        if let Camera::View2D(v) = &session.scene.camera {
            assert_eq!(v.center, [100.0, 0.0]);
        } else {
            panic!("expected View2D");
        }
    }

    #[test]
    fn snapshot_contains_current_state() {
        let mut session = Session::new([800, 600]);
        session.apply(Command::SetZ { z: 42 });
        let msg = session.snapshot();
        match msg {
            ServerMessage::Snapshot { seq, scene } => {
                assert_eq!(seq, 1);
                assert_eq!(scene.view.z_range, 42..43);
            }
            _ => panic!("expected Snapshot"),
        }
    }

    #[test]
    fn history_ring_buffer_caps_at_256() {
        let mut session = Session::new([800, 600]);
        for i in 0..300 {
            session.apply(Command::SetZ { z: i });
        }
        assert_eq!(session.history.len(), HISTORY_CAPACITY);
        // Oldest entry should be seq 45 (first 44 evicted: 300-256=44, so seq 45..300)
        assert_eq!(session.history.front().unwrap().0, 45);
    }
}
