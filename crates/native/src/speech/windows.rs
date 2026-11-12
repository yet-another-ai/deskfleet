//! Installed Windows SAPI recognizers work in the existing unpackaged desktop app.
//! Every COM interface stays on one dedicated MTA thread, including destruction.
#![allow(unsafe_code)] // SAPI's COM methods and owned event pointers are unsafe APIs.

use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{E_ACCESSDENIED, E_FAIL, LPARAM};
use windows::Win32::Globalization::{LocaleNameToLCID, ResolveLocaleName};
use windows::Win32::Media::Speech::{
    ISpObjectToken, ISpObjectTokenCategory, ISpRecoContext, ISpRecoGrammar, ISpRecoResult,
    ISpRecognizer, SPCAT_RECOGNIZERS, SPEI_END_SR_STREAM, SPEI_HYPOTHESIS, SPEI_RECOGNITION,
    SPEI_RESERVED1, SPEI_RESERVED2, SPEI_SR_AUDIO_LEVEL, SPET_LPARAM_IS_OBJECT,
    SPET_LPARAM_IS_POINTER, SPET_LPARAM_IS_STRING, SPET_LPARAM_IS_TOKEN, SPEVENT, SPLO_STATIC,
    SPRS_ACTIVE, SPRST_ACTIVE, SPRST_INACTIVE, SPRST_INACTIVE_WITH_PURGE, SpInprocRecognizer,
    SpMMAudioIn, SpObjectTokenCategory,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use windows::core::{HRESULT, IUnknown, Interface, PCWSTR, PWSTR};

use super::{EventSink, SpeechEventKind, Transcript};

enum Command {
    Stop,
    Cancel,
}

pub(super) struct Controller(Sender<Command>);

impl Controller {
    pub(super) fn start(locale: String, sink: EventSink) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("deskfleet-dictation".into())
            .spawn(move || {
                if let Err(error) = run(&locale, &sink, &receiver) {
                    sink.emit(SpeechEventKind::Error {
                        code: if error.code() == E_ACCESSDENIED {
                            "permission-denied"
                        } else {
                            "failed"
                        },
                        message: error.to_string(),
                    });
                }
                sink.emit(SpeechEventKind::Ended);
            })?;
        Ok(Self(sender))
    }

    pub(super) fn stop(&self) {
        let _ = self.0.send(Command::Stop);
    }

    pub(super) fn cancel(&self) {
        let _ = self.0.send(Command::Cancel);
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct Apartment;

impl Apartment {
    fn new() -> windows::core::Result<Self> {
        // SAFETY: this thread creates, uses, and drops all COM objects before uninitializing.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: balances this thread's successful CoInitializeEx, after interface drops.
        unsafe { CoUninitialize() };
    }
}

pub(super) fn supported(locale: &str) -> bool {
    let Ok(_apartment) = Apartment::new() else {
        return false;
    };
    recognizer_token(locale).is_ok_and(|token| token.is_some())
}

fn recognizer_token(locale: &str) -> windows::core::Result<Option<ISpObjectToken>> {
    let locale: Vec<u16> = locale.encode_utf16().chain(Some(0)).collect();
    // Resolve BCP-47 aliases and neutral language tags to Windows' concrete locale
    // before selecting a SAPI language ID. 85 is LOCALE_NAME_MAX_LENGTH.
    let mut resolved = [0_u16; 85];
    // SAFETY: input is terminated UTF-16, and the output buffer has the documented size.
    if unsafe { ResolveLocaleName(PCWSTR(locale.as_ptr()), Some(&mut resolved)) } == 0 {
        return Ok(None);
    }
    // SAFETY: ResolveLocaleName succeeded and returned a terminated locale name.
    let lcid = unsafe { LocaleNameToLCID(PCWSTR(resolved.as_ptr()), 0) };
    if lcid == 0 {
        return Ok(None);
    }
    let attributes: Vec<u16> = format!("Language={:x}", lcid & 0xffff)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // SAFETY: COM is initialized on this thread and all input strings live through calls.
    unsafe {
        let category: ISpObjectTokenCategory =
            CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_INPROC_SERVER)?;
        category.SetId(SPCAT_RECOGNIZERS, false)?;
        let tokens = category.EnumTokens(PCWSTR(attributes.as_ptr()), PCWSTR::null())?;
        let mut token = None;
        let mut fetched = 0;
        tokens.Next(1, &mut token, Some(&mut fetched))?;
        Ok(if fetched == 1 { token } else { None })
    }
}

struct Recognition {
    recognizer: ISpRecognizer,
    context: ISpRecoContext,
    _grammar: ISpRecoGrammar,
}

impl Recognition {
    fn start(token: &ISpObjectToken) -> windows::core::Result<Self> {
        // SAFETY: all interfaces are created in this thread's initialized COM apartment;
        // SAPI retains the audio object passed to SetInput and manages microphone capture.
        unsafe {
            let recognizer: ISpRecognizer =
                CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_INPROC_SERVER)?;
            recognizer.SetRecognizer(token)?;
            recognizer.SetRecoState(SPRST_INACTIVE)?;
            let audio: IUnknown = CoCreateInstance(&SpMMAudioIn, None, CLSCTX_INPROC_SERVER)?;
            recognizer.SetInput(&audio, true)?;
            let context = recognizer.CreateRecoContext()?;
            // SAPI requires its reserved interest bits alongside requested event bits.
            let interest = [
                SPEI_RESERVED1,
                SPEI_RESERVED2,
                SPEI_RECOGNITION,
                SPEI_HYPOTHESIS,
                SPEI_SR_AUDIO_LEVEL,
                SPEI_END_SR_STREAM,
            ]
            .into_iter()
            .fold(0_u64, |mask, event| mask | (1_u64 << event.0));
            context.SetInterest(interest, interest)?;
            let grammar = context.CreateGrammar(1)?;
            grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC)?;
            grammar.SetDictationState(SPRS_ACTIVE)?;
            recognizer.SetRecoState(SPRST_ACTIVE)?;
            Ok(Self {
                recognizer,
                context,
                _grammar: grammar,
            })
        }
    }

    fn stop(&self) -> windows::core::Result<()> {
        // SAFETY: receiver belongs to this COM thread. INACTIVE flushes recognition;
        // cancellation uses INACTIVE_WITH_PURGE in Drop instead.
        unsafe { self.recognizer.SetRecoState(SPRST_INACTIVE) }
    }
}

