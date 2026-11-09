//! GPUI hosts the remote video and a bounded, pure-Rust NSH control surface.

use std::cell::RefCell;
use std::rc::Rc;

use deskfleet_input::InputEvent;
use gpui::{
    AppContext, Bounds, Context, DispatchPhase, FocusHandle, InteractiveElement, IntoElement,
    KeyDownEvent, KeyUpEvent, MouseDownEvent, MouseExitEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Pixels, Point, Render, ScrollWheelEvent, Styled, Subscription, Window,
    WindowBounds, WindowOptions, canvas, div, point, px, size,
};
use serde_json::json;
use tokio::sync::watch;

use crate::gpui_input::Input;
use crate::host::Host;
use crate::input_queue;
use crate::nsh_chrome::{Chrome, ChromeHit};
use crate::nsh_session_state::SessionState;
use crate::nsh_toolbar::{self, Toolbar, ToolbarAction, ToolbarState};
use crate::nsh_video::{Video, video_bounds};
use crate::physical_input::PhysicalInput;
use crate::protocol::Status;
use crate::{Error, WindowEvent, WindowNotifier, protocol};

use crate::nsh_layout::{MARGIN, clamp_toolbar, grip_bounds};

pub(crate) fn run() -> Result<(), Error> {
    // FrameReady is emitted only when the two-candidate queue becomes nonempty.
    // The channel carries wakeups/control events, never decoded pixels.
    let (sender, events) = async_channel::unbounded();
    let host = Host::start(WindowNotifier(sender))?;
    let frames = host.frames.clone();
    let input = host.input.clone();
    let shutdown = host.shutdown.clone();
    let error = Rc::new(RefCell::new(None));
    let window_error = error.clone();
    nsh_platform_gpui::set_ui_sets(vec![nsh_base::registry()]);
    gpui_platform::application().run(move |cx| {
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        let result = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(960.), px(640.)),
                    cx,
                ))),
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some("DeskFleet desktop".into()),
                    ..Default::default()
                }),
                window_decorations: Some(gpui::WindowDecorations::Server),
                app_id: Some("io.github.yet_another_ai.deskfleet.viewer".into()),
                window_min_size: Some(size(px(460.), px(200.))),
                inactive_frame_interval: None,
                ..Default::default()
            },
            |window, cx| {
                cx.new(|cx| {
                    Viewer::new(
                        frames,
                        input,
                        shutdown,
                        events,
                        window_error.clone(),
                        window,
                        cx,
                    )
                })
            },
        );
        if let Err(reason) = result {
            *window_error.borrow_mut() = Some(reason.to_string());
            cx.quit();
        }
        cx.activate(true);
    });
    let session = host.finish();
    if let Some(error) = error.take() {
        return Err(error.into());
    }
    session
}

struct Viewer {
    title: String,
    video: Rc<RefCell<Video>>,
    input: input_queue::Sender,
    shutdown: watch::Sender<bool>,
    controls: Input,
    physical: Option<PhysicalInput>,
    handle_focused: bool,
    select_open: bool,
    toolbar: Toolbar,
    toolbar_state: ToolbarState,
    session_state: SessionState,
    hovering_local_ui: bool,
    position: Option<Point<Pixels>>,
    drag: Option<(Point<Pixels>, Point<Pixels>)>,
    local_pointer: bool,
    video_focused: bool,
    focus: FocusHandle,
    error: Rc<RefCell<Option<String>>>,
    _subscriptions: Vec<Subscription>,
}

