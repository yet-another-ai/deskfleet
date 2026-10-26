use std::{
    os::{fd::OwnedFd, unix::net::UnixStream},
    time::Duration,
};

use futures_util::StreamExt;
use reis::{
    ei,
    event::{Connection, Device, DeviceCapability, EiEvent, Region},
    tokio::EiConvertEventStream,
};

use crate::{Error, Result, Source};

pub enum Action {
    Move { x: f64, y: f64 },
    Button { code: u32, pressed: bool },
    Key { code: u32, pressed: bool },
    Wheel { dx: f64, dy: f64 },
    Release,
}

struct Held {
    device: Device,
    code: u32,
    keyboard: bool,
}

pub struct Eis {
    connection: Connection,
    pub events: EiConvertEventStream,
    devices: Vec<Device>,
    controller: Option<(u64, Source)>,
    held: Vec<Held>,
    sequence: u32,
}

impl Eis {
    pub async fn connect(fd: OwnedFd) -> Result<Self> {
        let setup = async {
            let context = ei::Context::new(UnixStream::from(fd)).map_err(input_error)?;
            let (connection, events) = context
                .handshake_tokio("deskfleet", ei::handshake::ContextType::Sender)
                .await
                .map_err(input_error)?;
            let mut input = Self {
                connection,
                events,
                devices: Vec::new(),
                controller: None,
                held: Vec::new(),
                sequence: 0,
            };
            // Device capabilities complete the connection. Monitor mapping is
            // decided later so an unmapped extra display cannot time this out.
            while !input.ready() {
                let event = input
                    .events
                    .next()
                    .await
                    .ok_or(Error::Stopped)?
                    .map_err(input_error)?;
                input.event(event)?;
            }
            Ok(input)
        };
        tokio::time::timeout(Duration::from_secs(5), setup)
            .await
            .map_err(|_| {
                Error::Input("the compositor did not provide usable input devices".into())
            })?
    }

    fn ready(&self) -> bool {
        input_devices_ready(|capability| {
            self.devices
                .iter()
                .any(|device| device.has_capability(capability))
        })
    }

    pub(crate) fn controls(&self, source: &Source) -> bool {
        self.pointer_region(source).is_ok()
    }

    pub fn event(&mut self, event: EiEvent) -> Result<()> {
        match event {
            EiEvent::SeatAdded(event) => event.seat.bind_capabilities(
                DeviceCapability::PointerAbsolute
                    | DeviceCapability::Keyboard
                    | DeviceCapability::Button
                    | DeviceCapability::Scroll,
            ),
            EiEvent::DeviceResumed(event) => {
                if !self.devices.contains(&event.device) {
                    if self.controller.is_some() {
                        self.start(&event.device);
                    }
                    self.devices.push(event.device);
                }
            }
            EiEvent::DevicePaused(event) => self.remove(&event.device),
            EiEvent::DeviceRemoved(event) => self.remove(&event.device),
            EiEvent::SeatRemoved(event) => {
                self.devices.retain(|device| device.seat() != &event.seat);
                self.held.retain(|held| held.device.seat() != &event.seat);
            }
            EiEvent::Disconnected(_) => {
                return Err(Error::Input(
                    "the compositor disconnected remote input".into(),
                ));
            }
            _ => {}
        }
        self.flush()
    }

    fn remove(&mut self, device: &Device) {
        self.devices.retain(|active| active != device);
        // Pausing/removing an EI device releases its state in the compositor;
        // sending releases to a paused or destroyed protocol object is invalid.
        self.held.retain(|held| &held.device != device);
    }

    pub fn attach(&mut self, id: u64, source: Source) -> Result<()> {
        if self.controller.is_some() {
            return Err(Error::Busy);
        }
        self.pointer_region(&source)?;
        for device in self.devices.clone() {
            self.start(&device);
        }
        self.controller = Some((id, source));
        self.flush()
    }

    fn start(&mut self, device: &Device) {
        self.sequence = self.sequence.wrapping_add(1);
        device
            .device()
            .start_emulating(self.connection.serial(), self.sequence);
    }

    pub fn detach(&mut self) -> Result<()> {
        if self.controller.take().is_none() {
            return Ok(());
        }
        self.release();
        for device in &self.devices {
            device.device().stop_emulating(self.connection.serial());
        }
        self.flush()
    }

    pub fn detach_controller(&mut self, id: u64) -> Result<()> {
        if self
            .controller
            .as_ref()
            .is_some_and(|(current, _)| *current == id)
        {
            self.detach()?;
        }
        Ok(())
    }

