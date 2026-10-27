//! Local operations commands intentionally require only database access.
use deskfleet_control_store::ControlStore;
use std::io;

mod seed;

const USAGE: &str = "usage: deskfleet-server [dev-seed | site-admin list | site-admin grant <user-id> | site-admin revoke <user-id>]\n\nRun without arguments to start the HTTP server. Operations commands require DATABASE_URL. Site administrator commands require an existing user's UUID from /api/me. dev-seed creates a verified development administrator with documented credentials; it is only available in debug builds.";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Serve,
    Help,
    Seed,
    List,
    Grant(String),
    Revoke(String),
}

fn parse(args: &[String]) -> io::Result<Command> {
    let command = match args {
        [] => Command::Serve,
        [help] if matches!(help.as_str(), "--help" | "-h") => Command::Help,
        [seed] if seed == "dev-seed" => Command::Seed,
        [group, help] if group == "site-admin" && matches!(help.as_str(), "--help" | "-h") => {
            Command::Help
        }
        [group, action] if group == "site-admin" && action == "list" => Command::List,
        [group, action, id] if group == "site-admin" && action == "grant" => {
            Command::Grant(user_id(id)?)
        }
        [group, action, id] if group == "site-admin" && action == "revoke" => {
            Command::Revoke(user_id(id)?)
        }
        _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, USAGE)),
    };
    Ok(command)
}

fn user_id(value: &str) -> io::Result<String> {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "user-id must be an existing user's UUID",
            )
        })
}

/// Return true when an operations command was handled instead of starting HTTP.
pub async fn run(args: &[String]) -> io::Result<bool> {
    let command = parse(args)?;
    if command == Command::Serve {
        return Ok(false);
    }
    if command == Command::Help {
        println!("{USAGE}");
        return Ok(true);
    }
    if command == Command::Seed && !cfg!(debug_assertions) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "dev-seed is only available in debug builds",
        ));
    }
    let url = std::env::var("DATABASE_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "DATABASE_URL is required"))?;
    let store = ControlStore::connect(&url)
        .await
        .map_err(io::Error::other)?;
    match command {
        Command::Seed => seed::run(&store).await?,
        Command::List => {
            let admins = store.site_admins().await.map_err(io::Error::other)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&admins).map_err(io::Error::other)?
            );
        }
        Command::Grant(id) => {
            let changed = store
                .grant_site_admin(&id)
                .await
                .map_err(io::Error::other)?;
            println!(
                "{id}: {}",
                if changed {
                    "site administrator granted"
                } else {
                    "already a site administrator"
                }
            );
        }
        Command::Revoke(id) => {
            let changed = store
                .revoke_site_admin(&id)
                .await
                .map_err(io::Error::other)?;
            println!(
                "{id}: {}",
                if changed {
                    "site administrator revoked"
                } else {
                    "not a site administrator"
                }
            );
        }
        Command::Serve | Command::Help => unreachable!("handled before connecting"),
    }
    store.close().await.map_err(io::Error::other)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{Command, parse};

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn operations_require_explicit_actions_and_user_ids() {
        assert_eq!(parse(&[]).unwrap(), Command::Serve);
        assert_eq!(parse(&arguments(&["--help"])).unwrap(), Command::Help);
        assert_eq!(parse(&arguments(&["dev-seed"])).unwrap(), Command::Seed);
        assert_eq!(
            parse(&arguments(&["site-admin", "list"])).unwrap(),
            Command::List
        );
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            parse(&arguments(&["site-admin", "grant", &id])).unwrap(),
            Command::Grant(id.clone())
        );
        assert_eq!(
            parse(&arguments(&["site-admin", "revoke", &id])).unwrap(),
            Command::Revoke(id)
        );
        for args in [
            vec!["site-admin"],
            vec!["site-admin", "grant"],
            vec!["site-admin", "grant", "owner@example.test"],
            vec!["site-admin", "revoke", "first-user"],
            vec!["site-admin", "list", "extra"],
            vec!["--unknown"],
            vec!["dev-seed", "extra"],
        ] {
            assert!(parse(&arguments(&args)).is_err());
        }
    }
}
