//! Android JNI bridge, surface lifecycle, and shallow-FIFO presentation worker.

#![allow(unsafe_code)]

use std::io;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use deskfleet_input::InputEvent;
#[cfg(target_os = "android")]
use jni::objects::{JClass, JObject, JString, JValue};
#[cfg(target_os = "android")]
use jni::sys::{jdouble, jint, jstring};
#[cfg(target_os = "android")]
use jni::{EnvUnowned, jni_sig, jni_str};
#[cfg(target_os = "android")]
use ndk::native_window::NativeWindow;
use serde_json::json;
use tokio::sync::{mpsc, watch};

use crate::input::normalized_point;
use crate::input_queue;
use crate::protocol::{self, Command};
use crate::queue::FrameQueue;
#[cfg(target_os = "ios")]
use crate::renderer::NativeWindow;
use crate::renderer::{PhysicalSize, Renderer};
use crate::session::{self, Frames};
use crate::{Error, WindowEvent};

#[derive(Clone)]
pub(crate) struct AndroidNotifier {
    tx: mpsc::UnboundedSender<RenderCommand>,
}

impl AndroidNotifier {
    pub(crate) fn send_event(&self, event: WindowEvent) -> Result<(), Error> {
        self.tx
            .send(RenderCommand::Window(event))
            .map_err(|_| "Android render worker closed".into())
    }
}

enum RenderCommand {
    Window(WindowEvent),
    SurfaceAttached {
        window: NativeWindow,
        width: u32,
        height: u32,
    },
    SurfaceResized {
        width: u32,
        height: u32,
    },
    SurfaceDestroyed,
    Touch {
        kind: i32,
        x: f64,
        y: f64,
        dx: f64,
        dy: f64,
    },
    Stop,
}

struct ActiveSession {
    commands_tx: mpsc::Sender<Command>,
    render_tx: mpsc::UnboundedSender<RenderCommand>,
    shutdown: watch::Sender<bool>,
    render_thread: Option<JoinHandle<()>>,
    runtime_thread: Option<JoinHandle<()>>,
}

static ACTIVE: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();

fn active_slot() -> &'static Mutex<Option<ActiveSession>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

impl ActiveSession {
    fn stop(&mut self) {
        self.shutdown.send_replace(true);
        let _ = self.commands_tx.try_send(Command::Close);
        let _ = self.render_tx.send(RenderCommand::Stop);
        if let Some(handle) = self.render_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.runtime_thread.take() {
            let _ = handle.join();
        }
        protocol::set_emitter(None);
    }
}

struct AndroidViewer {
    frames: Frames,
    input: input_queue::Sender,
    shutdown: watch::Sender<bool>,
    renderer: Option<Renderer>,
    control: bool,
    redraw: bool,
    submitted: u64,
    last_stats: Instant,
    last_ready_age_ms: f64,
}

impl AndroidViewer {
    fn new(frames: Frames, input: input_queue::Sender, shutdown: watch::Sender<bool>) -> Self {
        Self {
            frames,
            input,
            shutdown,
            renderer: None,
            control: false,
            redraw: true,
            submitted: 0,
            last_stats: Instant::now(),
            last_ready_age_ms: 0.,
        }
    }

    fn run(mut self, mut rx: mpsc::UnboundedReceiver<RenderCommand>) {
        loop {
            let cmd = if self.needs_render() {
                match rx.try_recv() {
                    Ok(cmd) => Some(cmd),
                    Err(mpsc::error::TryRecvError::Empty) => None,
                    Err(mpsc::error::TryRecvError::Disconnected) => break,
                }
            } else {
                rx.blocking_recv()
            };

            let res = match cmd {
                Some(cmd) => self.handle(cmd),
                None => self.render().map(|()| false),
            };
            match res {
                Ok(true) => break,
                Ok(false) => {}
                Err(error) => {
                    let _ = protocol::emit(json!({"type":"error", "error":error.to_string()}));
                    self.shutdown.send_replace(true);
                    break;
                }
            }
        }
    }

    fn needs_render(&self) -> bool {
        self.renderer.is_some() && (self.redraw || self.frames.lock().is_ok_and(|q| !q.is_empty()))
    }

