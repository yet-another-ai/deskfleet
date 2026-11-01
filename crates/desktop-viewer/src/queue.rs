//! Only decoded, uncommitted frames may be replaced. Presentation owns a frame
//! after removing it, so a later arrival cannot replace a committed frame.

use std::collections::VecDeque;

const CANDIDATE_CAPACITY: usize = 2;

#[derive(Debug)]
pub(crate) struct FrameQueue<T> {
    frames: VecDeque<T>,
    pub(crate) received: u64,
    pub(crate) dropped: u64,
    pub(crate) max_candidates: usize,
}

impl<T> Default for FrameQueue<T> {
    fn default() -> Self {
        Self {
            frames: VecDeque::with_capacity(CANDIDATE_CAPACITY),
            received: 0,
            dropped: 0,
            max_candidates: 0,
        }
    }
}

impl<T> FrameQueue<T> {
    pub(crate) fn push(&mut self, frame: T) {
        self.received += 1;
        if self.frames.len() == CANDIDATE_CAPACITY {
            self.frames.pop_front();
            self.dropped += 1;
        }
        self.frames.push_back(frame);
        self.max_candidates = self.max_candidates.max(self.frames.len());
    }

    pub(crate) fn pop(&mut self) -> Option<T> {
        self.frames.pop_front()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrival_after_a_missed_refresh_does_not_replace_the_committed_frame() {
        let mut queue = FrameQueue::default();
        queue.push("A");
        assert_eq!(queue.pop(), Some("A"));
        assert_eq!(queue.pop(), None); // B misses the next refresh.
        queue.push("B");
        let committed = queue.pop();
        queue.push("C");
        assert_eq!(committed, Some("B"));
        assert_eq!(queue.pop(), Some("C"));
        assert_eq!(queue.dropped, 0);
    }

    #[test]
    fn bursts_drop_only_oldest_uncommitted_frames() {
        let mut queue = FrameQueue::default();
        queue.push(1);
        let committed = queue.pop();
        for frame in 2..=10 {
            queue.push(frame);
        }
        assert_eq!(committed, Some(1));
        assert_eq!(queue.pop(), Some(9));
        assert_eq!(queue.pop(), Some(10));
        assert!(queue.is_empty());
        assert_eq!(queue.received, 10);
        assert_eq!(queue.dropped, 7);
        assert_eq!(queue.max_candidates, 2);
    }
}
