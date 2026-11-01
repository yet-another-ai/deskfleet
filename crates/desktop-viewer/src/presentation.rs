//! Platform presentation backpressure. GPU completion does not release a
//! Wayland submission: only presentation feedback (or a frame callback on
//! compositors without that extension) permits the next surface commit.

use std::sync::Arc;

use winit::window::Window;

#[derive(Debug, thiserror::Error)]
pub enum PresentationError {
    #[error("native window handle: {0}")]
    Handle(#[from] winit::raw_window_handle::HandleError),
    #[cfg(target_os = "linux")]
    #[error("Wayland presentation: {0}")]
    Wayland(#[source] Box<dyn std::error::Error + Send + Sync>),
}

/// Only `wayland-presentation` reports actual displayed/discarded outcomes.
/// Frame callbacks are compositor pacing, while `fifo-hint` delegates pacing
/// to the swapchain and does not prove a one-frame presentation queue.
#[derive(Clone, Copy, Debug, Default)]
pub struct PresentationStats {
    pub presented: u64,
    pub discarded: u64,
    pub frame_callbacks: u64,
    pub clock_id: Option<u32>,
    /// Timestamp in the compositor's clock domain, not Rust `Instant`.
    pub last_presented_ns: Option<u64>,
    pub refresh_ns: Option<u32>,
    pub sequence: Option<u64>,
}

pub struct Presentation {
    #[cfg(target_os = "linux")]
    wayland: Option<wayland::WaylandPresentation>,
    // This field must follow the foreign backend: its surface and connection
    // stay alive until all of our Wayland proxies have been dropped.
    _window: Arc<Window>,
}

impl Presentation {
    pub fn new(window: Arc<Window>) -> Result<Self, PresentationError> {
        #[cfg(target_os = "linux")]
        let wayland = wayland::WaylandPresentation::new(Arc::clone(&window))?;
        Ok(Self {
            #[cfg(target_os = "linux")]
            wayland,
            _window: window,
        })
    }

    pub fn mode(&self) -> &'static str {
        #[cfg(target_os = "linux")]
        if let Some(wayland) = &self.wayland {
            return wayland.mode();
        }
        "fifo-hint"
    }

    /// Read the capacity updated by the platform feedback dispatcher. Does not
    /// wait for the compositor or substitute GPU completion for presentation.
    pub fn poll(&mut self) -> Result<bool, PresentationError> {
        #[cfg(target_os = "linux")]
        if let Some(wayland) = &mut self.wayland {
            return wayland.poll();
        }
        Ok(true)
    }

    /// Attach feedback to the next surface commit. Call after acquiring and
    /// drawing the swapchain image and after `Window::pre_present_notify`,
    /// immediately before `wgpu::Queue::present`. Do not commit the surface
    /// separately or abandon a frame after this method returns `true`.
    pub fn before_present(&mut self) -> Result<bool, PresentationError> {
        #[cfg(target_os = "linux")]
        if let Some(wayland) = &mut self.wayland {
            return wayland.before_present();
        }
        Ok(true)
    }

    pub fn stats(&self) -> PresentationStats {
        #[cfg(target_os = "linux")]
        if let Some(wayland) = &self.wayland {
            return wayland.stats();
        }
        PresentationStats::default()
    }
}

#[cfg(target_os = "linux")]
mod wayland {
    use std::io;
    use std::os::fd::AsFd;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::thread::JoinHandle;

    use nix::errno::Errno;
    use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
    use wayland_backend::client::{Backend, ObjectId, WaylandError};
    use wayland_client::{
        Connection, Dispatch, EventQueue, Proxy, QueueHandle,
        protocol::{wl_callback, wl_registry, wl_surface},
    };
    use wayland_protocols::wp::presentation_time::client::{
        wp_presentation, wp_presentation_feedback,
    };
    use winit::raw_window_handle::{
        HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
    };

    use super::{PresentationError, PresentationStats, Window};

    fn error(error: impl std::error::Error + Send + Sync + 'static) -> PresentationError {
        PresentationError::Wayland(Box::new(error))
    }

