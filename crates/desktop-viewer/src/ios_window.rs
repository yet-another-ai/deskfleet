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

use crate::android;
use crate::ios_keyboard::HardwareKeyboard;

#[derive(Default)]
struct VideoState {
    drawable_size: Cell<Option<(u32, u32)>>,
    stopped: Cell<bool>,
    keyboard: HardwareKeyboard,
}

define_class!(
    #[unsafe(super(UIView))]
    #[thread_kind = MainThreadOnly]
    #[name = "DeskFleetMetalVideoView"]
    #[ivars = VideoState]
    struct VideoView;

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
            let rest = self.ivars().keyboard.presses(self.mtm(), presses, true);
            if rest.count() != 0 {
                // SAFETY: The unhandled presses and original event belong to this dispatch.
                let _: () = unsafe { msg_send![super(self), pressesBegan: &*rest, withEvent: event] };
            }
        }
        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            let rest = self.ivars().keyboard.presses(self.mtm(), presses, false);
            if rest.count() != 0 {
                // SAFETY: Forwarding just the unhandled presses of this event.
                let _: () = unsafe { msg_send![super(self), pressesEnded: &*rest, withEvent: event] };
            }
        }
        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &NSSet<UIPress>, event: Option<&UIPressesEvent>) {
            let rest = self.ivars().keyboard.presses(self.mtm(), presses, false);
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
        let this = Self::alloc(mtm).set_ivars(VideoState::default());
        // SAFETY: UIView's designated initializer, with our ivars installed.
        let view: Retained<Self> = unsafe { msg_send![super(this), initWithFrame: frame] };
        view.setOpaque(true);
        view.setMultipleTouchEnabled(true);
        view.setBackgroundColor(Some(&UIColor::blackColor()));
        let layer = view.metal_layer();
        layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm_sRGB);
        layer.setFramebufferOnly(true);
        view
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
    view.ivars().stopped.set(true);
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
            .route(view.mtm(), presses, pressed, Some(composing)),
    )
}
