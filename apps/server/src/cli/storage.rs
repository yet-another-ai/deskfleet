//! Explicit, resumable history maintenance; preview never runs migrations.
use chrono::DateTime;
use deskfleet_control_store::{
    ControlStore, LegacyHistoryCounts, LegacyHistoryCursor, PurgedHistoryCounts,
};
use serde_json::{Value, json};
use std::io;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Vacuum {
    Standard,
    Full,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Options {
    pub apply: bool,
    pub deleted_before: Option<i64>,
    pub batch_size: u32,
    pub vacuum: Option<Vacuum>,
}

pub(super) fn parse(args: &[String]) -> io::Result<Options> {
    let invalid = |message| io::Error::new(io::ErrorKind::InvalidInput, message);
    let mut apply = false;
    let mut deleted_before = None;
    let mut batch_size = None;
    let mut vacuum = None;
    let mut args = args.iter();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--apply" if !apply => apply = true,
            "--deleted-before" if deleted_before.is_none() => {
                let value = args
                    .next()
                    .ok_or_else(|| invalid("--deleted-before requires an RFC3339 timestamp"))?;
                deleted_before = Some(
                    DateTime::parse_from_rfc3339(value)
                        .map_err(|_| invalid("--deleted-before requires an RFC3339 timestamp"))?
                        .timestamp_millis(),
                );
            }
            "--batch-size" if batch_size.is_none() => {
                let value = args
                    .next()
                    .and_then(|value| value.parse::<u32>().ok())
                    .filter(|value| (1..=1000).contains(value))
                    .ok_or_else(|| invalid("--batch-size must be an integer from 1 to 1000"))?;
                batch_size = Some(value);
            }
            "--vacuum" if vacuum.is_none() => {
                vacuum = Some(match args.next().map(String::as_str) {
                    Some("standard") => Vacuum::Standard,
                    Some("full") => Vacuum::Full,
                    _ => return Err(invalid("--vacuum must be standard or full")),
                });
            }
            _ => return Err(invalid("unknown or duplicate storage cleanup option")),
        }
    }
    if vacuum.is_some() && !apply {
        return Err(invalid("--vacuum requires --apply"));
    }
    Ok(Options {
        apply,
        deleted_before,
        batch_size: batch_size.unwrap_or(100),
        vacuum,
    })
}

async fn inventory(store: &ControlStore, options: Options) -> io::Result<Value> {
    let legacy = store
        .legacy_history_counts()
        .await
        .map_err(io::Error::other)?;
    let deleted = match options.deleted_before {
        Some(before) => Some(
            store
                .deleted_history_counts(before)
                .await
                .map_err(io::Error::other)?,
        ),
        None => None,
    };
    let bytes = store.storage_size_bytes().await.map_err(io::Error::other)?;
    Ok(json!({
        "databaseAllocatedBytes": bytes,
        "legacyHistory": legacy,
        "deletedHistory": deleted,
    }))
}

fn purge_has_changes(counts: &PurgedHistoryCounts) -> bool {
    counts.sessions != 0
        || counts.events != 0
        || counts.commands != 0
        || counts.search_documents != 0
        || counts.search_entries != 0
        || counts.search_progress != 0
}