    pub(super) struct WaylandPresentation {
        queue: QueueHandle<Dispatcher>,
        state: Arc<Mutex<FeedbackState>>,
        _registry: wl_registry::WlRegistry,
        surface: wl_surface::WlSurface,
        connection: Connection,
        shutdown: UnixStream,
        worker: Option<JoinHandle<()>>,
    }

    #[derive(Default)]
    struct FeedbackState {
        registry_ready: bool,
        presentation: Option<wp_presentation::WpPresentation>,
        pending: Option<u64>,
        next_id: u64,
        stats: PresentationStats,
        failure: Option<PresentationError>,
    }

    struct Dispatcher {
        state: Arc<Mutex<FeedbackState>>,
        window: Arc<Window>,
    }

    impl Dispatcher {
        fn state(&self) -> MutexGuard<'_, FeedbackState> {
            self.state.lock().unwrap_or_else(|error| error.into_inner())
        }
    }

    enum Callback {
        RegistryReady,
        Frame(u64),
    }

    impl FeedbackState {
        fn reserve(&mut self) -> Option<u64> {
            if self.pending.is_some() {
                return None;
            }
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1);
            self.pending = Some(id);
            Some(id)
        }

        fn complete(&mut self, id: u64) -> bool {
            if self.pending != Some(id) {
                return false;
            }
            self.pending = None;
            true
        }

        fn presented(&mut self, id: u64, seconds: u64, nanos: u32, refresh: u32, sequence: u64) {
            if !self.complete(id) {
                return;
            }
            self.stats.presented += 1;
            self.stats.last_presented_ns = seconds
                .checked_mul(1_000_000_000)
                .and_then(|seconds| seconds.checked_add(u64::from(nanos)));
            self.stats.refresh_ns = (refresh != 0).then_some(refresh);
            self.stats.sequence = Some(sequence);
        }

        fn discarded(&mut self, id: u64) {
            if self.complete(id) {
                self.stats.discarded += 1;
            }
        }