impl Drop for Recognition {
    fn drop(&mut self) {
        // SAFETY: the worker still owns the initialized apartment and this recognizer.
        let _ = unsafe { self.recognizer.SetRecoState(SPRST_INACTIVE_WITH_PURGE) };
    }
}

fn run(locale: &str, sink: &EventSink, commands: &Receiver<Command>) -> windows::core::Result<()> {
    let _apartment = Apartment::new()?;
    let Some(token) = recognizer_token(locale)? else {
        sink.emit(SpeechEventKind::Error {
            code: "unavailable",
            message: "no installed Windows speech recognizer supports this language".into(),
        });
        return Ok(());
    };
    // Stop/cancel can arrive while the worker discovers recognizers, before opening audio.
    if commands.try_recv().is_ok() {
        return Ok(());
    }
    let recognition = Recognition::start(&token)?;
    sink.emit(SpeechEventKind::Started);
    let mut transcript = Transcript::default();
    let mut stop_deadline = None;
    let mut last_level = Instant::now();
    loop {
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Cancel => return Ok(()),
                Command::Stop if stop_deadline.is_none() => {
                    recognition.stop()?;
                    stop_deadline = Some(Instant::now() + Duration::from_secs(10));
                }
                Command::Stop => {}
            }
        }
        loop {
            let mut event = Event(SPEVENT::default());
            let mut fetched = 0;
            // SAFETY: the event and fetched output storage are valid and initialized.
            unsafe {
                recognition
                    .context
                    .GetEvents(1, &mut event.0, &mut fetched)?
            };
            if fetched == 0 {
                break;
            }
            let id = event.0._bitfield & 0xffff;
            if id == SPEI_RECOGNITION.0 || id == SPEI_HYPOTHESIS.0 {
                let text = event.text()?;
                let is_final = id == SPEI_RECOGNITION.0;
                let text = transcript.result(&text, is_final);
                sink.emit(SpeechEventKind::Result { text, is_final });
            } else if id == SPEI_SR_AUDIO_LEVEL.0
                && last_level.elapsed() >= Duration::from_millis(80)
            {
                let level = u32::try_from(event.0.wParam.0).unwrap_or(100).min(100);
                sink.emit(SpeechEventKind::Level(f64::from(level) / 100.0));
                last_level = Instant::now();
            } else if id == SPEI_END_SR_STREAM.0 {
                // SAPI stores a signed 32-bit HRESULT in this pointer-sized field.
                let bytes = event.0.lParam.0.to_le_bytes();
                let result = HRESULT(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
                result.ok()?;
                if transcript.committed.is_empty() {
                    sink.emit(SpeechEventKind::Error {
                        code: "no-speech",
                        message: "no speech was recognized".into(),
                    });
                } else {
                    sink.emit(SpeechEventKind::Result {
                        text: transcript.committed,
                        is_final: true,
                    });
                }
                return Ok(());
            }
        }
        if stop_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            sink.emit(SpeechEventKind::Error {
                code: "failed",
                message: "speech recognition did not finish".into(),
            });
            return Ok(());
        }
        match commands.recv_timeout(Duration::from_millis(25)) {
            Ok(Command::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            Ok(Command::Stop) if stop_deadline.is_none() => {
                recognition.stop()?;
                stop_deadline = Some(Instant::now() + Duration::from_secs(10));
            }
            Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

/// SAPI transfers ownership of object/string parameters to the event consumer.
struct Event(SPEVENT);

impl Event {
    fn text(&mut self) -> windows::core::Result<String> {
        // SAFETY: RECOGNITION/HYPOTHESIS LPARAM owns an ISpRecoResult reference.
        // Taking that reference clears it from Event so it is released exactly once.
        let object = unsafe { IUnknown::from_raw(self.0.lParam.0 as *mut _) };
        self.0.lParam = LPARAM(0);
        let result: ISpRecoResult = object.cast()?;
        let mut text = PWSTR::null();
        // SAFETY: text is valid out-storage; SAPI allocates a terminated COM string.
        unsafe { result.GetText(0, u32::MAX, true, &mut text, None)? };
        // SAFETY: successful GetText returned a valid COM-allocated UTF-16 string.
        let value = unsafe { text.to_string() };
        // SAFETY: GetText's allocated string must be released with CoTaskMemFree.
        unsafe { CoTaskMemFree(Some(text.0.cast())) };
        value.map_err(|error| windows::core::Error::new(E_FAIL, error.to_string()))
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        if self.0.lParam.0 == 0 {
            return;
        }
        let kind = (self.0._bitfield >> 16) & 0xffff;
        if kind == SPET_LPARAM_IS_OBJECT.0 || kind == SPET_LPARAM_IS_TOKEN.0 {
            // SAFETY: these event types transfer one COM reference to the consumer.
            drop(unsafe { IUnknown::from_raw(self.0.lParam.0 as *mut _) });
        } else if kind == SPET_LPARAM_IS_POINTER.0 || kind == SPET_LPARAM_IS_STRING.0 {
            // SAFETY: these event types transfer COM-allocated memory to the consumer.
            unsafe { CoTaskMemFree(Some(self.0.lParam.0 as *const _)) };
        }
    }
}
