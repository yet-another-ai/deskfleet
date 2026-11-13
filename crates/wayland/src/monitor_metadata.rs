//! Optional desktop metadata. Capture and input never depend on these labels.
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use zbus::{Connection, OwnedVariant, Proxy};

use crate::Source;

type Properties = HashMap<String, OwnedVariant>;
type MonitorSpec = (String, String, String, String);
type MonitorMode = (String, i32, i32, f64, f64, Vec<f64>, Properties);
type PhysicalMonitor = (MonitorSpec, Vec<MonitorMode>, Properties);
type LogicalMonitor = (i32, i32, f64, u32, bool, Vec<MonitorSpec>, Properties);
type CurrentState = (u32, Vec<PhysicalMonitor>, Vec<LogicalMonitor>, Properties);
type Numbers = BTreeMap<String, u32>;

const NUMBERS_FILE: &str = "wayland-monitor-numbers.json";

#[derive(Default)]
enum Desktop {
    Gnome(Vec<Monitor>),
    Kde,
    #[default]
    Other,
}

struct Monitor {
    position: (i32, i32),
    size: (u32, u32),
    name: String,
    identity: String,
}

/// Names and numbering are best-effort metadata. In particular, a session bus
/// failure or a read-only state directory must not discard authorized streams.
pub(crate) async fn describe(connection: &Connection, directory: &Path, sources: &mut [Source]) {
    let desktop = match tokio::time::timeout(Duration::from_millis(800), desktop(connection)).await
    {
        Ok(Ok(desktop)) => desktop,
        Ok(Err(error)) => {
            tracing::debug!(%error, "Wayland monitor names are unavailable");
            Desktop::Other
        }
        Err(_) => {
            tracing::debug!("Wayland monitor name lookup timed out");
            Desktop::Other
        }
    };
    let identities = identify(&desktop, sources);
    let mut numbers = match read_numbers(directory) {
        Ok(numbers) => numbers,
        Err(error) => {
            tracing::warn!(%error, "Cannot read Wayland display numbering");
            Numbers::new()
        }
    };
    let previous = numbers.clone();
    assign_numbers(sources, &identities, &mut numbers);
    if numbers != previous
        && let Err(error) = write_numbers(directory, &numbers)
    {
        tracing::warn!(%error, "Cannot save Wayland display numbering");
    }
}

