//! Main-thread UIKit pasteboard access and notification lifetime.
#![allow(unsafe_code)]

use std::ptr::NonNull;

use block2::RcBlock;
use dispatch2::MainThreadBound;
use objc2::rc::{Retained, Weak};
use objc2::runtime::ProtocolObject;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSString,
};
use objc2_ui_kit::{
    UIApplicationDidBecomeActiveNotification, UIPasteboard, UIPasteboardChangedNotification,
};

use crate::clipboard::ClipboardIntent;
use crate::clipboard_ios::Pasteboard;
use crate::ios_window::VideoView;

pub(crate) struct SystemPasteboard {
    board: Retained<UIPasteboard>,
    _main_thread: MainThreadMarker,
}

impl SystemPasteboard {
    pub(crate) fn new(mtm: MainThreadMarker) -> Self {
        Self {
            board: UIPasteboard::generalPasteboard(),
            _main_thread: mtm,
        }
    }
}

impl Pasteboard for SystemPasteboard {
    fn change_count(&self) -> isize {
        // SAFETY: The main-thread marker confines all accesses to this pasteboard.
        unsafe { self.board.changeCount() }
    }

    fn read_text(&self) -> Option<String> {
        // SAFETY: Both non-atomic UIKit properties are read on the main thread.
        unsafe {
            self.board
                .hasStrings()
                .then(|| self.board.string())
                .flatten()
        }
        .map(|text| text.to_string())
    }

    fn write_text(&self, text: &str) {
        // SAFETY: UIKit copies the string on the main thread.
        unsafe { self.board.setString(Some(&NSString::from_str(text))) }
    }
}

pub(crate) struct ClipboardObservers([Retained<ProtocolObject<dyn NSObjectProtocol>>; 2]);

impl ClipboardObservers {
    pub(crate) fn new(view: &VideoView) -> Self {
        let center = NSNotificationCenter::defaultCenter();
        let queue = NSOperationQueue::mainQueue();
        // SAFETY: UIKit exports both immutable notification names on supported iOS versions.
        let notifications = unsafe {
            [
                (UIPasteboardChangedNotification, ClipboardIntent::Changed),
                (
                    UIApplicationDidBecomeActiveNotification,
                    ClipboardIntent::Focus,
                ),
            ]
        };
        Self(notifications.map(|(name, intent)| {
            let weak_view = MainThreadBound::new(Weak::new(view), view.mtm());
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                if let Some(mtm) = MainThreadMarker::new()
                    && let Some(view) = weak_view.get(mtm).load()
                {
                    view.sync_clipboard(intent);
                }
            });
            // SAFETY: The main operation queue executes the block. Its weak
            // reference remains valid after the view is stopped or deallocated.
            unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    Some(&queue),
                    &block,
                )
            }
        }))
    }
}

impl Drop for ClipboardObservers {
    fn drop(&mut self) {
        let center = NSNotificationCenter::defaultCenter();
        for token in &self.0 {
            // SAFETY: Each token belongs to an observer registered with this center.
            unsafe { center.removeObserver((**token).as_ref()) };
        }
    }
}
