use std::sync::Arc;
use std::time::{Duration, Instant};

use deskfleet_input::InputEvent;
use serde_json::json;
use tokio::sync::watch;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent as NativeEvent;
use winit::event_loop::ActiveEventLoop;
use winit::window::{Window, WindowId};

use crate::input::Input;
use crate::input_queue;
use crate::presentation::Presentation;
use crate::renderer::Renderer;
use crate::session::Frames;
use crate::{Error, WindowEvent, protocol};

pub(crate) struct Viewer {
    pub(crate) frames: Frames,
    pub(crate) input: input_queue::Sender,
    pub(crate) shutdown: watch::Sender<bool>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    presentation: Option<Presentation>,
    controls: Input,
    title: String,
    redraw: bool,
    occluded: bool,
    submitted: u64,
    last_stats: Instant,
    last_ready_age_ms: f64,
    pub(crate) error: Option<String>,
}

impl Viewer {
    pub(crate) fn new(
        frames: Frames,
        input: input_queue::Sender,
        shutdown: watch::Sender<bool>,
    ) -> Self {
        Self {
            frames,
            input,
            shutdown,
            window: None,
            renderer: None,
            presentation: None,
            controls: Input::default(),
            title: "DeskFleet desktop".into(),
            redraw: true,
            occluded: false,
            submitted: 0,
            last_stats: Instant::now(),
            last_ready_age_ms: 0.,
            error: None,
        }
    }

    fn fail(&mut self, event_loop: &ActiveEventLoop, error: impl ToString) {
        let error = error.to_string();
        if self.error.is_none() {
            let _ = protocol::emit(json!({"type":"error", "error":error}));
            self.error = Some(error);
        }
        self.shutdown.send_replace(true);
        event_loop.exit();
    }

    fn render(&mut self) -> Result<(), Error> {
        if self.occluded {
            return Ok(());
        }
        let (Some(renderer), Some(presentation)) = (&mut self.renderer, &mut self.presentation)
        else {
            return Ok(());
        };
        if !presentation.poll()? {
            tracing::debug!("presentation awaiting compositor feedback");
            return Ok(());
        }
        let has_frame = !self
            .frames
            .lock()
            .map_err(|_| "decoded queue poisoned")?
            .is_empty();
        if !has_frame && !self.redraw {
            return Ok(());
        }
        // Acquire before choosing a candidate: a backend wait must not pin an
        // old, uncommitted frame while the decoder fills the small candidate queue.
        let Some(output) = renderer.acquire()? else {
            return Ok(());
        };
        let frame = self
            .frames
            .lock()
            .map_err(|_| "decoded queue poisoned")?
            .pop();
        if let Some(frame) = frame {
            renderer.upload(&frame)?;
            self.last_ready_age_ms = frame.ready_at.elapsed().as_secs_f64() * 1000.;
            self.submitted += 1;
        }
        renderer.draw(output, presentation)?;
        tracing::debug!(
            submitted = self.submitted,
            mode = presentation.mode(),
            "viewer surface committed"
        );
        self.redraw = false;
        self.stats()?;
        Ok(())
    }

