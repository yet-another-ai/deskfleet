//! UIKit viewer composition and Metal surface lifetime. The controller supplies
//! the IME and the native hit-test adapter for the NSH controls.

#![allow(unsafe_code)]

use std::cell::Cell;

use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::{ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSet, NSSize};
use objc2_metal::MTLPixelFormat;
use objc2_quartz_core::CAMetalLayer;
use objc2_ui_kit::{UIColor, UIPress, UIPressesEvent, UIView, UIViewAutoresizing};

use deskfleet_input::InputEvent;

use crate::android;
use crate::clipboard::ClipboardIntent;
use crate::clipboard_ios::ViewClipboard;
use crate::ios_keyboard::HardwareKeyboard;
use crate::ios_pasteboard::{ClipboardObservers, SystemPasteboard};

pub(crate) struct VideoState {
    drawable_size: Cell<Option<(u32, u32)>>,
    stopped: Cell<bool>,
    keyboard: HardwareKeyboard,
    clipboard: ViewClipboard<SystemPasteboard>,
    clipboard_target: Option<crate::ios_clipboard_delivery::Target>,
    observers: Cell<Option<ClipboardObservers>>,
}

define_class!(
    #[unsafe(super(UIView))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskFleetMetalVideoView"]
    #[ivars = VideoState]
    pub(crate) struct VideoView;

    impl VideoView {
        #[unsafe(method(layerClass))]
        fn layer_class() -> &'static AnyClass { CAMetalLayer::class() }

        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: Calls UIView's layout override on its original receiver.
            let _: () = unsafe { msg_send![super(self), layoutSubviews] };
            self.update_drawable();
        }

        #[unsafe(method(didMoveToWindow))]
        fn moved_to_window(&self) {
            // SAFETY: Calls UIView's lifecycle override on its original receiver.
            let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
            self.setNeedsLayout();
        }

        #[unsafe(method(canBecomeFirstResponder))]
        fn can_become_first_responder(&self) -> bool { true }

        #[unsafe(method(pressesBegan:withEvent:))]
        fn presses_began(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            let rest = self.ivars().keyboard.presses(self, presses, true);
            if rest.count() != 0 {
                // SAFETY: The unhandled presses and original event belong to this dispatch.
                let _: () = unsafe { msg_send![super(self), pressesBegan: &*rest, withEvent: event] };
            }
        }
        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            let rest = self.ivars().keyboard.presses(self, presses, false);
            if rest.count() != 0 {
                // SAFETY: Forwarding just the unhandled presses of this event.
                let _: () = unsafe { msg_send![super(self), pressesEnded: &*rest, withEvent: event] };
            }
        }
        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            let rest = self.ivars().keyboard.presses(self, presses, false);
            if rest.count() != 0 {
                // SAFETY: Forwarding just the unhandled presses of this event.
                let _: () = unsafe { msg_send![super(self), pressesCancelled: &*rest, withEvent: event] };
            }
        }

        #[unsafe(method(resignFirstResponder))]
        fn resign(&self) -> bool {
            // SAFETY: UIResponder's implementation returns whether it resigned.
            let resigned: bool = unsafe { msg_send![super(self), resignFirstResponder] };
            if resigned { self.ivars().keyboard.release(); }
            resigned
        }
    }
);

impl VideoView {
    fn new(frame: NSRect, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(VideoState {
            drawable_size: Cell::default(),
            stopped: Cell::default(),
            keyboard: HardwareKeyboard::default(),
            clipboard: ViewClipboard::new(SystemPasteboard::new(mtm)),
            clipboard_target: android::clipboard_target(),
            observers: Cell::default(),
        });
        // SAFETY: UIView's designated initializer, with our ivars installed.
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.setOpaque(true);
        view.setMultipleTouchEnabled(true);
        view.setBackgroundColor(Some(&UIColor::blackColor()));
        let layer = view.metal_layer();
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm_sRGB);
        layer.setFramebufferOnly(true);
        if let Some(target) = &view.ivars().clipboard_target {
            target.mount(&view);
        }
        view.ivars()
            .observers
            .set(Some(ClipboardObservers::new(&view)));
        view
    }

    pub(crate) fn stopped(&self) -> bool {
        self.ivars().stopped.get()
    }

    pub(crate) fn send_keys(&self, mut events: Vec<InputEvent>) {
        self.ivars().clipboard.before_keys(&mut events);
        if !self.stopped() {
            android::send_view_input(events);
        }
    }

    pub(crate) fn sync_clipboard(&self, intent: ClipboardIntent) {
        if let Some(clip) = self.ivars().clipboard.local(intent) {
            android::send_view_input(vec![clip]);
        }
    }

    pub(crate) fn receive_clipboard(&self, text: &str) {
        self.ivars().clipboard.remote(text);
    }

    fn metal_layer(&self) -> Retained<CAMetalLayer> {
        self.layer()
            .downcast()
            .expect("VideoView.layerClass is CAMetalLayer")
    }

    fn update_drawable(&self) {
        let Some(window) = self.window() else { return };
        let bounds = self.bounds().size;
        if self.ivars().stopped.get() || bounds.width <= 0. || bounds.height <= 0. {
            return;
        }
        #[allow(deprecated)] // UIWindow.screen supports the viewer's iOS 16 deployment target.
        let scale = window.screen().scale();
        let width = (bounds.width * scale).round().max(1.) as u32;
        let height = (bounds.height * scale).round().max(1.) as u32;
        self.setContentScaleFactor(scale);
        let layer = self.metal_layer();
        layer.setContentsScale(scale);
        let last = self.ivars().drawable_size.replace(Some((width, height)));
        if last == Some((width, height)) {
            return;
        }
        layer.setDrawableSize(NSSize::new(f64::from(width), f64::from(height)));
        if last.is_some() {
            android::resize_video_layer(width, height);
        } else {
            android::attach_video_layer(layer, width, height);
        }
    }
}

