//! These tests operate the supplied disposable X server. Run under Xvfb with
//! --ignored --test-threads=1; never point them at a user's working desktop.
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::randr::{ConnectionExt as _, GetCrtcInfoReply};
use x11rb::protocol::xproto::{
    ConnectionExt as _, CreateGCAux, CreateWindowAux, EventMask, KeyButMask, Rectangle, WindowClass,
};
use x11rb::rust_connection::RustConnection;

use crate::{Capture, Error, InputConnection, display, keys};

#[test]
#[ignore = "operates a disposable Xvfb server"]
fn x11_capture_reads_real_window_pixels_and_stop_is_bounded() {
    let connection = display::connect().unwrap();
    let source = display::enumerate(&connection).unwrap().remove(0);
    let window = connection.generate_id().unwrap();
    connection
        .create_window(
            0,
            window,
            source.root,
            source.x + 8,
            source.y + 8,
            48,
            32,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().override_redirect(1),
        )
        .unwrap()
        .check()
        .unwrap();
    connection.map_window(window).unwrap().check().unwrap();
    let gc = connection.generate_id().unwrap();
    connection
        .create_gc(gc, window, &CreateGCAux::new().foreground(0x33_6699))
        .unwrap()
        .check()
        .unwrap();
    connection
        .poly_fill_rectangle(
            window,
            gc,
            &[Rectangle {
                x: 0,
                y: 0,
                width: 48,
                height: 32,
            }],
        )
        .unwrap()
        .check()
        .unwrap();
    let capture = Capture::new(source.id, 30.0, false).unwrap();
    let frame = capture.next_frame(Duration::from_secs(2)).unwrap().unwrap();
    let offset = (16 * frame.width as usize + 16) * 4;
    assert_eq!(&frame.pixels[offset..offset + 4], &[0x99, 0x66, 0x33, 255]);
    let started = Instant::now();
    let _ = capture.next_frame(Duration::ZERO).unwrap();
    assert!(started.elapsed() < Duration::from_millis(50));
    let started = Instant::now();
    capture.stop().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(matches!(
        capture.next_frame(Duration::ZERO),
        Err(Error::Stopped)
    ));
    connection.destroy_window(window).unwrap().check().unwrap();
    connection.free_gc(gc).unwrap().check().unwrap();
}

#[test]
#[ignore = "injects events into a disposable Xvfb server"]
fn x11_input_moves_pointer_and_releases_held_keys_and_buttons_on_drop() {
    let connection = display::connect().unwrap();
    let source = display::enumerate(&connection).unwrap().remove(0);
    let mut input = InputConnection::new(source.id).unwrap();
    input.move_pointer(0.25, 0.75).unwrap();
    let pointer = connection
        .query_pointer(source.root)
        .unwrap()
        .reply()
        .unwrap();
    assert_eq!(
        pointer.root_x,
        source.x + (f64::from(source.width - 1) * 0.25).round() as i16
    );
    assert_eq!(
        pointer.root_y,
        source.y + (f64::from(source.height - 1) * 0.75).round() as i16
    );
    input.key(30, true).unwrap();
    input.button(0x110, true).unwrap();
    // Negotiate XKB on the observing connection before reading its key names.
    crate::input::initialize(&connection).unwrap();
    let keycode = keys::resolve(&connection, 30).unwrap();
    assert!(key_pressed(&connection, keycode));
    assert!(
        connection
            .query_pointer(source.root)
            .unwrap()
            .reply()
            .unwrap()
            .mask
            .contains(KeyButMask::BUTTON1)
    );
    drop(input);
    assert!(!key_pressed(&connection, keycode));
    assert!(
        !connection
            .query_pointer(source.root)
            .unwrap()
            .reply()
            .unwrap()
            .mask
            .contains(KeyButMask::BUTTON1)
    );
}

fn key_pressed(connection: &RustConnection, keycode: u8) -> bool {
    let keys = connection.query_keymap().unwrap().reply().unwrap().keys;
    keys[usize::from(keycode / 8)] & (1 << (keycode % 8)) != 0
}

