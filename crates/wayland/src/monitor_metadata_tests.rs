use super::*;

fn source(
    id: u32,
    position: Option<(i32, i32)>,
    size: (u32, u32),
    mapping: Option<&str>,
) -> Source {
    Source {
        id,
        display_number: id,
        name: None,
        width: size.0,
        height: size.1,
        node_id: id + 100,
        pipewire_serial: None,
        mapping_id: mapping.map(str::to_owned),
        position,
    }
}

fn spec(connector: &str) -> MonitorSpec {
    (
        connector.into(),
        "Dell".into(),
        "U2723QE".into(),
        "serial".into(),
    )
}

fn physical(connector: &str, size: (i32, i32)) -> PhysicalMonitor {
    (
        spec(connector),
        vec![(
            "current".into(),
            size.0,
            size.1,
            60.0,
            1.0,
            vec![1.0, 2.0],
            Properties::from([("is-current".into(), OwnedVariant::from(true))]),
        )],
        Properties::from([(
            "display-name".into(),
            zbus::Variant::from("Dell U2723QE").try_to_owned().unwrap(),
        )]),
    )
}

fn logical(connector: &str, position: (i32, i32), scale: f64, transform: u32) -> LogicalMonitor {
    (
        position.0,
        position.1,
        scale,
        transform,
        false,
        vec![spec(connector)],
        Properties::new(),
    )
}

#[test]
fn kde_reauthorization_keeps_numbers_and_names_when_capture_ids_and_order_change() {
    let mut numbers = Numbers::new();
    let mut before = [
        source(1, None, (1920, 1080), Some("DP-1")),
        source(2, None, (1920, 1080), Some("HDMI-A-1")),
    ];
    let identities = identify(&Desktop::Kde, &mut before);
    assign_numbers(&mut before, &identities, &mut numbers);
    assert_eq!((before[0].display_number, before[1].display_number), (1, 2));

    let mut after = [
        source(3, None, (1920, 1080), Some("HDMI-A-1")),
        source(4, None, (1920, 1080), Some("DP-1")),
    ];
    let identities = identify(&Desktop::Kde, &mut after);
    assign_numbers(&mut after, &identities, &mut numbers);
    assert_eq!((after[0].display_number, after[1].display_number), (2, 1));
    assert_eq!(after[0].name.as_deref(), Some("HDMI-A-1"));
    assert_eq!(after[1].name.as_deref(), Some("DP-1"));
    assert_eq!((after[0].id, after[1].id), (3, 4));
}

#[test]
fn gnome_names_match_logical_geometry_with_rotation_and_scaling() {
    let monitors = gnome_monitors((
        0,
        vec![
            physical("DP-1", (3840, 2160)),
            physical("DP-2", (3840, 2160)),
        ],
        vec![
            logical("DP-1", (0, 0), 2.0, 0),
            logical("DP-2", (1920, 0), 2.0, 1),
        ],
        Properties::new(),
    ));
    let mut sources = [
        source(3, Some((1920, 0)), (1080, 1920), Some("random-uuid-2")),
        source(4, Some((0, 0)), (1920, 1080), Some("random-uuid-1")),
    ];
    let identities = identify(&Desktop::Gnome(monitors), &mut sources);
    assert_eq!(sources[0].name.as_deref(), Some("Dell U2723QE (DP-2)"));
    assert_eq!(sources[1].name.as_deref(), Some("Dell U2723QE (DP-1)"));
    assert!(identities.iter().all(Option::is_some));
    assert_ne!(identities[0], identities[1]);
}

#[test]
fn gnome_fractional_scale_rounding_preserves_names_and_numbers_after_reauthorization() {
    let monitors = gnome_monitors((
        0,
        vec![
            physical("DP-1", (2560, 1440)),
            physical("DP-2", (2560, 1440)),
        ],
        vec![
            logical("DP-1", (0, 0), 1.5, 0),
            logical("DP-2", (1707, 0), 1.5, 1),
        ],
        Properties::new(),
    ));
    assert_eq!(monitors[0].size, (1707, 960));
    assert_eq!(monitors[1].size, (960, 1707));
    let desktop = Desktop::Gnome(monitors);
    let mut numbers = Numbers::new();
    let mut before = [
        source(1, Some((0, 0)), (1707, 960), Some("old-uuid-1")),
        source(2, Some((1707, 0)), (960, 1707), Some("old-uuid-2")),
    ];
    let identities = identify(&desktop, &mut before);
    assign_numbers(&mut before, &identities, &mut numbers);
    assert_eq!((before[0].display_number, before[1].display_number), (1, 2));

    let mut after = [
        source(3, Some((1707, 0)), (960, 1707), Some("new-uuid-2")),
        source(4, Some((0, 0)), (1707, 960), Some("new-uuid-1")),
    ];
    let identities = identify(&desktop, &mut after);
    assign_numbers(&mut after, &identities, &mut numbers);
    assert_eq!(after[0].name.as_deref(), Some("Dell U2723QE (DP-2)"));
    assert_eq!(after[1].name.as_deref(), Some("Dell U2723QE (DP-1)"));
    assert_eq!((after[0].display_number, after[1].display_number), (2, 1));
    assert_eq!((after[0].id, after[1].id), (3, 4));
}

