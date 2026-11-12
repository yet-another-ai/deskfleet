//! Dictation on the device displaying the desktop UI, independent of team runtimes.

use tokio::sync::{Mutex, mpsc};

#[cfg(target_os = "macos")]
#[path = "speech/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "speech/windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", windows)))]
#[path = "speech/unsupported.rs"]
mod platform;

#[derive(Debug, Clone, PartialEq)]
pub enum SpeechEventKind {
    Started,
    Result { text: String, is_final: bool },
    Level(f64),
    Error { code: &'static str, message: String },
    Ended,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpeechEvent {
    pub session_id: String,
    pub kind: SpeechEventKind,
}

#[derive(Clone)]
pub(super) struct EventSink {
    session_id: String,
    sender: mpsc::UnboundedSender<SpeechEvent>,
}

impl EventSink {
    pub(super) fn emit(&self, kind: SpeechEventKind) {
        let _ = self.sender.send(SpeechEvent {
            session_id: self.session_id.clone(),
            kind,
        });
    }
}

/// One native dictation. Dropping it cancels recording and pending recognition.
pub struct Speech {
    controller: platform::Controller,
    events: Mutex<mpsc::UnboundedReceiver<SpeechEvent>>,
}

impl Speech {
    pub fn start(session_id: String, locale: String) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let sink = EventSink { session_id, sender };
        let controller = platform::Controller::start(locale, sink)?;
        Ok(Self {
            controller,
            events: Mutex::new(receiver),
        })
    }

    /// Stops audio capture and lets the recognizer deliver its final result.
    pub fn stop(&self) {
        self.controller.stop();
    }

    /// Discards pending results. The event stream still receives `Ended`.
    pub fn cancel(&self) {
        self.controller.cancel();
    }

    pub async fn next_event(&self) -> Option<SpeechEvent> {
        let mut events = self.events.lock().await;
        let event = events.recv().await;
        if event
            .as_ref()
            .is_some_and(|event| matches!(event.kind, SpeechEventKind::Ended))
        {
            events.close();
        }
        event
    }
}

/// Checks installed recognizer support without asking for microphone access.
pub async fn supported(locale: String) -> bool {
    tokio::task::spawn_blocking(move || platform::supported(&locale))
        .await
        .unwrap_or(false)
}

/// SAPI supplies a final result for each phrase; the UI consumes a cumulative draft.
#[cfg(any(windows, test))]
#[derive(Default)]
struct Transcript {
    committed: String,
    trailing_spaces: u8,
}

/// SAPI's display attributes describe phrase boundaries without locale guesses.
#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
struct PhraseSpacing {
    consume_leading: bool,
    trailing: u8,
}

#[cfg(any(windows, test))]
impl Transcript {
    fn result(&mut self, text: &str, is_final: bool, spacing: PhraseSpacing) -> String {
        let text = text.trim();
        let mut result = self.committed.clone();
        if !text.is_empty() {
            if !result.is_empty() && !spacing.consume_leading {
                result.extend(std::iter::repeat_n(' ', usize::from(self.trailing_spaces)));
            }
            result.push_str(text);
            if is_final {
                self.committed.clone_from(&result);
                self.trailing_spaces = spacing.trailing;
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::{PhraseSpacing, Transcript};

    const WORD: PhraseSpacing = PhraseSpacing {
        consume_leading: false,
        trailing: 1,
    };
    const UNSEPARATED: PhraseSpacing = PhraseSpacing {
        consume_leading: false,
        trailing: 0,
    };

    #[test]
    fn phrase_hypotheses_replace_each_other_and_final_phrases_accumulate() {
        let mut transcript = Transcript::default();
        assert_eq!(transcript.result("hello", false, WORD), "hello");
        assert_eq!(transcript.result("hello world", true, WORD), "hello world");
        assert_eq!(transcript.result("next", false, WORD), "hello world next");
        assert_eq!(
            transcript.result("another phrase", true, WORD),
            "hello world another phrase"
        );
        assert_eq!(transcript.committed, "hello world another phrase");
    }

    #[test]
    fn chinese_and_japanese_phrases_do_not_gain_spaces() {
        for (first, hypothesis, final_phrase, expected) in [
            ("请检查", "新的", "最新的改动。", "请检查最新的改动。"),
            (
                "最新の",
                "変更",
                "変更を確認してください。",
                "最新の変更を確認してください。",
            ),
        ] {
            let mut transcript = Transcript::default();
            assert_eq!(transcript.result(first, true, UNSEPARATED), first);
            assert_eq!(
                transcript.result(hypothesis, false, UNSEPARATED),
                format!("{first}{hypothesis}")
            );
            assert_eq!(transcript.result(final_phrase, true, UNSEPARATED), expected);
        }
    }

    #[test]
    fn punctuation_consumes_space_and_retains_engine_sentence_spacing() {
        let mut transcript = Transcript::default();
        let punctuation = PhraseSpacing {
            consume_leading: true,
            trailing: 2,
        };
        transcript.result("hello", true, WORD);
        assert_eq!(transcript.result(".", false, punctuation), "hello.");
        // An interim punctuation hypothesis cannot change the committed separator.
        assert_eq!(transcript.result("world", false, WORD), "hello world");
        assert_eq!(transcript.result(".", true, punctuation), "hello.");
        assert_eq!(transcript.result("Next", true, WORD), "hello.  Next");
    }

    #[test]
    fn mixed_script_spacing_comes_from_the_recognizer() {
        let mut transcript = Transcript::default();
        transcript.result("请检查", true, UNSEPARATED);
        assert_eq!(transcript.result("pull", true, WORD), "请检查pull");
        assert_eq!(
            transcript.result("request", true, WORD),
            "请检查pull request"
        );
        let cjk = PhraseSpacing {
            consume_leading: true,
            trailing: 0,
        };
        assert_eq!(
            transcript.result("的改动。", true, cjk),
            "请检查pull request的改动。"
        );
        assert_eq!(
            transcript.result("", true, WORD),
            "请检查pull request的改动。"
        );
    }
}