struct RestoreCrtc<'a> {
    connection: &'a RustConnection,
    root: u32,
    crtc: u32,
    info: GetCrtcInfoReply,
}

impl Drop for RestoreCrtc<'_> {
    fn drop(&mut self) {
        let resources = self
            .connection
            .randr_get_screen_resources_current(self.root)
            .unwrap()
            .reply()
            .unwrap();
        self.connection
            .randr_set_crtc_config(
                self.crtc,
                0,
                resources.config_timestamp,
                self.info.x,
                self.info.y,
                self.info.mode,
                self.info.rotation,
                &self.info.outputs,
            )
            .unwrap()
            .reply()
            .unwrap();
    }
}

#[test]
#[ignore = "temporarily disables an output on a disposable Xvfb server"]
fn x11_monitor_removal_invalidates_capture_and_latches_input_failure() {
    let connection = display::connect().unwrap();
    let source = display::enumerate(&connection).unwrap().remove(0);
    let resources = connection
        .randr_get_screen_resources_current(source.root)
        .unwrap()
        .reply()
        .unwrap();
    assert!(
        resources.crtcs.contains(&source.id),
        "test needs an active RandR CRTC"
    );
    let info = connection
        .randr_get_crtc_info(source.id, resources.config_timestamp)
        .unwrap()
        .reply()
        .unwrap();
    let capture = Capture::new(source.id, 30.0, false).unwrap();
    capture.next_frame(Duration::from_secs(2)).unwrap().unwrap();
    let mut input = InputConnection::new(source.id).unwrap();
    input.key(30, true).unwrap();
    crate::input::initialize(&connection).unwrap();
    let keycode = keys::resolve(&connection, 30).unwrap();
    let restore = RestoreCrtc {
        connection: &connection,
        root: source.root,
        crtc: source.id,
        info,
    };
    let changed = connection
        .randr_set_crtc_config(
            source.id,
            0,
            resources.config_timestamp,
            0,
            0,
            0,
            restore.info.rotation,
            &[],
        )
        .unwrap()
        .reply()
        .unwrap();
    assert_eq!(changed.status, x11rb::protocol::randr::SetConfig::SUCCESS);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match capture.next_frame(Duration::from_millis(100)) {
            Err(Error::StaleSource) => break,
            Err(error) => panic!("unexpected capture failure: {error}"),
            _ => assert!(
                Instant::now() < deadline,
                "capture kept a removed source alive"
            ),
        }
    }
    assert!(matches!(
        input.move_pointer(0.5, 0.5),
        Err(Error::StaleSource)
    ));
    assert!(matches!(input.key(31, true), Err(Error::StaleSource)));
    input.key(30, false).unwrap();
    assert!(!key_pressed(&connection, keycode));
    capture.stop().unwrap();
    drop(restore);
}

#[test]
#[ignore = "injects scroll into a disposable Xvfb server"]
fn x11_wheel_preserves_partial_deltas_and_emits_one_tick() {
    let connection = display::connect().unwrap();
    let source = display::enumerate(&connection).unwrap().remove(0);
    connection
        .change_window_attributes(
            source.root,
            &x11rb::protocol::xproto::ChangeWindowAttributesAux::new()
                .event_mask(EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE),
        )
        .unwrap()
        .check()
        .unwrap();
    let mut input = InputConnection::new(source.id).unwrap();
    input.move_pointer(0.9, 0.9).unwrap();
    input.wheel(0.0, 60.0).unwrap();
    assert!(connection.poll_for_event().unwrap().is_none());
    input.wheel(0.0, 60.0).unwrap();
    // A reply orders the observation after XTEST's queued button events.
    connection
        .query_pointer(source.root)
        .unwrap()
        .reply()
        .unwrap();
    let mut events = Vec::new();
    while let Some(event) = connection.poll_for_event().unwrap() {
        match event {
            x11rb::protocol::Event::ButtonPress(event) => events.push((true, event.detail)),
            x11rb::protocol::Event::ButtonRelease(event) => events.push((false, event.detail)),
            _ => (),
        }
    }
    assert_eq!(events, [(true, 5), (false, 5)]);
}

struct ReleaseServer<'a>(&'a RustConnection);

