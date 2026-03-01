#[derive(Debug, Default)]
pub struct RevisionAllocator;

impl RevisionAllocator {
    pub fn next_session_rev(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }

    pub fn next_scene_rev(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }

    pub fn next_view_rev(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }

    pub fn next_layer_rev(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }

    pub fn next_metadata_rev(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }

    pub fn next_write_rev(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }

    pub fn next_generation_seq(current: &mut u64) -> u64 {
        *current += 1;
        *current
    }
}

#[cfg(test)]
mod tests {
    use super::RevisionAllocator;

    #[test]
    fn revision_allocator_increments_monotonically() {
        let mut rev = 0;

        assert_eq!(RevisionAllocator::next_session_rev(&mut rev), 1);
        assert_eq!(RevisionAllocator::next_session_rev(&mut rev), 2);
    }

    #[test]
    fn revision_families_are_independent_when_backed_by_distinct_fields() {
        let mut scene_rev = 0;
        let mut view_rev = 0;

        assert_eq!(RevisionAllocator::next_scene_rev(&mut scene_rev), 1);
        assert_eq!(RevisionAllocator::next_view_rev(&mut view_rev), 1);
        assert_eq!(RevisionAllocator::next_scene_rev(&mut scene_rev), 2);
        assert_eq!(RevisionAllocator::next_view_rev(&mut view_rev), 2);
    }
}