/// Installs the viewer's layers and returns the video view retained by `root`.
///
/// # Safety
/// Swift passes three live UIViews on the main thread, and retains the root
/// for as long as the returned video view or its input hooks are in use.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_mount_window(
    root: &UIView,
    keyboard: &UIView,
    controls: &UIView,
) -> *const VideoView {
    let video = VideoView::new(root.bounds(), root.mtm());
    video.setAutoresizingMask(
        UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
    );
    root.addSubview(&video);
    keyboard.setFrame(NSRect::new(NSPoint::ZERO, NSSize::new(1., 1.)));
    root.addSubview(keyboard);
    root.addSubview(controls);
    controls.setTranslatesAutoresizingMaskIntoConstraints(false);
    let safe = root.safeAreaLayoutGuide();
    for constraint in [
        controls
            .leadingAnchor()
            .constraintEqualToAnchor(&safe.leadingAnchor()),
        controls
            .trailingAnchor()
            .constraintEqualToAnchor(&safe.trailingAnchor()),
        controls
            .topAnchor()
            .constraintEqualToAnchor(&safe.topAnchor()),
        controls
            .bottomAnchor()
            .constraintEqualToAnchor(&root.keyboardLayoutGuide().topAnchor()),
    ] {
        constraint.setActive(true);
    }
    Retained::as_ptr(&video)
}

/// # Safety
/// Swift passes the live video view returned by `deskfleet_ios_mount_window` on the main thread.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_video_stop(view: &VideoView) {
    if view.ivars().stopped.replace(true) {
        return;
    }
    view.ivars().clipboard.configure(false, false);
    if let Some(target) = &view.ivars().clipboard_target {
        target.unmount(view);
    }
    view.ivars().observers.take();
    if view.ivars().drawable_size.take().is_some() {
        android::detach_video_layer();
    }
}

/// # Safety
/// Swift passes its mounted video view on the main thread.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_video_reset_keys(view: &VideoView) {
    view.ivars().keyboard.release();
}

/// # Safety
/// Swift borrows the mounted video view and UIKit press set for this main-thread
/// call. It consumes the returned +1 set of unhandled presses immediately.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_ime_presses(
    view: &VideoView,
    presses: &NSSet<UIPress>,
    pressed: bool,
    composing: bool,
) -> *const NSSet<UIPress> {
    Retained::into_raw(
        view.ivars()
            .keyboard
            .route(view, presses, pressed, Some(composing)),
    )
}

/// # Safety
/// Swift borrows its mounted view on the main thread for each state update.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_video_configure_clipboard(
    view: &VideoView,
    enabled: bool,
    sharing: bool,
) {
    if !view.stopped() {
        view.ivars().clipboard.configure(enabled, sharing);
    }
}

/// # Safety
/// Swift supplies its mounted video view on the main thread at a peer boundary.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_video_reset_session(view: &VideoView) {
    if !view.stopped() {
        if let Some(target) = &view.ivars().clipboard_target {
            target.reset(view);
        }
        view.ivars().clipboard.reset_session();
    }
}

/// # Safety
/// Swift supplies its mounted video view on the main thread for a toolbar action.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_video_sync_clipboard(view: &VideoView) {
    view.sync_clipboard(ClipboardIntent::Explicit);
}

/// # Safety
/// Swift supplies its mounted video view, if present, on the main thread.
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_touch(
    view: Option<&VideoView>,
    kind: i32,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
) {
    if let Some(view) = view {
        if matches!(kind, 4 | 10) {
            view.sync_clipboard(ClipboardIntent::Paste);
        }
        if view.stopped() {
            return;
        }
    }
    android::send_touch(kind, x, y, dx, dy);
}