    fn handle(&mut self, cmd: RenderCommand) -> Result<bool, Error> {
        match cmd {
            RenderCommand::Window(WindowEvent::Start { title, control, .. }) => {
                tracing::info!(%title, control, "Android viewer started");
                self.control = control;
            }
            RenderCommand::Window(WindowEvent::FrameReady) => {}
            RenderCommand::SurfaceAttached {
                window,
                width,
                height,
            } => {
                let size = PhysicalSize::new(width.max(1), height.max(1));
                self.renderer = Some(pollster::block_on(Renderer::new(window, size))?);
                self.redraw = true;
            }
            RenderCommand::SurfaceResized { width, height } => {
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(PhysicalSize::new(width, height));
                    self.redraw = true;
                }
            }
            RenderCommand::SurfaceDestroyed => {
                let _ = self.input.send(InputEvent::ReleaseAll);
                self.renderer = None;
            }
            RenderCommand::Touch { kind: 7, .. } => {
                let _ = protocol::emit(json!({"type":"closeRequested"}));
                let _ = self.input.send(InputEvent::ReleaseAll);
                self.shutdown.send_replace(true);
                return Ok(true);
            }
            RenderCommand::Touch { kind, x, y, dx, dy } if self.control => {
                self.handle_touch(kind, (x, y), (dx, dy))?;
            }
            RenderCommand::Touch { .. } => {}
            RenderCommand::Stop => return Ok(true),
        }
        Ok(false)
    }

    fn handle_touch(&self, kind: i32, pos: (f64, f64), delta: (f64, f64)) -> Result<(), Error> {
        if kind == 6 {
            let _ = self.input.send(InputEvent::ReleaseAll);
            return Ok(());
        }
        let Some(renderer) = self.renderer.as_ref() else {
            return Ok(());
        };
        let Some((x, y)) =
            normalized_point(pos, renderer.surface_size(), renderer.video_size, kind == 2)
        else {
            return Ok(());
        };
        match kind {
            0 => self.input.send(InputEvent::PointerMove { x, y })?,
            1 => {
                self.input.send(InputEvent::PointerMove { x, y })?;
                self.input.send(InputEvent::PointerButton {
                    button: 0,
                    pressed: true,
                    x,
                    y,
                })?;
            }
            2 => self.input.send(InputEvent::PointerButton {
                button: 0,
                pressed: false,
                x,
                y,
            })?,
            3 | 4 => {
                let button = if kind == 3 { 0 } else { 2 };
                self.input.send(InputEvent::PointerMove { x, y })?;
                self.input.send(InputEvent::PointerButton {
                    button,
                    pressed: true,
                    x,
                    y,
                })?;
                self.input.send(InputEvent::PointerButton {
                    button,
                    pressed: false,
                    x,
                    y,
                })?;
            }
            5 => self.input.send(InputEvent::Wheel {
                delta_x: delta.0.clamp(-10_000., 10_000.),
                delta_y: delta.1.clamp(-10_000., 10_000.),
            })?,
            _ => {}
        }
        Ok(())
    }

    fn render(&mut self) -> Result<(), Error> {
        let Some(renderer) = &mut self.renderer else {
            return Ok(());
        };
        if !self.redraw
            && self
                .frames
                .lock()
                .map_err(|_| "decoded queue poisoned")?
                .is_empty()
        {
            return Ok(());
        }
        let Some(output) = renderer.acquire()? else {
            std::thread::sleep(Duration::from_millis(2));
            return Ok(());
        };
        renderer.upload_next(
            &self.frames,
            &mut self.submitted,
            &mut self.last_ready_age_ms,
        )?;
        renderer.draw(output)?;
        self.redraw = false;
        if self.last_stats.elapsed() >= Duration::from_secs(1) {
            let frames = self.frames.lock().map_err(|_| "decoded queue poisoned")?;
            let (width, height) = renderer.video_size;
            protocol::emit(json!({
                "type":"stats",
                "decodedFrames":frames.received,
                "submittedFrames":self.submitted,
                "droppedFrames":frames.dropped,
                "width":width,
                "height":height,
                "maxCandidates":frames.max_candidates,
                "readyToSubmitMs":self.last_ready_age_ms,
                "presentationMode":"fifo-hint",
            }))?;
            self.last_stats = Instant::now();
        }
        Ok(())
    }
}

fn send_render(cmd: RenderCommand) {
    if let Ok(guard) = active_slot().lock()
        && let Some(active) = guard.as_ref()
    {
        let _ = active.render_tx.send(cmd);
    }
}