#[test]
fn gnome_physical_layout_ignores_scale_and_ambiguous_or_mirrored_outputs_have_no_name() {
    let monitors = gnome_monitors((
        0,
        vec![physical("DP-1", (3840, 2160))],
        vec![logical("DP-1", (0, 0), 2.0, 0)],
        Properties::from([("layout-mode".into(), OwnedVariant::from(2u32))]),
    ));
    assert_eq!(monitors[0].size, (3840, 2160));
    let mut mirror = logical("DP-1", (0, 0), 2.0, 0);
    mirror.5.push(spec("DP-2"));
    let monitors = gnome_monitors((
        0,
        vec![
            physical("DP-1", (3840, 2160)),
            physical("DP-2", (3840, 2160)),
        ],
        vec![
            mirror,
            logical("DP-1", (0, 0), 2.0, 0),
            logical("DP-2", (0, 0), 2.0, 0),
        ],
        Properties::from([("layout-mode".into(), OwnedVariant::from(2u32))]),
    ));
    assert!(monitors.is_empty());
    let mut sources = [source(8, Some((0, 0)), (3840, 2160), Some("uuid"))];
    assert_eq!(identify(&Desktop::Gnome(monitors), &mut sources), [None]);
    assert_eq!(sources[0].name, None);
}

#[test]
fn missing_metadata_uses_current_list_numbers_without_exposing_random_mapping_ids() {
    let mut sources = [
        source(65_537, None, (1920, 1080), Some("uuid-a")),
        source(65_539, None, (1920, 1080), Some("uuid-b")),
    ];
    let identities = identify(&Desktop::Other, &mut sources);
    let mut numbers = Numbers::from([("absent-monitor".into(), 1)]);
    assign_numbers(&mut sources, &identities, &mut numbers);
    assert_eq!(
        (sources[0].display_number, sources[1].display_number),
        (1, 2)
    );
    assert!(sources.iter().all(|source| source.name.is_none()));
    assert_eq!(numbers.len(), 1);
}

#[test]
fn duplicate_identities_do_not_share_a_number_or_collide_with_identified_sources() {
    let mut sources = [
        source(3, None, (1, 1), None),
        source(4, None, (1, 1), None),
        source(5, None, (1, 1), None),
    ];
    let identities = [
        Some("duplicate".into()),
        Some("unique".into()),
        Some("duplicate".into()),
    ];
    let mut numbers = Numbers::from([("unique".into(), 1)]);
    assign_numbers(&mut sources, &identities, &mut numbers);
    assert_eq!(
        sources
            .iter()
            .map(|source| source.display_number)
            .collect::<Vec<_>>(),
        [2, 1, 3]
    );
    assert_eq!(numbers.len(), 1);
}

#[test]
fn display_number_persistence_survives_permission_reset_without_modifying_tokens() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let directory = std::env::temp_dir().join(format!(
        "deskfleet-monitor-numbers-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let numbers = Numbers::from([("kde:DP-1".into(), 1), ("kde:DP-2".into(), 2)]);
    crate::token::write(&directory, Some("old-token")).unwrap();
    write_numbers(&directory, &numbers).unwrap();
    crate::token::prepare(&directory, crate::AuthorizationMode::Reselect).unwrap();
    assert_eq!(read_numbers(&directory).unwrap(), numbers);
    assert_eq!(crate::token::read(&directory).unwrap(), None);
    // Presentation metadata remains independent of authorization state even if
    // its file becomes unreadable as JSON.
    fs::write(directory.join(NUMBERS_FILE), "not json").unwrap();
    assert!(read_numbers(&directory).is_err());
    assert_eq!(crate::token::read(&directory).unwrap(), None);
    fs::remove_dir_all(directory).unwrap();
}