        fn frame_callback(&mut self, id: u64) {
            if self.complete(id) {
                self.stats.frame_callbacks += 1;
            }
        }
    }

    impl WaylandPresentation {
        pub(super) fn new(window: Arc<Window>) -> Result<Option<Self>, PresentationError> {
            let RawDisplayHandle::Wayland(display) = window.display_handle()?.as_raw() else {
                return Ok(None);
            };
            let RawWindowHandle::Wayland(handle) = window.window_handle()?.as_raw() else {
                return Ok(None);
            };
            // SAFETY: Presentation owns an Arc<Window> and drops this backend
            // first. The foreign backend creates its own event queue and never
            // takes ownership of winit's live wl_display connection.
            #[allow(unsafe_code)]
            let backend = unsafe { Backend::from_foreign_display(display.display.as_ptr().cast()) };
            let connection = Connection::from_backend(backend);
            // SAFETY: winit supplied this live wl_surface. We only borrow it to
            // attach feedback; we never destroy it or replace its event handler.
            #[allow(unsafe_code)]
            let surface_id = unsafe {
                ObjectId::from_ptr(
                    wl_surface::WlSurface::interface(),
                    handle.surface.as_ptr().cast(),
                )
            }
            .map_err(error)?;
            let surface = wl_surface::WlSurface::from_id(&connection, surface_id).map_err(error)?;
            let queue = connection.new_event_queue();
            let display = connection.display();
            let registry = display.get_registry(&queue.handle(), ());
            // Discover globals on the feedback dispatcher without blocking the
            // window callback. Rendering starts after this asynchronous sync.
            display.sync(&queue.handle(), Callback::RegistryReady);
            connection.flush().map_err(error)?;
            let handle = queue.handle();
            let state = Arc::new(Mutex::new(FeedbackState::default()));
            let (shutdown, stopped) = UnixStream::pair().map_err(error)?;
            let mut dispatcher = Dispatcher {
                state: Arc::clone(&state),
                window,
            };
            let worker_connection = connection.clone();
            let worker = std::thread::Builder::new()
                .name("presentation feedback".into())
                .spawn(move || {
                    if let Err(failure) =
                        dispatch(queue, &mut dispatcher, worker_connection, stopped)
                    {
                        dispatcher.state().failure = Some(failure);
                        dispatcher.window.request_redraw();
                    }
                })
                .map_err(error)?;
            Ok(Some(Self {
                queue: handle,
                state,
                _registry: registry,
                surface,
                connection,
                shutdown,
                worker: Some(worker),
            }))
        }

        fn state(&self) -> MutexGuard<'_, FeedbackState> {
            self.state.lock().unwrap_or_else(|error| error.into_inner())
        }

        pub(super) fn mode(&self) -> &'static str {
            let state = self.state();
            if !state.registry_ready {
                "wayland-initializing"
            } else if state.presentation.is_some() {
                "wayland-presentation"
            } else {
                "wayland-frame-callback"
            }
        }

        pub(super) fn poll(&mut self) -> Result<bool, PresentationError> {
            let mut state = self.state();
            if let Some(failure) = state.failure.take() {
                return Err(failure);
            }
            Ok(state.registry_ready && state.pending.is_none())
        }

        pub(super) fn before_present(&mut self) -> Result<bool, PresentationError> {
            if !self.poll()? {
                return Ok(false);
            }
            let mut state = self.state();
            let Some(id) = state.reserve() else {
                return Ok(false);
            };
            if let Some(presentation) = &state.presentation {
                presentation.feedback(&self.surface, &self.queue, id);
            } else {
                self.surface.frame(&self.queue, Callback::Frame(id));
            }
            // Queue::present issues the matching surface commit and winit
            // flushes the shared connection. Never issue our own surface commit.
            Ok(true)
        }

        pub(super) fn stats(&self) -> PresentationStats {
            self.state().stats
        }
    }

    impl Drop for WaylandPresentation {
        fn drop(&mut self) {
            // EOF on this private socket interrupts the worker's poll, including
            // when the compositor sends no further events. Dropping a prepared
            // read guard cancels that read before joining the thread.
            let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
            if let Some(worker) = self.worker.take()
                && worker.join().is_err()
            {
                tracing::warn!("presentation feedback thread panicked");
            }
            if let Some(presentation) = &self.state().presentation {
                presentation.destroy();
            }
            if let Err(error) = self.connection.flush() {
                tracing::debug!(%error, "flushing presentation cleanup failed");
            }
        }
    }

    fn dispatch(
        mut queue: EventQueue<Dispatcher>,
        dispatcher: &mut Dispatcher,
        connection: Connection,
        shutdown: UnixStream,
    ) -> Result<(), PresentationError> {
        // winit filters wakeups that only populate a foreign libwayland queue.
        // Dispatch that queue here and explicitly request a redraw on feedback,
        // so an otherwise idle viewer can consume its next candidate immediately.
        loop {
            queue.dispatch_pending(dispatcher).map_err(error)?;
            if let Err(failure) = connection.flush()
                && !matches!(&failure, WaylandError::Io(error) if error.kind() == io::ErrorKind::WouldBlock)
            {
                return Err(error(failure));
            }
            let Some(read) = connection.prepare_read() else {
                continue;
            };
            let mut fds = [
                PollFd::new(connection.as_fd(), PollFlags::POLLIN),
                PollFd::new(shutdown.as_fd(), PollFlags::POLLIN),
            ];
            loop {
                match poll(&mut fds, PollTimeout::NONE) {
                    Err(Errno::EINTR) => continue,
                    result => {
                        result.map_err(error)?;
                        break;
                    }
                }
            }
            if fds[1].revents().is_some_and(|events| !events.is_empty()) {
                drop(read);
                return Ok(());
            }
            if let Err(failure) = read.read()
                && !matches!(&failure, WaylandError::Io(error) if error.kind() == io::ErrorKind::WouldBlock)
            {
                return Err(error(failure));
            }
        }
    }

    impl Dispatch<wl_registry::WlRegistry, ()> for Dispatcher {
        fn event(
            state: &mut Self,
            registry: &wl_registry::WlRegistry,
            event: wl_registry::Event,
            _: &(),
            _: &Connection,
            queue: &QueueHandle<Self>,
        ) {
            if let wl_registry::Event::Global {
                name,
                interface,
                version,
            } = event
                && interface == "wp_presentation"
                && version >= 1
            {
                let mut state = state.state();
                if state.presentation.is_none() {
                    state.presentation = Some(registry.bind(name, 1, queue, ()));
                }
            }
        }
    }

    impl Dispatch<wp_presentation::WpPresentation, ()> for Dispatcher {
        fn event(
            state: &mut Self,
            _: &wp_presentation::WpPresentation,
            event: wp_presentation::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wp_presentation::Event::ClockId { clk_id } = event {
                state.state().stats.clock_id = Some(clk_id);
            }
        }
    }

    impl Dispatch<wp_presentation_feedback::WpPresentationFeedback, u64> for Dispatcher {
        fn event(
            state: &mut Self,
            _: &wp_presentation_feedback::WpPresentationFeedback,
            event: wp_presentation_feedback::Event,
            id: &u64,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                wp_presentation_feedback::Event::Presented {
                    tv_sec_hi,
                    tv_sec_lo,
                    tv_nsec,
                    refresh,
                    seq_hi,
                    seq_lo,
                    ..
                } => {
                    let seconds = (u64::from(tv_sec_hi) << 32) | u64::from(tv_sec_lo);
                    let sequence = (u64::from(seq_hi) << 32) | u64::from(seq_lo);
                    state
                        .state()
                        .presented(*id, seconds, tv_nsec, refresh, sequence);
                    state.window.request_redraw();
                }
                wp_presentation_feedback::Event::Discarded => {
                    state.state().discarded(*id);
                    state.window.request_redraw();
                }
                _ => {}
            }
        }
    }

    impl Dispatch<wl_callback::WlCallback, Callback> for Dispatcher {
        fn event(
            state: &mut Self,
            _: &wl_callback::WlCallback,
            event: wl_callback::Event,
            callback: &Callback,
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wl_callback::Event::Done { .. } = event {
                match callback {
                    Callback::RegistryReady => state.state().registry_ready = true,
                    Callback::Frame(id) => state.state().frame_callback(*id),
                }
                state.window.request_redraw();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::FeedbackState;

        #[test]
        fn only_matching_presentation_feedback_releases_the_submission() {
            let mut state = FeedbackState::default();
            let first = state.reserve().unwrap();
            assert!(state.reserve().is_none());
            assert!(!state.complete(first.wrapping_add(1)));
            assert!(state.reserve().is_none());
            assert!(state.complete(first));
            let second = state.reserve().unwrap();
            assert_ne!(first, second);
            assert!(!state.complete(first));
            assert!(state.reserve().is_none());
            assert!(state.complete(second));
        }

        #[test]
        fn presentation_and_discard_feedback_release_capacity_and_preserve_distinct_counts() {
            let mut state = FeedbackState::default();
            let first = state.reserve().unwrap();
            state.presented(first, 42, 123, 16_666_667, 81);
            assert_eq!(state.stats.presented, 1);
            assert_eq!(state.stats.last_presented_ns, Some(42_000_000_123));
            assert_eq!(state.stats.sequence, Some(81));
            assert_eq!(state.stats.refresh_ns, Some(16_666_667));
            let second = state.reserve().unwrap();
            state.discarded(second);
            assert_eq!(state.stats.discarded, 1);
            assert_eq!(state.stats.presented, 1);
            assert_eq!(state.stats.last_presented_ns, Some(42_000_000_123));
            assert!(state.reserve().is_some());
        }

        #[test]
        fn frame_callback_fallback_does_not_claim_a_frame_was_displayed() {
            let mut state = FeedbackState::default();
            let first = state.reserve().unwrap();
            state.frame_callback(first);
            assert_eq!(state.stats.frame_callbacks, 1);
            assert_eq!(state.stats.presented, 0);
            assert_eq!(state.stats.discarded, 0);
            assert_eq!(state.stats.last_presented_ns, None);
            let second = state.reserve().unwrap();
            state.frame_callback(first);
            assert_eq!(state.stats.frame_callbacks, 1);
            assert_eq!(state.pending, Some(second));
        }
    }
}
