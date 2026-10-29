use x11rb::connection::Connection;
use x11rb::protocol::randr::{self, ConnectionExt as _, NotifyMask};
use x11rb::protocol::xproto::{ChangeWindowAttributesAux, ConnectionExt as _, EventMask};
use x11rb::rust_connection::RustConnection;

use crate::{Error, Result, connection, platform};

/// An active X11 monitor. IDs identify RandR CRTCs, or a root on servers without
/// active RandR outputs. Capture and input retain the same root-relative bounds.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_rate_hz: f64,
    pub(crate) root: u32,
    pub(crate) x: i16,
    pub(crate) y: i16,
    pub(crate) root_width: u16,
    pub(crate) root_height: u16,
}

#[cfg(test)]
pub(crate) fn connect() -> Result<RustConnection> {
    let (connection, _deadline) = connect_with_deadline()?;
    Ok(connection)
}

pub(crate) fn connect_with_deadline() -> Result<(RustConnection, connection::Deadline)> {
    let (connection, deadline) = connection::connect()?;
    let xwayland = deadline.finish(
        connection
            .query_extension(b"XWAYLAND")
            .map_err(platform)?
            .reply()
            .map_err(platform),
    )?;
    if xwayland.present {
        return Err(Error::Unavailable(
            "Xwayland is not a complete X11 desktop".into(),
        ));
    }
    Ok((connection, deadline))
}

pub fn sources() -> Result<Vec<Source>> {
    let (connection, deadline) = connect_with_deadline()?;
    deadline.finish(enumerate(&connection))
}

pub(crate) fn enumerate(connection: &RustConnection) -> Result<Vec<Source>> {
    let randr = connection
        .query_extension(b"RANDR")
        .map_err(platform)?
        .reply()
        .map_err(platform)?
        .present;
    let modern_randr = if randr {
        let version = connection
            .randr_query_version(1, 3)
            .map_err(platform)?
            .reply()
            .map_err(platform)?;
        (version.major_version, version.minor_version) >= (1, 3)
    } else {
        false
    };
    let mut sources = Vec::new();
    for (index, screen) in connection.setup().roots.iter().enumerate() {
        let geometry = connection
            .get_geometry(screen.root)
            .map_err(platform)?
            .reply()
            .map_err(platform)?;
        let fallback = Source {
            id: screen.root,
            name: format!("X11 screen {}", index + 1),
            width: u32::from(geometry.width),
            height: u32::from(geometry.height),
            refresh_rate_hz: 0.0,
            root: screen.root,
            x: 0,
            y: 0,
            root_width: geometry.width,
            root_height: geometry.height,
        };
        let before = sources.len();
        if modern_randr {
            let resources = connection
                .randr_get_screen_resources_current(screen.root)
                .map_err(platform)?
                .reply()
                .map_err(platform)?;
            for crtc in resources.crtcs {
                let info = connection
                    .randr_get_crtc_info(crtc, resources.config_timestamp)
                    .map_err(platform)?
                    .reply()
                    .map_err(platform)?;
                if info.mode == 0 || info.width == 0 || info.height == 0 || info.outputs.is_empty()
                {
                    continue;
                }
                let output = connection
                    .randr_get_output_info(info.outputs[0], resources.config_timestamp)
                    .map_err(platform)?
                    .reply()
                    .map_err(platform)?;
                let refresh_rate_hz = resources
                    .modes
                    .iter()
                    .find(|mode| mode.id == info.mode)
                    .map_or(0.0, refresh_rate);
                sources.push(Source {
                    id: crtc,
                    name: String::from_utf8_lossy(&output.name).into_owned(),
                    width: u32::from(info.width),
                    height: u32::from(info.height),
                    refresh_rate_hz,
                    x: info.x,
                    y: info.y,
                    ..fallback.clone()
                });
            }
        }
        if sources.len() == before && fallback.width > 0 && fallback.height > 0 {
            sources.push(fallback);
        }
    }
    Ok(sources)
}

fn refresh_rate(mode: &randr::ModeInfo) -> f64 {
    let total = u32::from(mode.htotal) * u32::from(mode.vtotal);
    if total == 0 {
        return 0.0;
    }
    let mut rate = f64::from(mode.dot_clock) / f64::from(total);
    if mode.mode_flags.contains(randr::ModeFlag::INTERLACE) {
        rate *= 2.0;
    }
    if mode.mode_flags.contains(randr::ModeFlag::DOUBLE_SCAN) {
        rate /= 2.0;
    }
    rate
}

pub(crate) fn select(connection: &RustConnection, source_id: u32) -> Result<Source> {
    let source = enumerate(connection)?
        .into_iter()
        .find(|source| source.id == source_id)
        .ok_or(Error::StaleSource)?;
    connection
        .change_window_attributes(
            source.root,
            &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY),
        )
        .map_err(platform)?
        .check()
        .map_err(platform)?;
    if connection
        .query_extension(b"RANDR")
        .map_err(platform)?
        .reply()
        .map_err(platform)?
        .present
    {
        connection
            .randr_select_input(
                source.root,
                NotifyMask::SCREEN_CHANGE | NotifyMask::CRTC_CHANGE | NotifyMask::OUTPUT_CHANGE,
            )
            .map_err(platform)?
            .check()
            .map_err(platform)?;
    }
    // Subscribe before checking again so a configuration change cannot fall
    // between the snapshot and event selection unnoticed.
    validate(connection, &source)?;
    Ok(source)
}

fn validate(connection: &RustConnection, source: &Source) -> Result<()> {
    if enumerate(connection)?
        .iter()
        .any(|current| current == source)
    {
        Ok(())
    } else {
        Err(Error::StaleSource)
    }
}

pub(crate) fn check_changes(connection: &RustConnection, source: &Source) -> Result<()> {
    let mut changed = false;
    while let Some(event) = connection.poll_for_event().map_err(platform)? {
        if matches!(
            event,
            x11rb::protocol::Event::ConfigureNotify(_)
                | x11rb::protocol::Event::RandrScreenChangeNotify(_)
                | x11rb::protocol::Event::RandrNotify(_)
        ) {
            changed = true;
        }
    }
    if changed {
        validate(connection, source)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_rate_handles_interlaced_and_double_scan_modes() {
        let mut mode = randr::ModeInfo {
            dot_clock: 148_500_000,
            htotal: 2200,
            vtotal: 1125,
            ..Default::default()
        };
        assert_eq!(refresh_rate(&mode), 60.0);
        mode.mode_flags = randr::ModeFlag::INTERLACE;
        assert_eq!(refresh_rate(&mode), 120.0);
        mode.mode_flags = randr::ModeFlag::DOUBLE_SCAN;
        assert_eq!(refresh_rate(&mode), 30.0);
        mode.htotal = 0;
        assert_eq!(refresh_rate(&mode), 0.0);
    }
}