    fn stats(&mut self) -> Result<(), Error> {
        if self.last_stats.elapsed() < Duration::from_secs(1) {
            return Ok(());
        }
        let frames = self.frames.lock().map_err(|_| "decoded queue poisoned")?;
        let size = self
            .renderer
            .as_ref()
            .map_or((0, 0), |renderer| renderer.video_size);
        let presentation = self.presentation.as_ref();
        let stats = presentation.map(|presentation| presentation.stats());
        protocol::emit(json!({
            "type":"stats", "decodedFrames":frames.received, "submittedFrames":self.submitted,
            "droppedFrames":frames.dropped, "width":size.0, "height":size.1, "maxCandidates":frames.max_candidates,
            "readyToSubmitMs":self.last_ready_age_ms,
            "presentationMode":presentation.map(|presentation| presentation.mode()),
            "presentedCommits":stats.as_ref().filter(|_| presentation.is_some_and(|p| p.mode() == "wayland-presentation")).map(|stats| stats.presented),
            "discardedPresents":stats.as_ref().map(|stats| stats.discarded),
            "refreshIntervalNs":stats.as_ref().and_then(|stats| stats.refresh_ns),
            "frameCallbacks":stats.as_ref().map(|stats| stats.frame_callbacks),
            "presentationClockId":stats.as_ref().and_then(|stats| stats.clock_id),
            "lastPresentedNs":stats.as_ref().and_then(|stats| stats.last_presented_ns),
            "presentationSequence":stats.as_ref().and_then(|stats| stats.sequence),
        }))?;
        self.last_stats = Instant::now();
        Ok(())
    }

    fn request_if_needed(&mut self) -> Result<(), Error> {
        if self.occluded {
            return Ok(());
        }
        let Some(presentation) = self.presentation.as_mut() else {
            return Ok(());
        };
        let ready = presentation.poll()?;
        let has_frame = !self
            .frames
            .lock()
            .map_err(|_| "decoded queue poisoned")?
            .is_empty();
        if ready
            && (has_frame || self.redraw)
            && let Some(window) = &self.window
        {
            window.request_redraw();
        }
        Ok(())
    }
}

impl ApplicationHandler<WindowEvent> for Viewer {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let result = (|| -> Result<(), Error> {
            let window = Arc::new(
                event_loop.create_window(
                    Window::default_attributes()
                        .with_title(&self.title)
                        .with_inner_size(winit::dpi::LogicalSize::new(1280., 720.)),
                )?,
            );
            self.presentation = Some(Presentation::new(Arc::clone(&window))?);
            self.renderer = Some(pollster::block_on(Renderer::new(Arc::clone(&window)))?);
            self.window = Some(window);
            Ok(())
        })();
        if let Err(error) = result {
            self.fail(event_loop, error);
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: WindowEvent) {
        match event {
            WindowEvent::Start { title, control } => {
                self.title = title;
                self.controls.enabled = control;
                if let Some(window) = &self.window {
                    window.set_title(&self.title);
                }
            }
            WindowEvent::FrameReady => {
                if let Err(error) = self.request_if_needed() {
                    self.fail(event_loop, error);
                }
            }
            WindowEvent::Error(error) => self.fail(event_loop, error),
            WindowEvent::Close => {
                self.shutdown.send_replace(true);
                event_loop.exit();
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: NativeEvent) {
        if let (Some(window), Some(renderer)) = (&self.window, &self.renderer)
            && let Some(event) = self.controls.event(
                &event,
                window.inner_size(),
                renderer.video_size,
                window.scale_factor(),
            )
            && let Err(error) = self.input.send(event)
        {
            self.fail(event_loop, error);
            return;
        }
        match event {
            NativeEvent::CloseRequested => {
                // User intent must reach Electron before transport shutdown emits
                // errors/closed, which may be held for an in-flight startup RPC.
                let _ = protocol::emit(json!({"type":"closeRequested"}));
                let _ = self.input.send(InputEvent::ReleaseAll);
                self.shutdown.send_replace(true);
                event_loop.exit();
            }
            NativeEvent::Resized(size) => {
                self.occluded = size.width == 0 || size.height == 0;
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(size);
                }
                self.redraw = true;
            }
            NativeEvent::Occluded(occluded) => {
                self.occluded = occluded;
                self.redraw = true;
            }
            NativeEvent::RedrawRequested => {
                if let Err(error) = self.render() {
                    self.fail(event_loop, error);
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if let Err(error) = self.request_if_needed() {
            self.fail(event_loop, error);
        }
        if let Err(error) = self.stats() {
            self.fail(event_loop, error);
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        self.shutdown.send_replace(true);
    }
}