    pub fn action(&mut self, id: u64, action: Action) -> Result<()> {
        let Some((current, source)) = self.controller.as_ref() else {
            return if matches!(
                action,
                Action::Release
                    | Action::Button { pressed: false, .. }
                    | Action::Key { pressed: false, .. }
            ) {
                Ok(())
            } else {
                Err(Error::PermissionDenied)
            };
        };
        if *current != id {
            return Err(Error::StaleSource);
        }
        match action {
            Action::Move { x, y } => {
                let (device, region) = self.pointer_region(source)?;
                let (x, y) = coordinates(region, x, y)?;
                device
                    .interface::<ei::PointerAbsolute>()
                    .ok_or_else(missing_device)?
                    .motion_absolute(x, y);
                self.frame(device);
            }
            Action::Button { code, pressed } => {
                if !(0x110..=0x117).contains(&code) {
                    return Err(Error::InvalidInput("unsupported evdev pointer button"));
                }
                self.key_or_button(code, pressed, false)?;
            }
            Action::Key { code, pressed } => {
                if code == 0 || code > 0x2ff {
                    return Err(Error::InvalidInput("invalid evdev key code"));
                }
                self.key_or_button(code, pressed, true)?;
            }
            Action::Wheel { dx, dy } => {
                if !dx.is_finite()
                    || !dy.is_finite()
                    || dx.abs() > f32::MAX as f64
                    || dy.abs() > f32::MAX as f64
                {
                    return Err(Error::InvalidInput("scroll deltas must be finite"));
                }
                let device = self
                    .devices
                    .iter()
                    .find(|device| device.has_capability(DeviceCapability::Scroll))
                    .ok_or_else(missing_device)?;
                device
                    .interface::<ei::Scroll>()
                    .ok_or_else(missing_device)?
                    .scroll(dx as f32, dy as f32);
                self.frame(device);
            }
            Action::Release => self.release(),
        }
        self.flush()
    }

    fn key_or_button(&mut self, code: u32, pressed: bool, keyboard: bool) -> Result<()> {
        let held = self
            .held
            .iter()
            .position(|held| held.code == code && held.keyboard == keyboard);
        if pressed == held.is_some() {
            return Ok(());
        }
        let device = if let Some(index) = held {
            self.held.remove(index).device
        } else {
            let capability = if keyboard {
                DeviceCapability::Keyboard
            } else {
                DeviceCapability::Button
            };
            let device = self
                .devices
                .iter()
                .find(|device| device.has_capability(capability))
                .ok_or_else(missing_device)?
                .clone();
            self.held.push(Held {
                device: device.clone(),
                code,
                keyboard,
            });
            device
        };
        send_key_or_button(&device, code, pressed, keyboard)?;
        self.frame(&device);
        Ok(())
    }

    fn release(&mut self) {
        while let Some(held) = self.held.pop() {
            let _ = send_key_or_button(&held.device, held.code, false, held.keyboard);
            self.frame(&held.device);
        }
    }

    fn pointer_region(&self, source: &Source) -> Result<(&Device, &Region)> {
        let pairs: Vec<(&Device, &Region)> = self
            .devices
            .iter()
            .filter(|device| device.has_capability(DeviceCapability::PointerAbsolute))
            .flat_map(|device| device.regions().iter().map(move |region| (device, region)))
            .collect();
        let index = pointer_index(
            source.mapping_id.as_deref(),
            pairs.iter().map(|(_, region)| *region),
        )
        .map_err(|error| match error {
            SelectError::Missing => missing_device(),
            SelectError::Ambiguous => {
                Error::Input("the compositor provided ambiguous monitor input mappings".into())
            }
        })?;
        Ok(pairs[index])
    }

    fn frame(&self, device: &Device) {
        let now = rustix::time::clock_gettime(rustix::time::ClockId::Monotonic);
        let micros = now.tv_sec as u64 * 1_000_000 + now.tv_nsec as u64 / 1_000;
        device.device().frame(self.connection.serial(), micros);
    }

    fn flush(&self) -> Result<()> {
        self.connection.flush().map_err(input_error)
    }
}

fn send_key_or_button(device: &Device, code: u32, pressed: bool, keyboard: bool) -> Result<()> {
    if keyboard {
        device
            .interface::<ei::Keyboard>()
            .ok_or_else(missing_device)?
            .key(
                code,
                if pressed {
                    ei::keyboard::KeyState::Press
                } else {
                    ei::keyboard::KeyState::Released
                },
            );
    } else {
        device
            .interface::<ei::Button>()
            .ok_or_else(missing_device)?
            .button(
                code,
                if pressed {
                    ei::button::ButtonState::Press
                } else {
                    ei::button::ButtonState::Released
                },
            );
    }
    Ok(())
}

