use std::time::{Duration, Instant};

use x11rb::CURRENT_TIME;
use x11rb::connection::Connection as _;
use x11rb::protocol::Event;
use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
    SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, SelectionRequestEvent, Window, WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use crate::{Result, platform};

const MAX_CLIPBOARD_BYTES: usize = 32 * 1024;
const CONVERT_TIMEOUT: Duration = Duration::from_millis(40);

pub(crate) struct Clipboard {
    window: Window,
    clipboard_atom: Atom,
    utf8_string_atom: Atom,
    targets_atom: Atom,
    text_atom: Atom,
    property_atom: Atom,
    owned_text: Option<String>,
    last_observed_owner: Option<(Window, u32)>,
    pending_conversion: bool,
}

impl Clipboard {
    pub(crate) fn new(connection: &RustConnection, root: Window) -> Result<Self> {
        let clipboard_atom = intern(connection, b"CLIPBOARD")?;
        let utf8_string_atom = intern(connection, b"UTF8_STRING")?;
        let targets_atom = intern(connection, b"TARGETS")?;
        let text_atom = intern(connection, b"TEXT")?;
        let property_atom = intern(connection, b"DESKFLEET_CLIPBOARD")?;

        let window = connection.generate_id().map_err(platform)?;
        connection
            .create_window(
                0,
                window,
                root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
            )
            .map_err(platform)?
            .check()
            .map_err(platform)?;

        let xfixes_ok = connection
            .xfixes_query_version(5, 0)
            .map_err(platform)
            .and_then(|cookie| cookie.reply().map_err(platform))
            .is_ok();
        if xfixes_ok {
            let _ = connection
                .xfixes_select_selection_input(
                    window,
                    clipboard_atom,
                    SelectionEventMask::SET_SELECTION_OWNER
                        | SelectionEventMask::SELECTION_WINDOW_DESTROY
                        | SelectionEventMask::SELECTION_CLIENT_CLOSE,
                )
                .map_err(platform)
                .and_then(|cookie| cookie.check().map_err(platform));
        }

        // Seed the initial owner so existing clipboard contents before session
        // start are not treated as a newly copied remote change.
        let initial_owner = connection
            .get_selection_owner(clipboard_atom)
            .map_err(platform)
            .and_then(|cookie| cookie.reply().map_err(platform))
            .ok()
            .map(|reply| (reply.owner, 0));

        Ok(Self {
            window,
            clipboard_atom,
            utf8_string_atom,
            targets_atom,
            text_atom,
            property_atom,
            owned_text: None,
            last_observed_owner: initial_owner,
            pending_conversion: false,
        })
    }

    pub(crate) fn set_text(&mut self, connection: &RustConnection, text: &str) -> Result<()> {
        self.owned_text = Some(text.to_owned());
        connection
            .set_selection_owner(self.window, self.clipboard_atom, CURRENT_TIME)
            .map_err(platform)?
            .check()
            .map_err(platform)?;
        self.last_observed_owner = Some((self.window, 0));
        self.pending_conversion = false;
        self.process_pending_events(connection, &mut None)?;
        Ok(())
    }