impl Viewer {
    fn new(
        frames: crate::session::Frames,
        input: input_queue::Sender,
        shutdown: watch::Sender<bool>,
        events: async_channel::Receiver<WindowEvent>,
        error: Rc<RefCell<Option<String>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (actions_tx, actions) = async_channel::unbounded();
        let toolbar_state = ToolbarState::default();
        let toolbar = Toolbar::new(window, cx, toolbar_state.clone(), move |action| {
            let _ = actions_tx.try_send(action);
        });
        let (key_wake, keys) = async_channel::bounded(1);
        let physical = match PhysicalInput::new(window, move || {
            let _ = key_wake.try_send(());
        }) {
            Ok(physical) => Some(physical),
            Err(error) => {
                let weak = cx.weak_entity();
                window.defer(cx, move |window, cx| {
                    let _ =
                        weak.update(cx, |viewer: &mut Viewer, cx| viewer.fail(error, window, cx));
                });
                None
            }
        };
        cx.spawn_in(window, async move |viewer, cx| {
            while keys.recv().await.is_ok() {
                if viewer
                    .update_in(cx, |viewer, window, cx| viewer.keys(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        cx.spawn_in(window, async move |viewer, cx| {
            while let Ok(event) = events.recv().await {
                if viewer
                    .update_in(cx, |viewer, window, cx| viewer.event(event, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        cx.spawn_in(window, async move |viewer, cx| {
            while let Ok(action) = actions.recv().await {
                if viewer
                    .update_in(cx, |viewer, window, cx| viewer.action(action, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            let _ = weak.update(cx, |viewer, cx| viewer.close(true, window, cx));
            true
        });
        let subscriptions = vec![
            cx.observe_window_activation(window, |viewer, window, cx| {
                if !window.is_window_active() {
                    viewer.drag = None;
                    viewer.local_pointer = false;
                    viewer.release(window, cx);
                    if let Some(physical) = &viewer.physical {
                        physical.focus_lost();
                    }
                } else {
                    viewer.sync_input(window, cx);
                }
            }),
            cx.observe_window_bounds(window, |viewer, window, cx| {
                viewer.clamp_position(window);
                viewer.toolbar_state.fullscreen = window.is_fullscreen();
                cx.notify();
            }),
        ];
        Self {
            title: "DeskFleet desktop".into(),
            video: Rc::new(RefCell::new(Video::new(frames))),
            input,
            shutdown,
            controls: Input::default(),
            physical,
            handle_focused: false,
            select_open: false,
            toolbar,
            toolbar_state,
            session_state: SessionState::default(),
            hovering_local_ui: false,
            position: None,
            drag: None,
            local_pointer: false,
            video_focused: true,
            focus,
            error,
            _subscriptions: subscriptions,
        }
    }

    fn event(&mut self, event: WindowEvent, window: &mut Window, cx: &mut Context<Self>) {
        let previous_control = self.toolbar_state.ui.control;
        self.session_state
            .update(&mut self.toolbar_state.ui, &event);
        if previous_control != self.toolbar_state.ui.control
            || matches!(&event, WindowEvent::Start { .. })
        {
            self.toolbar_state.paused = false;
        }
        match event {
            WindowEvent::Start { title, .. } | WindowEvent::Ui(protocol::UiState { title, .. }) => {
                window.set_window_title(&title);
                self.title = title;
            }
            WindowEvent::Connected(_) | WindowEvent::InputReady => {}
            WindowEvent::SessionEnded => {
                self.release(window, cx);
                self.video.borrow_mut().clear(window, cx);
            }
            WindowEvent::FrameReady => {}
            WindowEvent::Close => {
                self.close(false, window, cx);
                return;
            }
            WindowEvent::Error(error) => {
                self.fail(error, window, cx);
                return;
            }
        }
        self.sync_input(window, cx);
        cx.notify();
    }

    fn keys(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let result = self.physical.as_ref().map(PhysicalInput::poll);
        match result {
            Some(Ok(events)) => self.send(events, window, cx),
            Some(Err(error)) => self.fail(error, window, cx),
            None => {}
        }
    }

    fn sync_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let enabled = self.toolbar_state.controls_enabled();
        let release = self.controls.set_enabled(enabled);
        self.send(release, window, cx);
        if let Some(physical) = &self.physical {
            physical.set_enabled(
                enabled
                    && self.video_focused
                    && window.is_window_active()
                    && !self.toolbar_state.settings_open
                    && !self.hovering_local_ui,
            );
        }
        self.keys(window, cx);
    }

    fn close(&mut self, user: bool, window: &mut Window, cx: &mut Context<Self>) {
        if user {
            let _ = protocol::emit(json!({"type":"closeRequested"}));
        }
        let _ = self.input.send(self.controls.release());
        self.physical.take();
        self.shutdown.send_replace(true);
        self.video.borrow_mut().clear(window, cx);
        window.remove_window();
    }

    fn fail(&mut self, error: impl ToString, window: &mut Window, cx: &mut Context<Self>) {
        if self.error.borrow().is_none() {
            let error = error.to_string();
            let _ = protocol::emit(json!({"type":"error", "error":error}));
            *self.error.borrow_mut() = Some(error);
        }
        self.close(false, window, cx);
    }

    fn send(
        &mut self,
        events: impl IntoIterator<Item = InputEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for event in events {
            let Some(event) = self.controls.prepare(event) else {
                continue;
            };
            if let Err(error) = self.input.send(event) {
                self.fail(error, window, cx);
                break;
            }
        }
    }

    fn release(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(physical) = &self.physical {
            physical.set_enabled(false);
        }
        let event = self.controls.release();
        self.send([event], window, cx);
    }

    fn toolbar_bounds(&self, window: &Window) -> Bounds<Pixels> {
        let content = Chrome::for_window(window).content_bounds();
        let origin = self.position.unwrap_or_else(|| {
            clamp_toolbar(
                point(
                    content.right() - px(self.toolbar_state.toolbar_size.0 + MARGIN),
                    content.origin.y + px(MARGIN),
                ),
                content,
                self.toolbar_size(),
            )
        });
        Bounds::new(origin, self.toolbar_size())
    }

    fn video_bounds(&self, window: &Window) -> Bounds<Pixels> {
        video_bounds(
            Chrome::for_window(window).content_bounds(),
            self.video.borrow().dimensions,
        )
    }

    fn panel_bounds(&self, window: &Window) -> Bounds<Pixels> {
        let content = Chrome::for_window(window).content_bounds();
        let bar = self.toolbar_bounds(window);
        let width = px(nsh_toolbar::PANEL_WIDTH.min((f32::from(content.size.width) - 24.).max(0.)));
        let height = px(self.toolbar_state.panel_height);
        let x = if bar.center().x < content.center().x {
            bar.origin.x
        } else {
            bar.right() - width
        };
        let y = if bar.origin.y > content.center().y {
            bar.origin.y - height - px(8.)
        } else {
            bar.bottom() + px(8.)
        };
        Bounds::new(
            clamp_toolbar(point(x, y), content, size(width, height)),
            size(width, height),
        )
    }

    fn toolbar_size(&self) -> gpui::Size<Pixels> {
        size(
            px(self.toolbar_state.toolbar_size.0),
            px(self.toolbar_state.toolbar_size.1),
        )
    }

    fn clamp_position(&mut self, window: &Window) {
        if let Some(position) = self.position {
            self.position = Some(clamp_toolbar(
                position,
                Chrome::for_window(window).content_bounds(),
                self.toolbar_size(),
            ));
        }
    }

    fn local_ui(&self, position: Point<Pixels>, window: &Window) -> bool {
        self.toolbar_state.settings_open
            || self.toolbar_state.ui.status != Status::Connected
            || self.toolbar_bounds(window).contains(&position)
    }

    fn resume_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.video_focused = true;
        self.hovering_local_ui = false;
        self.handle_focused = false;
        window.focus(&self.focus, cx);
    }

    fn action(&mut self, action: ToolbarAction, window: &mut Window, cx: &mut Context<Self>) {
        let event = match action {
            ToolbarAction::ToggleControl if self.toolbar_state.ui.control => {
                self.toolbar_state.paused = !self.toolbar_state.paused;
                self.release(window, cx);
                if !self.toolbar_state.paused {
                    self.resume_focus(window, cx);
                }
                None
            }
            ToolbarAction::ToggleFullscreen => {
                window.toggle_fullscreen();
                None
            }
            ToolbarAction::ToggleSettings => {
                self.toolbar_state.settings_open = !self.toolbar_state.settings_open;
                self.release(window, cx);
                None
            }
            ToolbarAction::SelectDisplay(display_id) => {
                Some(json!({"type":"selectDisplay", "displayId":display_id}))
            }
            ToolbarAction::SetControl(control) => {
                Some(json!({"type":"setControl", "control":control}))
            }
            ToolbarAction::SecureAttention
                if self.toolbar_state.controls_enabled()
                    && self.toolbar_state.ui.secure_attention =>
            {
                self.send([InputEvent::SecureAttention], window, cx);
                self.resume_focus(window, cx);
                None
            }
            ToolbarAction::Reconnect => Some(json!({"type":"reconnect"})),
            ToolbarAction::Disconnect => Some(json!({"type":"disconnect"})),
            ToolbarAction::Measured(width, height) => {
                if width.is_finite() && height.is_finite() && width > 0. && height > 0. {
                    self.toolbar_state.toolbar_size = (width, height);
                    self.clamp_position(window);
                }
                None
            }
            ToolbarAction::PanelMeasured(height) => {
                if height.is_finite() && height > 0. {
                    self.toolbar_state.panel_height = height;
                }
                None
            }
            ToolbarAction::FocusHandle => {
                self.handle_focused = true;
                None
            }
            ToolbarAction::BlurHandle => {
                self.handle_focused = false;
                None
            }
            ToolbarAction::SelectOpen(open) => {
                self.select_open = open;
                return;
            }
            ToolbarAction::ToggleControl | ToolbarAction::SecureAttention => None,
        };
        if let Some(event) = event {
            self.release(window, cx);
            if matches!(action, ToolbarAction::Reconnect | ToolbarAction::Disconnect) {
                self.toolbar_state.settings_open = false;
            }
            if let Err(error) = protocol::emit(event) {
                self.fail(error, window, cx);
                return;
            }
        }
        self.sync_input(window, cx);
        cx.notify();
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(hit) = Chrome::for_window(window).hit_test(event.position) {
            self.local_pointer = true;
            self.video_focused = false;
            self.release(window, cx);
            if event.button == gpui::MouseButton::Left {
                match hit {
                    ChromeHit::Move if event.click_count == 2 => window.zoom_window(),
                    ChromeHit::Move => window.start_window_move(),
                    ChromeHit::Minimize => window.minimize_window(),
                    ChromeHit::Maximize => window.zoom_window(),
                    ChromeHit::Close => self.close(true, window, cx),
                    ChromeHit::Resize(edge) => window.start_window_resize(edge),
                }
            }
            cx.stop_propagation();
            return;
        }
        self.local_pointer = self.local_ui(event.position, window);
        if self.toolbar_state.settings_open
            && !self.select_open
            && !self.toolbar_bounds(window).contains(&event.position)
            && !self.panel_bounds(window).contains(&event.position)
        {
            self.toolbar_state.settings_open = false;
            self.release(window, cx);
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if self.local_pointer {
            self.video_focused = false;
            self.release(window, cx);
            let toolbar = self.toolbar_bounds(window);
            if event.button == gpui::MouseButton::Left
                && grip_bounds(toolbar).contains(&event.position)
            {
                // Establish the gesture synchronously. NSH runs on another
                // thread; waiting for its grant can lose an entire fast drag.
                self.drag = Some((event.position, toolbar.origin));
                self.handle_focused = true;
                window.focus(&self.focus, cx);
                cx.stop_propagation();
            }
        } else {
            self.resume_focus(window, cx);
            self.sync_input(window, cx);
            let events = self.controls.mouse_down(event, self.video_bounds(window));
            self.send(events, window, cx);
            cx.stop_propagation();
        }
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((start, origin)) = self.drag {
            self.position = Some(clamp_toolbar(
                origin + (event.position - start),
                Chrome::for_window(window).content_bounds(),
                self.toolbar_size(),
            ));
            cx.notify();
        } else if !self.local_pointer {
            self.hovering_local_ui = self.local_ui(event.position, window)
                || Chrome::for_window(window)
                    .hit_test(event.position)
                    .is_some();
            if self.hovering_local_ui {
                self.release(window, cx);
            } else {
                self.sync_input(window, cx);
                let events = self.controls.mouse_move(event, self.video_bounds(window));
                self.send(events, window, cx);
            }
        }
    }

    fn mouse_up(&mut self, event: &MouseUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((start, origin)) = self.drag {
            self.position = Some(clamp_toolbar(
                origin + (event.position - start),
                Chrome::for_window(window).content_bounds(),
                self.toolbar_size(),
            ));
            cx.notify();
        }
        if self.local_pointer || self.drag.is_some() {
            self.local_pointer = false;
            self.drag = None;
            return;
        }
        self.keys(window, cx);
        let events = self.controls.mouse_up(event, self.video_bounds(window));
        self.send(events, window, cx);
    }

    fn scroll(&mut self, event: &ScrollWheelEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.local_ui(event.position, window)
            || Chrome::for_window(window)
                .hit_test(event.position)
                .is_some()
        {
            return;
        }
        self.keys(window, cx);
        let events = self.controls.scroll(event, self.video_bounds(window));
        self.send(events, window, cx);
        cx.stop_propagation();
    }

    fn mouse_exit(&mut self, _: &MouseExitEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.drag = None;
        self.local_pointer = false;
        self.release(window, cx);
    }

    fn install_input(&self, window: &mut Window, cx: &Context<Self>) {
        // Capture precedes NSH handling. A local control never forwards an event
        // to the remote desktop even when NSH asynchronously handles its press.
        macro_rules! mouse {
            ($event:ty, $method:ident) => {{
                let viewer = cx.weak_entity();
                window.on_mouse_event(move |event: &$event, phase, window, cx| {
                    if phase == DispatchPhase::Capture {
                        let _ = viewer.update(cx, |viewer, cx| viewer.$method(event, window, cx));
                    }
                });
            }};
        }
        mouse!(MouseDownEvent, mouse_down);
        mouse!(MouseMoveEvent, mouse_move);
        mouse!(MouseUpEvent, mouse_up);
        mouse!(ScrollWheelEvent, scroll);
        mouse!(MouseExitEvent, mouse_exit);
    }
}

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Err(error) = self.video.borrow_mut().prepare(window) {
            // Defer closure until the render borrow has ended.
            let viewer = cx.weak_entity();
            window.defer(cx, move |window, cx| {
                let _ = viewer.update(cx, |viewer, cx| viewer.fail(error, window, cx));
            });
        }
        if self.video.borrow().has_candidate() {
            window.request_animation_frame();
        }
        if self
            .session_state
            .frame_ready(&mut self.toolbar_state.ui, self.video.borrow().dimensions)
        {
            self.sync_input(window, cx);
        }
        let chrome = Chrome::for_window(window);
        let content = chrome.content_bounds();
        let bar = self.toolbar_bounds(window);
        let panel = self.panel_bounds(window);
        self.toolbar_state.fullscreen = window.is_fullscreen();
        self.toolbar_state.dark = self.toolbar_state.ui.theme.as_deref().map_or(
            matches!(
                window.appearance(),
                gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
            ),
            |theme| theme == "dark",
        );
        self.toolbar_state.viewport = (content.size.width.into(), content.size.height.into());
        self.toolbar_state.position = (
            (bar.origin.x - content.origin.x).into(),
            (bar.origin.y - content.origin.y).into(),
        );
        self.toolbar_state.panel_position = (
            (panel.origin.x - content.origin.x).into(),
            (panel.origin.y - content.origin.y).into(),
        );
        self.toolbar.update(self.toolbar_state.clone());
        let video = self.video.clone();
        let viewer = cx.weak_entity();
        div()
            .id("native-desktop")
            .relative()
            .size_full()
            .bg(gpui::rgb(
                if self.toolbar_state.ui.status == Status::Connected {
                    0x15171d
                } else {
                    crate::nsh_ui::Palette::new(self.toolbar_state.dark).surface
                },
            ))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|viewer, event: &KeyDownEvent, window, cx| {
                if viewer.handle_focused {
                    let step = match event.keystroke.key.as_str() {
                        "left" => Some((-16., 0.)),
                        "right" => Some((16., 0.)),
                        "up" => Some((0., -16.)),
                        "down" => Some((0., 16.)),
                        _ => None,
                    };
                    if let Some((x, y)) = step {
                        viewer.position =
                            Some(viewer.toolbar_bounds(window).origin + point(px(x), px(y)));
                        viewer.clamp_position(window);
                        cx.notify();
                        cx.stop_propagation();
                    }
                } else if viewer.video_focused {
                    cx.stop_propagation();
                } else if event.keystroke.key == "escape" && viewer.toolbar_state.settings_open {
                    viewer.toolbar_state.settings_open = false;
                    cx.notify();
                    cx.stop_propagation();
                }
            }))
            .on_key_up(cx.listener(|viewer, _: &KeyUpEvent, _, cx| {
                if viewer.video_focused {
                    cx.stop_propagation();
                }
            }))
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, cx| {
                        let result = video.borrow_mut().paint(bounds, window);
                        let _ = viewer.update(cx, |viewer, cx| {
                            viewer.install_input(window, cx);
                            if let Err(error) = result {
                                viewer.fail(error, window, cx);
                            }
                        });
                    },
                )
                .absolute()
                .left(content.origin.x)
                .top(content.origin.y)
                .w(content.size.width)
                .h(content.size.height),
            )
            .child(
                div()
                    .absolute()
                    .left(content.origin.x)
                    .top(content.origin.y)
                    .w(content.size.width)
                    .h(content.size.height)
                    .child(self.toolbar.view.clone()),
            )
            .child(chrome.render(&self.title))
    }
}
