//! Indirect pointer events on the native iOS video surface. UIKit hit testing keeps
//! toolbar events on their own view. Physical pointers use video coordinates
//! even when the touch surface is configured as a relative trackpad.

#![allow(unsafe_code)]

use std::cell::Cell;
use std::ffi::c_void;

use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel,
};
use objc2_core_foundation::CGPoint;
use objc2_foundation::{NSArray, NSNumber, NSSet};
use objc2_ui_kit::{
    UIEvent, UIGestureRecognizer, UIGestureRecognizerState as State, UIHoverGestureRecognizer,
    UIPanGestureRecognizer, UIScrollTypeMask, UITouch, UITouchType, UIView,
};

use crate::android::{send_pointer, send_touch};
use crate::clipboard::ClipboardIntent;
use crate::input::PointerPhase;
use crate::ios_window::VideoView;

#[derive(Default)]
struct Settings {
    reverse_scroll: Cell<bool>,
}

define_class!(
    // SAFETY: all selectors below implement UIKit recognizer methods or our
    // own main-thread target/actions with their corresponding signatures.
    #[unsafe(super(UIGestureRecognizer))]
    #[name = "DeskFleetPointerRecognizer"]
    #[ivars = Settings]
    struct PointerRecognizer;

    impl PointerRecognizer {
        #[unsafe(method(touchesBegan:withEvent:))]
        fn began(&self, touches: &NSSet<UITouch>, event: &UIEvent) {
            self.sample(touches, PointerPhase::Begin(buttons(event)));
            self.setState(State::Began);
        }

        #[unsafe(method(touchesMoved:withEvent:))]
        fn moved(&self, touches: &NSSet<UITouch>, event: &UIEvent) {
            self.sample(touches, PointerPhase::Drag(buttons(event)));
            self.setState(State::Changed);
        }

        #[unsafe(method(touchesEnded:withEvent:))]
        fn ended(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.sample(touches, PointerPhase::End);
            self.setState(State::Ended);
        }

        #[unsafe(method(touchesCancelled:withEvent:))]
        fn cancelled(&self, touches: &NSSet<UITouch>, _event: &UIEvent) {
            self.sample(touches, PointerPhase::End);
            self.setState(State::Cancelled);
        }

        #[unsafe(method(pointerHover:))]
        fn hover(&self, recognizer: &UIHoverGestureRecognizer) {
            if !self.isEnabled() || !matches!(state(recognizer), State::Began | State::Changed) {
                return;
            }
            if let Some(view) = self.view() {
                let point = recognizer.locationInView(Some(&view));
                send_pointer(PointerPhase::Hover, pixels(point, &view));
            }
        }

        #[unsafe(method(pointerScroll:))]
        fn scroll(&self, recognizer: &UIPanGestureRecognizer) {
            let Some(view) = self.view() else { return };
            let delta = recognizer.translationInView(Some(&view));
            recognizer.setTranslation_inView(CGPoint::ZERO, Some(&view));
            if !self.isEnabled() || !matches!(state(recognizer), State::Began | State::Changed | State::Ended)
                || delta == CGPoint::ZERO {
                return;
            }
            let (x, y) = pixels(recognizer.locationInView(Some(&view)), &view);
            let direction = if self.ivars().reverse_scroll.get() { 1. } else { -1. };
            // UIKit reports scroll distances in logical points, as do the
            // desktop viewer and browser's pixel-mode wheel events.
            send_touch(5, x, y, direction * delta.x, direction * delta.y);
        }
    }
);

impl PointerRecognizer {
    fn sample(&self, touches: &NSSet<UITouch>, phase: PointerPhase) {
        if let Some(view) = self.view().and_then(|v| v.downcast::<VideoView>().ok())
            && !view.stopped()
            && let Some(touch) = touches.anyObject()
        {
            if self.isEnabled()
                && matches!(phase, PointerPhase::Begin(buttons) if buttons & !1 != 0)
            {
                view.sync_clipboard(ClipboardIntent::Paste);
            }
            send_pointer(phase, pixels(touch.locationInView(Some(&view)), &view));
        }
    }
}

fn buttons(event: &UIEvent) -> u8 {
    // Only the first five device buttons are represented on the wire.
    (event.buttonMask().bits() & 0x1f) as u8
}

fn pixels(point: CGPoint, view: &UIView) -> (f64, f64) {
    let scale = view.contentScaleFactor();
    (point.x * scale, point.y * scale)
}

fn state(recognizer: &UIGestureRecognizer) -> State {
    // SAFETY: UIGestureRecognizer.state is the public readonly property with
    // this enum return type. objc2-ui-kit 0.3 only exposes its protected setter.
    unsafe { msg_send![recognizer, state] }
}

/// Returns a recognizer borrowed from the video view's hierarchy.
///
/// # Safety
/// `video` must be a live UIView owned by the main-thread caller.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_pointer_install(video: *mut c_void) -> *mut c_void {
    let Some(mtm) = MainThreadMarker::new() else {
        return std::ptr::null_mut();
    };
    // SAFETY: Swift passes its live, strongly owned video UIView.
    let Some(view) = (unsafe { video.cast::<UIView>().as_ref() }) else {
        return std::ptr::null_mut();
    };

    let allocated = PointerRecognizer::alloc(mtm).set_ivars(Settings::default());
    // SAFETY: initialize the UIGestureRecognizer superclass after our ivars.
    let pointer: Retained<PointerRecognizer> = unsafe { msg_send![super(allocated), init] };
    let indirect =
        NSArray::from_retained_slice(&[NSNumber::new_isize(UITouchType::IndirectPointer.0)]);
    pointer.setAllowedTouchTypes(&indirect);
    pointer.setAllowedPressTypes(&NSArray::new());
    pointer.setEnabled(false);
    view.addGestureRecognizer(&pointer);

    // SAFETY: the selectors are defined above. UIKit's view owns the target
    // and both recognizers throughout their use.
    let (hover, scroll) = unsafe {
        (
            UIHoverGestureRecognizer::initWithTarget_action(
                UIHoverGestureRecognizer::alloc(mtm),
                Some(&pointer),
                Some(sel!(pointerHover:)),
            ),
            UIPanGestureRecognizer::initWithTarget_action(
                UIPanGestureRecognizer::alloc(mtm),
                Some(&pointer),
                Some(sel!(pointerScroll:)),
            ),
        )
    };
    hover.setAllowedTouchTypes(&indirect);
    view.addGestureRecognizer(&hover);
    scroll.setAllowedTouchTypes(&NSArray::new());
    scroll.setAllowedScrollTypesMask(UIScrollTypeMask::All);
    view.addGestureRecognizer(&scroll);
    std::ptr::from_ref(&*pointer).cast_mut().cast()
}

/// # Safety
/// `handle` is borrowed from `deskfleet_ios_pointer_install`. Call on the
/// main thread while the video view still owns its recognizers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deskfleet_ios_pointer_configure(
    handle: *mut c_void,
    enabled: bool,
    reverse_scroll: bool,
) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    // SAFETY: the caller keeps the UIView holding this recognizer alive.
    if let Some(pointer) = unsafe { handle.cast::<PointerRecognizer>().as_ref() } {
        pointer.ivars().reverse_scroll.set(reverse_scroll);
        if pointer.isEnabled() != enabled {
            pointer.setEnabled(enabled);
        }
    }
}