async fn desktop(connection: &Connection) -> zbus::Result<Desktop> {
    let bus = Proxy::new(
        connection,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .await?;
    // NameHasOwner avoids activating a desktop service in another environment.
    if bus
        .call::<_, _, bool>("NameHasOwner", &("org.gnome.Mutter.DisplayConfig",))
        .await?
    {
        let proxy = Proxy::new(
            connection,
            "org.gnome.Mutter.DisplayConfig",
            "/org/gnome/Mutter/DisplayConfig",
            "org.gnome.Mutter.DisplayConfig",
        )
        .await?;
        let state: CurrentState = proxy.call("GetCurrentState", &()).await?;
        return Ok(Desktop::Gnome(gnome_monitors(state)));
    }
    if bus
        .call::<_, _, bool>("NameHasOwner", &("org.kde.KWin",))
        .await?
    {
        return Ok(Desktop::Kde);
    }
    Ok(Desktop::Other)
}

fn string_property(properties: &Properties, key: &str) -> Option<String> {
    properties
        .get(key)
        .and_then(|value| <&str>::try_from(value).ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn gnome_monitors((_, physical, logical, properties): CurrentState) -> Vec<Monitor> {
    // Mutter's physical layout ignores scale; its logical layout divides the
    // rotated current mode by scale. Portal positions/sizes use that same space.
    let physical_layout = properties
        .get("layout-mode")
        .and_then(|value| u32::try_from(value).ok())
        == Some(2);
    let mut positions = HashMap::new();
    for monitor in &logical {
        *positions.entry((monitor.0, monitor.1)).or_insert(0usize) += 1;
    }
    logical
        .into_iter()
        .filter_map(|(x, y, scale, transform, _, specs, _)| {
            // Include mirror groups when checking ambiguity, even though they
            // cannot provide a single physical display name themselves.
            if positions.get(&(x, y)) != Some(&1) {
                return None;
            }
            // A mirrored logical monitor has no single physical monitor name.
            let [spec] = specs.as_slice() else {
                return None;
            };
            let (_, modes, properties) = physical
                .iter()
                .find(|(candidate, _, _)| candidate == spec)?;
            let mode = modes.iter().find(|mode| {
                mode.6
                    .get("is-current")
                    .and_then(|value| bool::try_from(value).ok())
                    == Some(true)
            })?;
            let mut size = (mode.1, mode.2);
            if transform > 7 {
                return None;
            }
            if transform % 2 == 1 {
                size = (size.1, size.0);
            }
            let scale = if physical_layout { 1.0 } else { scale };
            let width = logical_extent(size.0, scale)?;
            let height = logical_extent(size.1, scale)?;
            let title = string_property(properties, "display-name").unwrap_or_else(|| {
                format!("{} {}", spec.1.trim(), spec.2.trim())
                    .trim()
                    .to_owned()
            });
            let connector = spec.0.trim();
            if connector.is_empty() {
                return None;
            }
            let name = if title.is_empty() || title == connector {
                connector.to_owned()
            } else {
                format!("{title} ({connector})")
            };
            // Include the connector so identical/missing hardware serials cannot
            // merge two displays. This is stable for the same connected output,
            // not a promise that moving a monitor to another port keeps its number.
            let identity = serde_json::to_string(&("gnome", spec)).ok()?;
            Some(Monitor {
                position: (x, y),
                size: (width, height),
                name,
                identity,
            })
        })
        .collect()
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn logical_extent(pixels: i32, scale: f64) -> Option<u32> {
    if pixels <= 0 || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    // Match Mutter's scale_logical_monitor_width: its scale is a float exposed
    // as a D-Bus double, and it rounds mode dimensions with roundf(pixels / scale).
    let rounded = (pixels as f32 / scale as f32).round();
    (rounded >= 1.0 && f64::from(rounded) <= f64::from(i32::MAX)).then_some(rounded as u32)
}

fn identify(desktop: &Desktop, sources: &mut [Source]) -> Vec<Option<String>> {
    sources
        .iter_mut()
        .map(|source| match desktop {
            Desktop::Gnome(monitors) => {
                let position = source.position?;
                let mut matching = monitors.iter().filter(|monitor| {
                    monitor.position == position && monitor.size == (source.width, source.height)
                });
                let monitor = matching.next()?;
                if matching.next().is_some() {
                    return None;
                }
                source.name = Some(monitor.name.clone());
                Some(monitor.identity.clone())
            }
            Desktop::Kde => {
                // xdg-desktop-portal-kde provides QScreen::name() for a monitor's
                // mapping_id. Other portals (notably GNOME) use random mapping IDs.
                let output = source.mapping_id.as_deref()?.trim();
                if output.is_empty() {
                    return None;
                }
                source.name = Some(output.to_owned());
                serde_json::to_string(&("kde", output)).ok()
            }
            Desktop::Other => None,
        })
        .collect()
}

fn assign_numbers(sources: &mut [Source], identities: &[Option<String>], numbers: &mut Numbers) {
    let mut counts = HashMap::new();
    for identity in identities.iter().flatten() {
        *counts.entry(identity).or_insert(0usize) += 1;
    }
    let identities: Vec<_> = identities
        .iter()
        .map(|identity| {
            identity
                .as_ref()
                .filter(|identity| counts.get(identity) == Some(&1))
        })
        .collect();
    let mut reserved: HashSet<u32> = numbers.values().copied().collect();
    let mut used = HashSet::new();
    for (source, identity) in sources.iter_mut().zip(&identities) {
        let Some(identity) = identity else { continue };
        let next = smallest_unused(&reserved);
        let number = *numbers.entry((*identity).clone()).or_insert(next);
        source.display_number = number;
        reserved.insert(number);
        used.insert(number);
    }
    for (source, identity) in sources.iter_mut().zip(&identities) {
        if identity.is_none() {
            let number = smallest_unused(&used);
            source.display_number = number;
            used.insert(number);
        }
    }
}

fn smallest_unused(used: &HashSet<u32>) -> u32 {
    (1..=u32::MAX)
        .find(|number| !used.contains(number))
        .unwrap_or(u32::MAX)
}

fn read_numbers(directory: &Path) -> std::io::Result<Numbers> {
    let data = match fs::read(directory.join(NUMBERS_FILE)) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Numbers::new()),
        Err(error) => return Err(error),
    };
    let numbers: Numbers = serde_json::from_slice(&data)?;
    let unique: HashSet<_> = numbers.values().collect();
    if numbers.values().any(|number| *number == 0) || unique.len() != numbers.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid display numbers",
        ));
    }
    Ok(numbers)
}

fn write_numbers(directory: &Path, numbers: &Numbers) -> std::io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(
        ".{NUMBERS_FILE}.{}.{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(numbers)?)?;
        file.sync_all()?;
        fs::rename(&temporary, directory.join(NUMBERS_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
#[path = "monitor_metadata_tests.rs"]
mod tests;