impl Drop for ReleaseServer<'_> {
    fn drop(&mut self) {
        self.0.ungrab_server().unwrap().check().unwrap();
    }
}

#[test]
#[ignore = "briefly grabs a disposable Xvfb server"]
fn x11_stop_interrupts_capture_waiting_for_a_server_reply() {
    let connection = display::connect().unwrap();
    let source = display::enumerate(&connection).unwrap().remove(0);
    let capture = Capture::new(source.id, 60.0, false).unwrap();
    capture.next_frame(Duration::from_secs(2)).unwrap().unwrap();
    connection.grab_server().unwrap().check().unwrap();
    let release = ReleaseServer(&connection);
    // Give the producer time to issue its next GetImage. This server grab
    // prevents that other connection from receiving its reply until released.
    std::thread::sleep(Duration::from_millis(80));
    let _ = capture.next_frame(Duration::ZERO).unwrap();
    assert!(
        capture
            .next_frame(Duration::from_millis(20))
            .unwrap()
            .is_none()
    );
    let started = Instant::now();
    capture.stop().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(release);
}

#[test]
#[ignore = "briefly grabs a disposable Xvfb server"]
fn x11_probe_cancels_stalled_handshake_and_existing_connection_queries() {
    let connection = display::connect().unwrap();
    connection.grab_server().unwrap().check().unwrap();
    let release = ReleaseServer(&connection);
    let started = Instant::now();
    let error = crate::probe().unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
    assert!(started.elapsed() < crate::connection::DISCOVERY_TIMEOUT + Duration::from_secs(1));
    drop(release);
    assert!(crate::probe().unwrap().screen_capture);

    // Also exercise a server that stalls after authentication, while capability
    // replies are pending on an established connection.
    let (query_connection, deadline) = display::connect_with_deadline().unwrap();
    connection.grab_server().unwrap().check().unwrap();
    let release = ReleaseServer(&connection);
    let started = Instant::now();
    let error = deadline
        .finish(crate::probe_connection(&query_connection))
        .unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
    assert!(started.elapsed() < crate::connection::DISCOVERY_TIMEOUT + Duration::from_secs(1));
    drop(deadline);
    drop(release);
    assert!(crate::probe().unwrap().screen_capture);
}

#[test]
#[ignore = "briefly grabs a disposable Xvfb server"]
fn x11_input_and_held_state_cleanup_stop_when_server_replies_stall() {
    use x11rb::protocol::xtest::ConnectionExt as _;

    let connection = display::connect().unwrap();
    let source = display::enumerate(&connection).unwrap().remove(0);
    let mut input = InputConnection::new(source.id).unwrap();
    connection.grab_server().unwrap().check().unwrap();
    let release = ReleaseServer(&connection);
    let started = Instant::now();
    let error = input.move_pointer(0.5, 0.5).unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
    // Equivalent to native input worker teardown after an event fails: retrying
    // release and dropping the controller must not wait on another X reply.
    assert!(input.release_all().is_err());
    drop(input);
    assert!(started.elapsed() < crate::connection::DISCOVERY_TIMEOUT + Duration::from_secs(1));
    drop(release);

    // Teardown also needs a bound when no event is in flight but a key is held.
    let mut input = InputConnection::new(source.id).unwrap();
    input.key(30, true).unwrap();
    crate::input::initialize(&connection).unwrap();
    let keycode = keys::resolve(&connection, 30).unwrap();
    assert!(key_pressed(&connection, keycode));
    connection.grab_server().unwrap().check().unwrap();
    let release = ReleaseServer(&connection);
    let started = Instant::now();
    drop(input);
    assert!(started.elapsed() < crate::connection::DISCOVERY_TIMEOUT + Duration::from_secs(1));
    drop(release);
    // A stopped server cannot acknowledge release. Restore the disposable
    // server's key state using the observer after it resumes.
    connection
        .xtest_fake_input(
            x11rb::protocol::xproto::KEY_RELEASE_EVENT,
            keycode,
            0,
            0,
            0,
            0,
            0,
        )
        .unwrap()
        .check()
        .unwrap();
    assert!(!key_pressed(&connection, keycode));
}
