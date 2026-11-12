//! Thin native dictation event-stream binding.

use deskfleet_native::speech::{self, Speech, SpeechEventKind};
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(object)]
pub struct NativeSpeechStatus {
    pub supported: bool,
}

#[napi(object)]
pub struct NativeSpeechEvent {
    pub session_id: String,
    pub r#type: String,
    pub text: Option<String>,
    pub r#final: Option<bool>,
    pub level: Option<f64>,
    pub code: Option<String>,
    pub message: Option<String>,
}

impl From<speech::SpeechEvent> for NativeSpeechEvent {
    fn from(event: speech::SpeechEvent) -> Self {
        let mut result = Self {
            session_id: event.session_id,
            r#type: String::new(),
            text: None,
            r#final: None,
            level: None,
            code: None,
            message: None,
        };
        match event.kind {
            SpeechEventKind::Started => result.r#type = "started".into(),
            SpeechEventKind::Result { text, is_final } => {
                result.r#type = "result".into();
                result.text = Some(text);
                result.r#final = Some(is_final);
            }
            SpeechEventKind::Level(level) => {
                result.r#type = "level".into();
                result.level = Some(level);
            }
            SpeechEventKind::Error { code, message } => {
                result.r#type = "error".into();
                result.code = Some(code.into());
                result.message = Some(message);
            }
            SpeechEventKind::Ended => result.r#type = "ended".into(),
        }
        result
    }
}

#[napi]
pub async fn speech_status(locale: String) -> NativeSpeechStatus {
    NativeSpeechStatus {
        supported: speech::supported(locale).await,
    }
}

#[napi]
pub struct NativeSpeech {
    speech: Speech,
}

#[napi]
pub async fn create_speech(session_id: String, locale: String) -> Result<NativeSpeech> {
    Ok(NativeSpeech {
        speech: Speech::start(session_id, locale).map_err(native_error)?,
    })
}

#[napi]
impl NativeSpeech {
    #[napi]
    pub async fn next_event(&self) -> Option<NativeSpeechEvent> {
        self.speech.next_event().await.map(Into::into)
    }

    #[napi]
    pub async fn stop(&self) {
        self.speech.stop();
    }

    #[napi]
    pub async fn cancel(&self) {
        self.speech.cancel();
    }
}