pub(super) async fn run(store: &ControlStore, options: Options) -> io::Result<()> {
    let before = inventory(store, options).await?;
    let mut applied = None;
    let mut after = None;
    if options.apply {
        let mut legacy = LegacyHistoryCounts::default();
        let mut cursor = LegacyHistoryCursor::default();
        loop {
            let batch = store
                .compact_legacy_history_batch(options.batch_size, &mut cursor)
                .await
                .map_err(io::Error::other)?;
            if batch.events == 0 && batch.commands == 0 {
                break;
            }
            legacy.events += batch.events;
            legacy.commands += batch.commands;
            eprintln!(
                "Compacted legacy history: {} event rows, {} command rows.",
                legacy.events, legacy.commands
            );
        }
        let mut deleted = PurgedHistoryCounts::default();
        if let Some(before) = options.deleted_before {
            loop {
                let batch = store
                    .purge_deleted_history_batch(before, options.batch_size)
                    .await
                    .map_err(io::Error::other)?;
                if !purge_has_changes(&batch) {
                    break;
                }
                deleted.sessions += batch.sessions;
                deleted.events += batch.events;
                deleted.commands += batch.commands;
                deleted.search_documents += batch.search_documents;
                deleted.search_entries += batch.search_entries;
                deleted.search_progress += batch.search_progress;
                eprintln!(
                    "Purged deleted history: {} Sessions, {} event rows, {} command rows.",
                    deleted.sessions, deleted.events, deleted.commands
                );
            }
        }
        if let Some(vacuum) = options.vacuum {
            eprintln!(
                "Running {} on history tables.",
                if vacuum == Vacuum::Full {
                    "VACUUM FULL"
                } else {
                    "VACUUM"
                }
            );
            store
                .vacuum_history(vacuum == Vacuum::Full)
                .await
                .map_err(io::Error::other)?;
        }
        applied = Some(json!({ "legacyHistory": legacy, "deletedHistory": deleted }));
        after = Some(inventory(store, options).await?);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "mode": if options.apply { "apply" } else { "preview" },
            "deletedBeforeUnixMs": options.deleted_before,
            "batchSize": options.batch_size,
            "databaseSizeNote": "Allocated database bytes include free space and indexes; they are not an estimate of removable content.",
            "before": before,
            "applied": applied,
            "after": after,
        }))
        .map_err(io::Error::other)?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Options, Vacuum, parse, purge_has_changes};
    use deskfleet_control_store::PurgedHistoryCounts;

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn purge_continues_when_a_batch_only_removes_part_of_a_session() {
        assert!(!purge_has_changes(&PurgedHistoryCounts::default()));
        for batch in [
            PurgedHistoryCounts {
                events: 100,
                ..Default::default()
            },
            PurgedHistoryCounts {
                commands: 100,
                ..Default::default()
            },
            PurgedHistoryCounts {
                search_documents: 100,
                ..Default::default()
            },
        ] {
            assert!(purge_has_changes(&batch));
        }
    }

    #[test]
    fn cleanup_defaults_to_preview_without_purge_or_vacuum() {
        assert_eq!(
            parse(&[]).unwrap(),
            Options {
                apply: false,
                deleted_before: None,
                batch_size: 100,
                vacuum: None,
            }
        );
        let preview = parse(&arguments(&[
            "--deleted-before",
            "2026-11-01T08:00:00+08:00",
        ]))
        .unwrap();
        assert!(!preview.apply);
        assert_eq!(preview.deleted_before, Some(1_793_491_200_000));
    }

    #[test]
    fn apply_accepts_explicit_cutoff_batch_boundaries_and_vacuum() {
        for (value, expected) in [("standard", Vacuum::Standard), ("full", Vacuum::Full)] {
            for size in ["1", "1000"] {
                let options = parse(&arguments(&[
                    "--vacuum",
                    value,
                    "--batch-size",
                    size,
                    "--deleted-before",
                    "2026-11-01T00:00:00Z",
                    "--apply",
                ]))
                .unwrap();
                assert!(options.apply);
                assert_eq!(options.vacuum, Some(expected));
                assert_eq!(options.batch_size.to_string(), size);
                assert_eq!(options.deleted_before, Some(1_793_491_200_000));
            }
        }
    }

    #[test]
    fn cleanup_rejects_ambiguous_or_destructive_options_without_apply() {
        for args in [
            vec!["--vacuum", "standard"],
            vec!["--vacuum", "full"],
            vec!["--apply", "--vacuum", "quick"],
            vec!["--apply", "--vacuum"],
            vec!["--apply", "--apply"],
            vec!["--deleted-before"],
            vec!["--deleted-before", "2026-11-01"],
            vec!["--deleted-before", "2026-11-01T00:00:00"],
            vec!["--deleted-before", "2026-13-01T00:00:00Z"],
            vec![
                "--deleted-before",
                "2026-11-01T00:00:00Z",
                "--deleted-before",
                "2026-11-02T00:00:00Z",
            ],
            vec!["--batch-size"],
            vec!["--batch-size", "0"],
            vec!["--batch-size", "1001"],
            vec!["--batch-size", "-1"],
            vec!["--batch-size", "1.5"],
            vec!["--batch-size", "10", "--batch-size", "20"],
            vec!["--apply", "--vacuum", "full", "--vacuum", "full"],
            vec!["--unknown"],
            vec!["--apply", "extra"],
        ] {
            assert!(parse(&arguments(&args)).is_err(), "accepted {args:?}");
        }
    }
}
