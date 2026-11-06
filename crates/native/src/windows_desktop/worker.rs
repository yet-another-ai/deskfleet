//! The privileged process accepts desktop operations only, on an authenticated pipe.

use std::io;

use deskfleet_input::InputSession;
use deskfleet_windows_desktop::Pipe;

use super::protocol::{self, Reply, Request};
use crate::media::{MediaError, pipeline::CapturePipeline};

enum Activity {
    Idle,
    Capture(Box<CapturePipeline>),
    Input(InputSession),
}

enum Failure {
    Desktop(MediaError),
    Transport(io::Error),
}

impl From<MediaError> for Failure {
    fn from(error: MediaError) -> Self {
        Self::Desktop(error)
    }
}

impl Activity {
    fn require_idle(&self) -> Result<(), MediaError> {
        match self {
            Self::Idle => Ok(()),
            _ => Err(MediaError::InvalidConfig(
                "desktop helper is already in use",
            )),
        }
    }

    fn stop(&mut self) -> Result<(), MediaError> {
        match std::mem::replace(self, Self::Idle) {
            Self::Idle => Ok(()),
            Self::Capture(capture) => (*capture).stop(),
            Self::Input(mut input) => input.release_all().map_err(input_error),
        }
    }
}

/// Serve one user daemon connection in its existing physical console session.
///
/// The broker supplies the pipe only after checking the local caller and session.
/// Neither this process nor its protocol can launch agents, read files or mint grants.
///
/// # Errors
/// Returns an IPC error when the client disconnects mid-message, loses its session,
/// or cannot receive a response. Desktop failures are returned to the caller first.
pub fn serve(mut pipe: Pipe) -> io::Result<()> {
    let mut activity = Activity::Idle;
    let result = (|| loop {
        let request: Request = match protocol::read_json(&mut pipe) {
            Ok(request) => request,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::UnexpectedEof | io::ErrorKind::BrokenPipe
                ) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        pipe.check_session()?;
        let stop = matches!(request, Request::Stop);
        let refresh = matches!(request, Request::RefreshInput);
        match execute(request, &mut activity, &mut pipe) {
            Ok(()) => {}
            Err(Failure::Desktop(error)) => {
                protocol::write_json(
                    &mut pipe,
                    &Reply::Error {
                        message: error.to_string(),
                        encoder: error.fallback_reason() == Some("encoder"),
                    },
                )?;
                // The secure desktop can be briefly unavailable while Windows switches.
                // Idle input refresh may retry; a failed actual input ends this controller.
                if !refresh {
                    return Ok(());
                }
            }
            // A failed write may have already emitted metadata or packet bytes.
            // Appending an Error response would corrupt that unfinished frame.
            Err(Failure::Transport(error)) => return Err(error),
        }
        if stop {
            return Ok(());
        }
    })();
    let cleanup = activity.stop().map_err(io::Error::other);
    result.and(cleanup)
}

fn execute(request: Request, activity: &mut Activity, pipe: &mut Pipe) -> Result<(), Failure> {
    let reply = match request {
        Request::Displays => {
            activity.require_idle()?;
            Reply::Displays {
                displays: deskfleet_capture::displays()
                    .map_err(MediaError::from)?
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            }
        }
        Request::Codecs { display_id } => {
            activity.require_idle()?;
            if !deskfleet_capture::displays()
                .map_err(MediaError::from)?
                .iter()
                .any(|display| display.id == display_id)
            {
                return Err(MediaError::DisplayNotFound(display_id).into());
            }
            Reply::Codecs {
                codecs: deskfleet_encoder::supported_codecs(display_id)
                    .map_err(MediaError::from)?
                    .into_iter()
                    .map(|codec| codec.as_str().to_owned())
                    .collect(),
            }
        }
        Request::Start { config, codec } => {
            activity.require_idle()?;
            *activity =
                Activity::Capture(Box::new(CapturePipeline::new(config, codec.into(), false)?));
            Reply::Ready
        }
        Request::Poll {
            keyframe,
            target_bitrate_bps,
            video_paused,
        } => {
            let Activity::Capture(capture) = activity else {
                return Err(MediaError::InvalidConfig("desktop capture has not started").into());
            };
            if let Some(target) = target_bitrate_bps {
                capture.apply_bandwidth_estimate(f64::from(target))?;
            }
            let batch = capture.poll(keyframe, video_paused)?;
            pipe.check_session().map_err(Failure::Transport)?;
            return protocol::write_batch(pipe, batch.packets, batch.encoder_started)
                .map_err(Failure::Transport);
        }
        Request::InputStart { display_id } => {
            activity.require_idle()?;
            *activity = Activity::Input(InputSession::new(display_id).map_err(input_error)?);
            Reply::Ready
        }
        Request::Input { event } => {
            let Activity::Input(input) = activity else {
                return Err(MediaError::InvalidConfig("desktop input has not started").into());
            };
            input.handle(event).map_err(input_error)?;
            Reply::Ready
        }
        Request::RefreshInput => {
            let Activity::Input(input) = activity else {
                return Err(MediaError::InvalidConfig("desktop input has not started").into());
            };
            input.refresh_desktop().map_err(input_error)?;
            Reply::Ready
        }
        Request::Stop => {
            activity.stop()?;
            Reply::Ready
        }
    };
    protocol::write_json(pipe, &reply).map_err(Failure::Transport)
}

fn input_error(error: deskfleet_input::InputError) -> MediaError {
    MediaError::Service {
        message: error.to_string(),
        encoder: false,
    }
}
