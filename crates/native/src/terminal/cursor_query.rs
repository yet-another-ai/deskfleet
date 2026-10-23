//! ConPTY's startup cursor query.
//!
//! portable-pty 0.9 creates the Windows pseudoconsole with
//! `PSEUDOCONSOLE_INHERIT_CURSOR`. When the child connects, ConPTY writes
//! [`QUERY`] and does not finish that connection until the host writes a
//! cursor-position report. Nothing has been rendered yet, so the cursor is the
//! origin of an empty screen (`ESC[1;1R`, row 1 and column 1).
//!
//! That startup query is removed from the forwarded stream. The attached
//! terminal would otherwise answer too, and ConPTY would deliver the second
//! report to the shell as input, including when a client replays history.
//! A later [`QUERY`] comes from the program. It stays in the stream so the
//! terminal can answer with the cursor it has actually drawn.

pub(super) const QUERY: &[u8] = b"\x1b[6n";

#[derive(Debug, Default)]
pub(super) struct StartupCursorQuery {
    pending: [u8; 3],
    pending_len: usize,
    done: bool,
}

pub(super) struct Observed {
    pub(super) forward: Vec<u8>,
    pub(super) answer: bool,
}

impl StartupCursorQuery {
    /// Remove the first startup query from `input`.
    ///
    /// A trailing prefix of the query is held until the next chunk so a split
    /// `ESC[6n` is still recognized. After the startup query, later copies are
    /// forwarded unchanged.
    pub(super) fn observe(&mut self, input: &[u8]) -> Observed {
        if self.done {
            return Observed {
                forward: input.to_vec(),
                answer: false,
            };
        }

        let mut data = Vec::with_capacity(self.pending_len + input.len());
        data.extend_from_slice(&self.pending[..self.pending_len]);
        data.extend_from_slice(input);
        self.pending_len = 0;

        if let Some(at) = data.windows(QUERY.len()).position(|window| window == QUERY) {
            self.done = true;
            let mut forward = Vec::with_capacity(data.len() - QUERY.len());
            forward.extend_from_slice(&data[..at]);
            forward.extend_from_slice(&data[at + QUERY.len()..]);
            return Observed {
                forward,
                answer: true,
            };
        }

        let keep = trailing_query_prefix(&data);
        let split = data.len() - keep;
        self.pending[..keep].copy_from_slice(&data[split..]);
        self.pending_len = keep;
        data.truncate(split);
        Observed {
            forward: data,
            answer: false,
        }
    }

    /// Bytes held back while they might still be the start of the query.
    pub(super) fn finish(&mut self) -> Vec<u8> {
        let pending = self.pending[..self.pending_len].to_vec();
        self.pending_len = 0;
        pending
    }
}

fn trailing_query_prefix(data: &[u8]) -> usize {
    let max = (QUERY.len() - 1).min(data.len());
    (1..=max)
        .rev()
        .find(|&length| data.ends_with(&QUERY[..length]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(query: &mut StartupCursorQuery, input: &[u8]) -> (Vec<u8>, bool) {
        let observed = query.observe(input);
        (observed.forward, observed.answer)
    }

    #[test]
    fn startup_query_is_removed_and_answered_once() {
        let mut query = StartupCursorQuery::default();
        assert_eq!(observe(&mut query, b"\x1b[6n"), (Vec::new(), true));
        assert_eq!(
            observe(&mut query, b"\x1b[6n"),
            (b"\x1b[6n".to_vec(), false)
        );
    }

    #[test]
    fn bytes_around_the_startup_query_are_forwarded() {
        let mut query = StartupCursorQuery::default();
        let (forward, answer) = observe(&mut query, b"ready\x1b[6n\x1b[c\x1b[?9001h");
        assert!(answer);
        assert_eq!(forward, b"ready\x1b[c\x1b[?9001h");
    }

    #[test]
    fn query_split_across_reads_is_one_request() {
        let mut query = StartupCursorQuery::default();
        assert_eq!(observe(&mut query, b"\x1b[6"), (Vec::new(), false));
        assert_eq!(observe(&mut query, b"nrest"), (b"rest".to_vec(), true));
        assert!(query.finish().is_empty());
    }

    #[test]
    fn partial_query_that_does_not_match_is_released() {
        let mut query = StartupCursorQuery::default();
        assert_eq!(observe(&mut query, b"pre\x1b[6"), (b"pre".to_vec(), false));
        assert_eq!(observe(&mut query, b"m"), (b"\x1b[6m".to_vec(), false));
    }

    #[test]
    fn similar_sequences_are_not_the_cursor_query() {
        let mut query = StartupCursorQuery::default();
        let (forward, answer) = observe(&mut query, b"\x1b[16n\x1b[6m\x1b[26n");
        assert!(!answer);
        assert_eq!(forward, b"\x1b[16n\x1b[6m\x1b[26n");
    }

    #[test]
    fn unfinished_prefix_is_returned_at_end_of_stream() {
        let mut query = StartupCursorQuery::default();
        assert_eq!(observe(&mut query, b"ok\x1b["), (b"ok".to_vec(), false));
        assert_eq!(query.finish(), b"\x1b[");
    }
}