fn coordinates(region: &Region, x: f64, y: f64) -> Result<(f32, f32)> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err(Error::InvalidInput(
            "pointer coordinates must be normalized",
        ));
    }
    Ok((
        (region.x as f64 + x * region.width.saturating_sub(1) as f64) as f32,
        (region.y as f64 + y * region.height.saturating_sub(1) as f64) as f32,
    ))
}

fn missing_device() -> Error {
    Error::Input("the compositor has no active input device for this monitor".into())
}

fn input_devices_ready(present: impl FnMut(DeviceCapability) -> bool) -> bool {
    [
        DeviceCapability::Keyboard,
        DeviceCapability::Button,
        DeviceCapability::Scroll,
        DeviceCapability::PointerAbsolute,
    ]
    .into_iter()
    .all(present)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SelectError {
    Missing,
    Ambiguous,
}

/// `mapping_id` selects one region. With no ids, pointer input stays available
/// only for the single usable absolute region and never for an ambiguous set.
fn pointer_index<'a>(
    source_mapping: Option<&str>,
    regions: impl Iterator<Item = &'a Region>,
) -> std::result::Result<usize, SelectError> {
    let usable = regions
        .enumerate()
        .filter(|(_, region)| region.width > 0 && region.height > 0);
    match source_mapping {
        None => {
            let mut usable = usable;
            let Some((index, _)) = usable.next() else {
                return Err(SelectError::Missing);
            };
            if usable.next().is_some() {
                Err(SelectError::Ambiguous)
            } else {
                Ok(index)
            }
        }
        Some(mapping) => {
            let mut matched =
                usable.filter(|(_, region)| region.mapping_id.as_deref() == Some(mapping));
            let Some((index, _)) = matched.next() else {
                return Err(SelectError::Missing);
            };
            if matched.next().is_some() {
                Err(SelectError::Ambiguous)
            } else {
                Ok(index)
            }
        }
    }
}

fn input_error(error: impl std::fmt::Display) -> Error {
    Error::Input(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_coordinates_use_eis_region_not_video_pixel_dimensions() {
        let region = Region {
            x: 1920,
            y: 100,
            width: 1280,
            height: 720,
            scale: 2.0,
            mapping_id: Some("monitor-b".into()),
        };
        assert_eq!(coordinates(&region, 0.0, 0.0).unwrap(), (1920.0, 100.0));
        assert_eq!(coordinates(&region, 1.0, 1.0).unwrap(), (3199.0, 819.0));
        assert!(coordinates(&region, f64::NAN, 0.0).is_err());
        assert!(coordinates(&region, 1.1, 0.0).is_err());
    }

    fn region(mapping_id: Option<&str>, width: u32, height: u32) -> Region {
        Region {
            x: 0,
            y: 0,
            width,
            height,
            scale: 1.0,
            mapping_id: mapping_id.map(str::to_owned),
        }
    }

    #[test]
    fn device_readiness_does_not_wait_for_every_monitor_mapping() {
        assert!(input_devices_ready(|capability| {
            matches!(
                capability,
                DeviceCapability::Keyboard
                    | DeviceCapability::Button
                    | DeviceCapability::Scroll
                    | DeviceCapability::PointerAbsolute
            )
        }));
        let regions = [region(None, 1920, 1080), region(None, 1280, 720)];
        assert_eq!(
            pointer_index(None, regions.iter()),
            Err(SelectError::Ambiguous)
        );
    }

    #[test]
    fn multiple_monitors_without_mapping_ids_use_only_one_region() {
        let monitors = [region(None, 1920, 1080), region(None, 1280, 720)];
        assert_eq!(
            pointer_index(None, monitors.iter()),
            Err(SelectError::Ambiguous)
        );
        // Every unmapped monitor shares that one region; a zero-size region does not count.
        let sole = [region(None, 0, 0), region(None, 1920, 1080)];
        assert_eq!(pointer_index(None, sole.iter()), Ok(1));
    }

    #[test]
    fn mapping_id_limits_pointer_input_to_the_matching_monitor() {
        let regions = [
            region(Some("left"), 1920, 1080),
            region(Some("right"), 1280, 720),
        ];
        assert_eq!(pointer_index(Some("right"), regions.iter()), Ok(1));
        assert_eq!(
            pointer_index(Some("missing"), regions.iter()),
            Err(SelectError::Missing)
        );
        assert_eq!(
            pointer_index(None, regions.iter()),
            Err(SelectError::Ambiguous)
        );
        let duplicate = [region(Some("left"), 100, 100), region(Some("left"), 50, 50)];
        assert_eq!(
            pointer_index(Some("left"), duplicate.iter()),
            Err(SelectError::Ambiguous)
        );
    }
}
