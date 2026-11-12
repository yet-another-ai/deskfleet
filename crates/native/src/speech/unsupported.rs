use super::{EventSink, SpeechEventKind};

pub(super) fn supported(_locale: &str) -> bool {
    false
}

pub(super) struct Controller;

impl Controller {
    pub(super) fn start(_locale: String, sink: EventSink) -> std::io::Result<Self> {
        sink.emit(SpeechEventKind::Error {
            code: "unavailable",
            message: "native dictation is not supported on this platform".into(),
        });
        sink.emit(SpeechEventKind::Ended);
        Ok(Self)
    }
    pub(super) fn stop(&self) {}
    pub(super) fn cancel(&self) {}
}
