use std::cell::{Cell, RefCell};
use std::rc::Rc;

use super::{Pasteboard, ViewClipboard};
use crate::clipboard::ClipboardIntent::{Changed, Explicit, Focus, Paste};
use deskfleet_input::InputEvent;

#[derive(Default)]
struct Board {
    count: Cell<isize>,
    reads: Cell<u32>,
    contents: RefCell<Option<String>>,
    on_read: RefCell<Option<Box<dyn FnOnce()>>>,
}

impl Pasteboard for Board {
    fn change_count(&self) -> isize {
        self.count.get()
    }

    fn read_text(&self) -> Option<String> {
        self.reads.update(|n| n + 1);
        let text = self.contents.borrow().clone();
        let action = self.on_read.take();
        if let Some(action) = action {
            action();
        }
        text
    }

    fn write_text(&self, text: &str) {
        self.contents.replace(Some(text.to_owned()));
        self.count.update(|n| n + 1);
    }
}

fn view() -> ViewClipboard<Board> {
    let board = Board::default();
    board.write_text("opening");
    let view = ViewClipboard::new(board);
    view.configure(true, true);
    view
}

fn clip(text: &str) -> Option<InputEvent> {
    Some(InputEvent::Clipboard { text: text.into() })
}

#[test]
fn activation_uses_the_opening_change_count_without_reading_text() {
    let view = view();
    assert_eq!(view.local(Focus), None);
    assert_eq!(view.local(Changed), None);
    assert_eq!(view.board.reads.get(), 0);
    view.board.write_text("new");
    assert_eq!(view.local(Focus), clip("new"));
    assert_eq!(view.local(Changed), None);
    assert_eq!(view.local(Paste), None);
    assert_eq!(view.board.reads.get(), 1);
}

#[test]
fn permission_and_sharing_gate_os_reads_and_remote_writes() {
    let view = view();
    view.configure(false, true);
    view.remote("remote");
    assert_eq!(view.local(Explicit), None);
    view.configure(true, false);
    view.remote("remote");
    assert_eq!(view.local(Paste), None);
    assert_eq!(view.board.reads.get(), 0);
    assert_eq!(view.local(Explicit), clip("opening"));
}

#[test]
fn paste_is_inserted_after_release_and_before_chord_once_per_change() {
    let view = view();
    let keys = crate::nsh_keyboard::chord_events(&["MetaLeft", "KeyV"]);
    let mut first = keys.clone();
    view.before_keys(&mut first);
    assert_eq!(first.first(), Some(&InputEvent::ReleaseAll));
    assert_eq!(first.get(1), clip("opening").as_ref());
    assert_eq!(first[2..], keys[1..]);
    let mut second = keys.clone();
    view.before_keys(&mut second);
    assert_eq!(second, keys);
    view.reset_session();
    let mut physical = keys[1..].to_vec();
    view.before_keys(&mut physical);
    assert_eq!(physical.first(), clip("opening").as_ref());
}

#[test]
fn received_text_is_cleaned_and_does_not_echo_or_write_twice() {
    let view = view();
    view.remote("远\0端");
    assert_eq!(view.board.contents.borrow().as_deref(), Some("远端"));
    let count = view.board.count.get();
    view.remote("远端");
    assert_eq!(view.board.count.get(), count);
    assert_eq!(view.local(Changed), None);
    assert_eq!(view.local(Paste), None);
    assert_eq!(view.board.reads.get(), 0);
    // UIKit can publish the change count after its setter returns.
    view.board.count.update(|n| n + 1);
    assert_eq!(view.local(Changed), None);
    assert_eq!(view.local(Paste), None);
    assert_eq!(view.board.reads.get(), 1);
    view.reset_session();
    assert_eq!(view.local(Paste), clip("远端"));
}

#[test]
fn reset_during_a_pasteboard_read_discards_the_old_result() {
    let view = Rc::new(view());
    let weak = Rc::downgrade(&view);
    view.board.on_read.replace(Some(Box::new(move || {
        let view = weak.upgrade().unwrap();
        assert_eq!(view.local(Paste), None);
        view.reset_session();
    })));
    assert_eq!(view.local(Paste), None);
    assert_eq!(view.local(Paste), clip("opening"));
}
