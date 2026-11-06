use deskfleet_capture::Display;
use deskfleet_encoder::Codec;
use deskfleet_input::InputEvent;
use deskfleet_windows_desktop::Pipe;

use super::protocol::{self, Reply, Request};
use crate::media::{DesktopConfig, MediaError, pipeline::CaptureBatch};

pub(crate) struct Client {
    pipe: Pipe,
}

impl Client {
    pub(crate) fn connect() -> Result<Option<Self>, MediaError> {
        deskfleet_windows_desktop::connect()
            .map(|pipe| pipe.map(|pipe| Self { pipe }))
            .map_err(failure)
    }

    fn call(&mut self, request: Request) -> Result<Reply, MediaError> {
        protocol::write_json(&mut self.pipe, &request).map_err(failure)?;
        let reply = protocol::read_json(&mut self.pipe).map_err(failure)?;
        match reply {
            Reply::Error { message, encoder } => Err(MediaError::Service { message, encoder }),
            reply => Ok(reply),
        }
    }

    fn ready(&mut self, request: Request) -> Result<(), MediaError> {
        match self.call(request)? {
            Reply::Ready => Ok(()),
            _ => Err(failure("unexpected response from desktop helper")),
        }
    }

    pub(crate) fn displays(&mut self) -> Result<Vec<Display>, MediaError> {
        match self.call(Request::Displays)? {
            Reply::Displays { displays } => Ok(displays.into_iter().map(Into::into).collect()),
            _ => Err(failure("unexpected display response from desktop helper")),
        }
    }

    pub(crate) fn codecs(&mut self, display_id: u32) -> Result<Vec<String>, MediaError> {
        match self.call(Request::Codecs { display_id })? {
            Reply::Codecs { codecs } => Ok(codecs),
            _ => Err(failure("unexpected codec response from desktop helper")),
        }
    }

    pub(crate) fn start(&mut self, config: DesktopConfig, codec: Codec) -> Result<(), MediaError> {
        self.ready(Request::Start {
            config,
            codec: codec.into(),
        })
    }

    pub(crate) fn poll(
        &mut self,
        keyframe: bool,
        target_bitrate_bps: Option<u32>,
    ) -> Result<CaptureBatch, MediaError> {
        match self.call(Request::Poll {
            keyframe,
            target_bitrate_bps,
        })? {
            Reply::Batch {
                packets,
                encoder_started,
            } => Ok(CaptureBatch {
                packets: protocol::read_packets(&mut self.pipe, packets).map_err(failure)?,
                encoder_started,
            }),
            _ => Err(failure("unexpected frame response from desktop helper")),
        }
    }

    pub(crate) fn start_input(&mut self, display_id: u32) -> Result<(), MediaError> {
        self.ready(Request::InputStart { display_id })
    }

    pub(crate) fn input(&mut self, event: InputEvent) -> Result<(), MediaError> {
        self.ready(Request::Input { event })
    }

    pub(crate) fn refresh_input(&mut self) -> Result<(), MediaError> {
        self.ready(Request::RefreshInput)
    }

    pub(crate) fn stop(&mut self) -> Result<(), MediaError> {
        self.ready(Request::Stop)
    }
}

fn failure(error: impl std::fmt::Display) -> MediaError {
    MediaError::Service {
        message: error.to_string(),
        encoder: false,
    }
}