fn start_session(emitter: Box<dyn Fn(String) -> io::Result<()> + Send + Sync>) {
    if let Ok(mut guard) = active_slot().lock()
        && let Some(mut previous) = guard.take()
    {
        previous.stop();
    }
    protocol::set_emitter(Some(emitter));

    let frames = Arc::new(Mutex::new(FrameQueue::default()));
    let (commands_tx, commands) = mpsc::channel(32);
    let (input, inputs) = input_queue::channel();
    let (shutdown, shutdown_rx) = watch::channel(false);
    let (render_tx, render_rx) = mpsc::unbounded_channel();
    let notifier = AndroidNotifier {
        tx: render_tx.clone(),
    };

    let render_frames = Arc::clone(&frames);
    let render_shutdown = shutdown.clone();
    let render_thread = std::thread::Builder::new()
        .name("android viewer render".into())
        .spawn(move || AndroidViewer::new(render_frames, input, render_shutdown).run(render_rx))
        .ok();

    let runtime_shutdown = shutdown.clone();
    let runtime_render_tx = render_tx.clone();
    let runtime_thread = std::thread::Builder::new()
        .name("android viewer session".into())
        .spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            else {
                let _ = protocol::emit(
                    json!({"type":"error", "error":"failed to create Tokio runtime"}),
                );
                return;
            };
            if let Err(error) = runtime.block_on(session::run(
                commands,
                inputs,
                frames,
                notifier,
                shutdown_rx,
            )) {
                let _ = protocol::emit(json!({"type":"error", "error":error.to_string()}));
            }
            runtime_shutdown.send_replace(true);
            let _ = runtime_render_tx.send(RenderCommand::Stop);
            runtime.shutdown_timeout(Duration::from_secs(2));
            let _ = protocol::emit(json!({"type":"closed"}));
        })
        .ok();

    if let Ok(mut guard) = active_slot().lock() {
        *guard = Some(ActiveSession {
            commands_tx,
            render_tx,
            shutdown,
            render_thread,
            runtime_thread,
        });
    }
}

fn send_command(raw: &str) {
    match serde_json::from_str::<Command>(raw) {
        Ok(command) => {
            let tx = active_slot()
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|s| s.commands_tx.clone()));
            if let Some(tx) = tx {
                let _ = tx.blocking_send(command);
            }
        }
        Err(error) => {
            let _ = protocol::emit(json!({"type":"error", "error":error.to_string()}));
        }
    }
}

