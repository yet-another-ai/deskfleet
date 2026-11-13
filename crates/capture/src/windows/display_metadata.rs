//! User-facing monitor names are separate from capture's opaque HMONITOR IDs.

use std::collections::{BTreeSet, HashMap};

#[derive(Default)]
pub(super) struct DisplayNames {
    targets: HashMap<String, BTreeSet<String>>,
}

impl DisplayNames {
    #[cfg(windows)]
    pub(super) fn query() -> Self {
        use windows::Win32::Devices::Display::{
            DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
            DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
            DISPLAYCONFIG_TARGET_DEVICE_NAME, DisplayConfigGetDeviceInfo,
        };

        let mut names = Self::default();
        let paths = match active_paths() {
            Ok(paths) => paths,
            Err(error) => {
                // Remote/secure desktops may not expose DisplayConfig. GDI capture
                // and its device names remain usable without this extra metadata.
                tracing::debug!(%error, "Windows monitor names unavailable");
                return names;
            }
        };
        for path in paths {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                ..Default::default()
            };
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                    size: size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                },
                ..Default::default()
            };
            // SAFETY: Both headers are the first members of their live, correctly
            // sized packets; adapter and source/target IDs came from DisplayConfig.
            if unsafe { DisplayConfigGetDeviceInfo(&raw mut source.header) } == 0
                && unsafe { DisplayConfigGetDeviceInfo(&raw mut target.header) } == 0
            {
                names.add(
                    &wide_text(&source.viewGdiDeviceName),
                    &wide_text(&target.monitorFriendlyDeviceName),
                );
            }
        }
        names
    }

    fn add(&mut self, source: &str, target: &str) {
        if !source.is_empty() && !target.is_empty() {
            self.targets
                .entry(source.to_ascii_uppercase())
                .or_default()
                .insert(target.to_owned());
        }
    }

    pub(super) fn for_display(
        &self,
        device_name: &[u16],
        index: usize,
    ) -> (Option<String>, Option<u32>) {
        let source = wide_text(device_name);
        let short = source.strip_prefix(r"\\.\").unwrap_or(&source);
        let number = short
            .strip_prefix("DISPLAY")
            .and_then(|suffix| suffix.parse::<u32>().ok())
            .filter(|number| *number > 0)
            .or_else(|| u32::try_from(index).ok()?.checked_add(1));
        let name = if short.is_empty() {
            None
        } else if let Some(targets) = self.targets.get(&source.to_ascii_uppercase()) {
            // A cloned desktop source can drive several physical targets. Name
            // the group instead of selecting an arbitrary target's monitor name.
            let joined = targets
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(" / ");
            Some(format!("{joined} ({short})"))
        } else {
            Some(short.to_owned())
        };
        (name, number)
    }
}

fn wide_text(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end]).trim().to_owned()
}

#[cfg(windows)]
fn active_paths()
-> windows::core::Result<Vec<windows::Win32::Devices::Display::DISPLAYCONFIG_PATH_INFO>> {
    use windows::Win32::Devices::Display::{
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, GetDisplayConfigBufferSizes,
        QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
    };

    let mut path_count = 0;
    let mut mode_count = 0;
    // SAFETY: The count pointers refer to initialized, writable local variables.
    unsafe {
        GetDisplayConfigBufferSizes(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut path_count,
            &raw mut mode_count,
        )
        .ok()?;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    // SAFETY: Both initialized buffers have the sizes supplied in the count
    // parameters. ONLY_ACTIVE_PATHS requires a null topology pointer.
    unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &raw mut path_count,
            paths.as_mut_ptr(),
            &raw mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
        .ok()?;
    }
    paths.truncate(path_count as usize);
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain([0, 88, 89]).collect()
    }

    #[test]
    fn matches_friendly_names_to_gdi_sources_independently_of_enumeration_order() {
        let mut names = DisplayNames::default();
        names.add(r"\\.\DISPLAY1", "Dell U2723QE");
        names.add(r"\\.\DISPLAY2", "Dell U2723QE");
        assert_eq!(
            names.for_display(&wide(r"\\.\DISPLAY2"), 0),
            (Some("Dell U2723QE (DISPLAY2)".into()), Some(2))
        );
        assert_eq!(
            names.for_display(&wide(r"\\.\DISPLAY1"), 1),
            (Some("Dell U2723QE (DISPLAY1)".into()), Some(1))
        );
    }

    #[test]
    fn unavailable_metadata_keeps_gdi_names_and_ordinal_fallbacks() {
        let mut names = DisplayNames::default();
        names.add(r"\\.\DISPLAY1", "");
        assert_eq!(
            names.for_display(&wide(r"\\.\DISPLAY1"), 4),
            (Some("DISPLAY1".into()), Some(1))
        );
        assert_eq!(
            names.for_display(&wide("Remote monitor"), 1),
            (Some("Remote monitor".into()), Some(2))
        );
        assert_eq!(names.for_display(&wide(""), 0), (None, Some(1)));
    }

    #[test]
    fn cloned_outputs_have_a_deterministic_group_name() {
        let mut names = DisplayNames::default();
        names.add(r"\\.\DISPLAY1", "Projector");
        names.add(r"\\.\DISPLAY1", "Dell U2723QE");
        names.add(r"\\.\DISPLAY1", "Projector");
        assert_eq!(
            names.for_display(&wide(r"\\.\DISPLAY1"), 0),
            (Some("Dell U2723QE / Projector (DISPLAY1)".into()), Some(1))
        );
    }

    #[test]
    fn unicode_names_are_read_without_trailing_buffer_contents() {
        let mut names = DisplayNames::default();
        names.add(r"\\.\DISPLAY3", &wide_text(&wide("会议室显示器")));
        assert_eq!(
            names.for_display(&wide(r"\\.\DISPLAY3"), 0),
            (Some("会议室显示器 (DISPLAY3)".into()), Some(3))
        );
    }
}