    pub(crate) fn poll_text(&mut self, connection: &RustConnection) -> Result<Option<String>> {
        let mut received = None;
        self.process_pending_events(connection, &mut received)?;
        if self.pending_conversion && received.is_none() {
            let deadline = Instant::now() + CONVERT_TIMEOUT;
            while self.pending_conversion && Instant::now() < deadline {
                self.process_pending_events(connection, &mut received)?;
                if received.is_some() || !self.pending_conversion {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            self.pending_conversion = false;
        }
        Ok(received)
    }

    pub(crate) fn cleanup(&mut self, connection: &RustConnection) {
        let _ = connection.destroy_window(self.window);
        let _ = connection.flush();
    }

    fn process_pending_events(
        &mut self,
        connection: &RustConnection,
        received: &mut Option<String>,
    ) -> Result<()> {
        while let Some(event) = connection.poll_for_event().map_err(platform)? {
            match event {
                Event::SelectionRequest(request) if request.selection == self.clipboard_atom => {
                    self.handle_selection_request(connection, request)?;
                }
                Event::SelectionClear(clear) if clear.selection == self.clipboard_atom => {
                    self.owned_text = None;
                }
                Event::XfixesSelectionNotify(notify) if notify.selection == self.clipboard_atom => {
                    if notify.owner == 0 || notify.owner == self.window {
                        self.last_observed_owner = Some((notify.owner, notify.selection_timestamp));
                        self.pending_conversion = false;
                    } else {
                        let key = (notify.owner, notify.selection_timestamp);
                        if self.last_observed_owner != Some(key) {
                            self.last_observed_owner = Some(key);
                            self.request_conversion(connection, self.utf8_string_atom)?;
                        }
                    }
                }
                Event::SelectionNotify(notify)
                    if notify.requestor == self.window
                        && notify.selection == self.clipboard_atom =>
                {
                    self.handle_selection_notify(connection, notify, received)?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn request_conversion(&mut self, connection: &RustConnection, target: Atom) -> Result<()> {
        let _ = connection.delete_property(self.window, self.property_atom);
        connection
            .convert_selection(
                self.window,
                self.clipboard_atom,
                target,
                self.property_atom,
                CURRENT_TIME,
            )
            .map_err(platform)?;
        connection.flush().map_err(platform)?;
        self.pending_conversion = true;
        Ok(())
    }

    fn handle_selection_notify(
        &mut self,
        connection: &RustConnection,
        notify: SelectionNotifyEvent,
        received: &mut Option<String>,
    ) -> Result<()> {
        if notify.property == u32::from(AtomEnum::NONE) {
            if notify.target == self.utf8_string_atom {
                // Fall back to standard STRING if the owner does not offer UTF8_STRING.
                self.request_conversion(connection, Atom::from(AtomEnum::STRING))?;
            } else {
                self.pending_conversion = false;
            }
            return Ok(());
        }

        self.pending_conversion = false;
        let reply = connection
            .get_property(
                true,
                self.window,
                self.property_atom,
                AtomEnum::ANY,
                0,
                (MAX_CLIPBOARD_BYTES / 4) as u32 + 1,
            )
            .map_err(platform)?
            .reply()
            .map_err(platform)?;

        if reply.format != 8 || reply.value.is_empty() || reply.value.len() > MAX_CLIPBOARD_BYTES {
            return Ok(());
        }
        let text = if reply.type_ == Atom::from(AtomEnum::STRING) {
            // ICCCM STRING is ISO-8859-1.
            reply.value.iter().map(|&byte| char::from(byte)).collect()
        } else {
            match String::from_utf8(reply.value) {
                Ok(text) => text,
                Err(_) => return Ok(()),
            }
        };
        let sanitized = sanitize_clipboard_text(&text);
        if !sanitized.is_empty() {
            *received = Some(sanitized);
        }
        Ok(())
    }

    fn handle_selection_request(
        &self,
        connection: &RustConnection,
        request: SelectionRequestEvent,
    ) -> Result<()> {
        let destination = if request.property == u32::from(AtomEnum::NONE) {
            request.target
        } else {
            request.property
        };
        let mut granted_property = u32::from(AtomEnum::NONE);

        if let Some(text) = &self.owned_text {
            if request.target == self.targets_atom {
                let targets = [
                    self.targets_atom,
                    self.utf8_string_atom,
                    self.text_atom,
                    Atom::from(AtomEnum::STRING),
                ];
                if connection
                    .change_property32(
                        PropMode::REPLACE,
                        request.requestor,
                        destination,
                        AtomEnum::ATOM,
                        &targets,
                    )
                    .is_ok()
                {
                    granted_property = destination;
                }
            } else if request.target == self.utf8_string_atom
                || request.target == self.text_atom
                || request.target == Atom::from(AtomEnum::STRING)
            {
                let property_type = if request.target == self.text_atom {
                    self.utf8_string_atom
                } else {
                    request.target
                };
                if connection
                    .change_property8(
                        PropMode::REPLACE,
                        request.requestor,
                        destination,
                        property_type,
                        text.as_bytes(),
                    )
                    .is_ok()
                {
                    granted_property = destination;
                }
            }
        }

        let notify = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: granted_property,
        };
        connection
            .send_event(false, request.requestor, EventMask::NO_EVENT, notify)
            .map_err(platform)?;
        connection.flush().map_err(platform)?;
        Ok(())
    }
}

fn intern(connection: &RustConnection, name: &[u8]) -> Result<Atom> {
    Ok(connection
        .intern_atom(false, name)
        .map_err(platform)?
        .reply()
        .map_err(platform)?
        .atom)
}

fn sanitize_clipboard_text(text: &str) -> String {
    text.replace('\0', "")
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn sanitizes_embedded_nul_bytes() {
        assert_eq!(sanitize_clipboard_text("a\0b"), "ab");
    }
}