fn stop_session() {
    if let Some(mut session) = active_slot().lock().ok().and_then(|mut g| g.take()) {
        session.stop();
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeStart<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    callback: JObject<'local>,
) {
    unowned_env
        .with_env(|env| -> Result<(), jni::errors::Error> {
            let vm = env.get_java_vm()?;
            let callback_ref = env.new_global_ref(callback)?;
            start_session(Box::new(move |payload: String| {
                vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
                    let jstr = JString::from_str(env, &payload)?;
                    env.call_method(
                        &callback_ref,
                        jni_str!("onViewerEvent"),
                        jni_sig!("(Ljava/lang/String;)V"),
                        &[JValue::Object(jstr.as_ref())],
                    )?;
                    Ok(())
                })
                .map_err(|error| io::Error::other(error.to_string()))
            }));
            Ok(())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeSendCommand<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    command_json: JString<'local>,
) {
    unowned_env
        .with_env(|_env| -> Result<(), jni::errors::Error> {
            send_command(&command_json.to_string());
            Ok(())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeStop<
    'local,
>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
) {
    stop_session();
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeSurfaceCreated<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    surface: JObject<'local>,
    width: jint,
    height: jint,
) {
    unowned_env
        .with_env(|env| -> Result<(), jni::errors::Error> {
            if !surface.is_null() {
                // SAFETY: `env.get_raw()` is the active JNIEnv pointer and `surface` is a live `Surface`.
                let window = unsafe {
                    NativeWindow::from_surface(env.get_raw().cast(), surface.as_raw().cast())
                };
                if let Some(window) = window {
                    send_render(RenderCommand::SurfaceAttached {
                        window,
                        width: u32::try_from(width.max(1)).unwrap_or(1),
                        height: u32::try_from(height.max(1)).unwrap_or(1),
                    });
                }
            }
            Ok(())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeSurfaceChanged<
    'local,
>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    width: jint,
    height: jint,
) {
    send_render(RenderCommand::SurfaceResized {
        width: u32::try_from(width.max(0)).unwrap_or(0),
        height: u32::try_from(height.max(0)).unwrap_or(0),
    });
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeSurfaceDestroyed<
    'local,
>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
) {
    send_render(RenderCommand::SurfaceDestroyed);
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeTouch<
    'local,
>(
    _unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    kind: jint,
    x: jdouble,
    y: jdouble,
    dx: jdouble,
    dy: jdouble,
) {
    send_render(RenderCommand::Touch { kind, x, y, dx, dy });
}

fn format_nat_response(result: Result<deskfleet_native::nat::NatTestResult, String>) -> String {
    match result {
        Ok(res) => json!({
            "result": {
                "server": res.server.to_string(),
                "localAddress": res.local_address.to_string(),
                "publicAddress": res.public_address.map(|address| address.to_string()),
                "mapping": res.mapping.as_str(),
                "filtering": res.filtering.as_str(),
                "status": res.status.as_str(),
                "durationMs": u32::try_from(res.duration.as_millis()).unwrap_or(u32::MAX),
            }
        })
        .to_string(),
        Err(error) => json!({ "error": error }).to_string(),
    }
}

fn test_nat_json(server: &str) -> String {
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
        .and_then(|runtime| {
            runtime
                .block_on(deskfleet_native::nat::test_nat(server))
                .map_err(|error| error.to_string())
        });
    format_nat_response(result)
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_yet_1another_1ai_deskfleet_nativedesktop_DeskFleetBridge_nativeTestNat<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    server: JString<'local>,
) -> jstring {
    unowned_env
        .with_env(|env| -> Result<jstring, jni::errors::Error> {
            let payload = test_nat_json(&server.to_string());
            let jstr = JString::from_str(env, &payload)?;
            Ok(jstr.into_raw())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_ios_start(
    on_event: Option<unsafe extern "C" fn(*const std::ffi::c_char)>,
) {
    let Some(on_event) = on_event else { return };
    start_session(Box::new(move |payload| {
        if let Ok(cstr) = std::ffi::CString::new(payload) {
            // SAFETY: `cstr` is a valid NUL-terminated string for the duration of this call.
            unsafe { on_event(cstr.as_ptr()) };
        }
        Ok(())
    }));
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_send_command(command_json: *const std::ffi::c_char) {
    if !command_json.is_null() {
        // SAFETY: Caller guarantees `command_json` is a valid NUL-terminated UTF-8 string.
        if let Ok(cmd) = unsafe { std::ffi::CStr::from_ptr(command_json) }.to_str() {
            send_command(cmd);
        }
    }
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_ios_stop() {
    stop_session();
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_surface_created(
    layer: *mut std::ffi::c_void,
    width: u32,
    height: u32,
) {
    if let Some(layer) = std::ptr::NonNull::new(layer) {
        // SAFETY: Caller guarantees `layer` is a live `CAMetalLayer` object.
        let window = unsafe { NativeWindow::retain_layer(layer) };
        send_render(RenderCommand::SurfaceAttached {
            window,
            width: width.max(1),
            height: height.max(1),
        });
    }
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_ios_surface_changed(width: u32, height: u32) {
    send_render(RenderCommand::SurfaceResized { width, height });
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_ios_surface_destroyed() {
    send_render(RenderCommand::SurfaceDestroyed);
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub extern "C" fn deskfleet_ios_touch(kind: i32, x: f64, y: f64, dx: f64, dy: f64) {
    send_render(RenderCommand::Touch { kind, x, y, dx, dy });
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_test_nat(
    server: *const std::ffi::c_char,
) -> *mut std::ffi::c_char {
    let server = if server.is_null() {
        Err("Missing STUN server".to_owned())
    } else {
        // SAFETY: Caller guarantees `server` is a valid NUL-terminated UTF-8 string.
        unsafe { std::ffi::CStr::from_ptr(server) }
            .to_str()
            .map_err(|error| error.to_string())
    };
    let payload = match server {
        Ok(server) => test_nat_json(server),
        Err(error) => format_nat_response(Err(error)),
    };
    std::ffi::CString::new(payload).map_or(std::ptr::null_mut(), std::ffi::CString::into_raw)
}

#[cfg(target_os = "ios")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_string_free(ptr: *mut std::ffi::c_char) {
    if !ptr.is_null() {
        // SAFETY: `ptr` was allocated by `CString::into_raw` in `deskfleet_ios_test_nat`.
        unsafe { drop(std::ffi::CString::from_raw(ptr)) };
    }
}
