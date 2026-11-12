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
}

#[cfg(any(windows, test))]
impl Transcript {
    fn result(&mut self, text: &str, is_final: bool) -> String {
        let text = text.trim();
        let mut result = self.committed.clone();
        if !text.is_empty() {
            if !result.is_empty() {
                result.push(' ');
            }
            result.push_str(text);
        }
        if is_final {
            self.committed.clone_from(&result);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::Transcript;

    #[test]
    fn phrase_hypotheses_replace_each_other_and_final_phrases_accumulate() {
        let mut transcript = Transcript::default();
        assert_eq!(transcript.result("hello", false), "hello");
        assert_eq!(transcript.result("hello world", true), "hello world");
        assert_eq!(transcript.result("next", false), "hello world next");
        assert_eq!(
            transcript.result("another phrase", true),
            "hello world another phrase"
        );
        assert_eq!(transcript.committed, "hello world another phrase");
    }
}
