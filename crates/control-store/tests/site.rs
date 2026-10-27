//! Site settings need an isolated schema because their state is installation-wide.
use deskfleet_control_store::{ControlStore, Error};
use deskfleet_protocol::control::SiteSettings;
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement, TransactionTrait};
use serde_json::{Value, json};
use std::time::Duration;

async fn wait_for_lock(store: &ControlStore, application: &str, query: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting = store.database().query_one_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query=$2 AND wait_event_type='Lock'",
                vec![application.into(), query.into()],
            )).await.unwrap().is_some();
            if waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("operation reached its expected database lock");
}

async fn audit(store: &ControlStore) -> Vec<Value> {
    store
        .database()
        .query_all_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT to_jsonb(a) AS record FROM cp_site_audit a ORDER BY id",
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|row| row.try_get("", "record").unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn site_grants_settings_revocation_and_audit_are_transactional() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let database = Database::connect(&url).await.unwrap();
    let schema = format!("site_test_{}", uuid::Uuid::new_v4().simple());
    database
        .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let scoped_url =
        format!("{url}{separator}options=-csearch_path%3D{schema}&application_name={schema}");
    let store = ControlStore::connect(&scoped_url).await.unwrap();
    let admin = store
        .oidc_user("https://site.test", "operator", "Operator", None, false)
        .await
        .unwrap();
    let member = store
        .oidc_user("https://site.test", "member", "Member", None, false)
        .await
        .unwrap();
    let defaults = SiteSettings {
        site_name: "deskfleet".into(),
        announcement: String::new(),
        allow_team_creation: true,
    };
    assert_eq!(store.site_settings().await.unwrap(), defaults);
    assert!(!store.is_site_admin(&admin.id).await.unwrap());
    assert!(store.site_admins().await.unwrap().is_empty());
    assert!(matches!(
        store.read_site_settings(&admin.id).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store.update_site_settings(&member.id, &defaults).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .grant_site_admin(&uuid::Uuid::new_v4().to_string())
            .await,
        Err(Error::NotFound)
    ));
    assert!(audit(&store).await.is_empty());

    // Site grants do not create memberships or grant access to existing machines.
    let team = store
        .create_team(&member.id, "Member's team")
        .await
        .unwrap();
    let (machine, _) = store
        .enroll(
            &member.id,
            &team.id,
            "Worker",
            &uuid::Uuid::new_v4().to_string(),
            "1",
            json!({}),
        )
        .await
        .unwrap();
    assert!(store.grant_site_admin(&admin.id).await.unwrap());
    assert!(!store.grant_site_admin(&admin.id).await.unwrap());
    assert_eq!(store.site_admins().await.unwrap()[0]["userId"], admin.id);
    assert!(store.teams(&admin.id).await.unwrap().is_empty());
    assert!(matches!(
        store.authorized_machine(&admin.id, &machine.id).await,
        Err(Error::Forbidden)
    ));
    assert_eq!(store.read_site_settings(&admin.id).await.unwrap(), defaults);

    let mut changed = SiteSettings {
        site_name: "  Research fleet  ".into(),
        announcement: "Maintenance at 19:00".into(),
        allow_team_creation: false,
    };
    let saved = store
        .update_site_settings(&admin.id, &changed)
        .await
        .unwrap();
    changed.site_name = "Research fleet".into();
    assert_eq!(saved, changed);
    // Read from a new connection, so persistence and per-request grants are tested.
    let second = ControlStore::connect(&scoped_url).await.unwrap();
    assert_eq!(second.site_settings().await.unwrap(), changed);
    assert!(matches!(
        store.create_team(&member.id, "Disabled").await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .create_team(&admin.id, "Also disabled for site admins")
            .await,
        Err(Error::Forbidden)
    ));
    for invalid in [
        SiteSettings {
            site_name: " ".into(),
            ..changed.clone()
        },
        SiteSettings {
            site_name: "x".repeat(201),
            ..changed.clone()
        },
        SiteSettings {
            announcement: "x".repeat(10_001),
            ..changed.clone()
        },
    ] {
        assert!(matches!(
            store.update_site_settings(&admin.id, &invalid).await,
            Err(Error::Invalid(_))
        ));
    }
    let entries = audit(&store).await;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["source"], "cli");
    assert_eq!(entries[0]["action"], "admin.grant");
    assert_eq!(entries[0]["actor_user_id"], Value::Null);
    assert_eq!(entries[0]["target_user_id"], admin.id);
    assert_eq!(entries[0]["before_value"], json!({"siteAdmin": false}));
    assert_eq!(entries[0]["after_value"], json!({"siteAdmin": true}));
    assert_eq!(entries[1]["source"], "user");
    assert_eq!(entries[1]["actor_user_id"], admin.id);
    assert_eq!(entries[1]["before_value"], json!(defaults));
    assert_eq!(entries[1]["after_value"], json!(changed));

    // An audit write failure must roll back both kinds of administrative changes.
    store.database().execute_unprepared(
        "CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
         CREATE TRIGGER reject_audit BEFORE INSERT ON cp_site_audit FOR EACH ROW EXECUTE FUNCTION reject_audit()",
    ).await.unwrap();
    assert!(
        store
            .update_site_settings(&admin.id, &defaults)
            .await
            .is_err()
    );
    assert_eq!(second.site_settings().await.unwrap(), changed);
    assert!(store.grant_site_admin(&member.id).await.is_err());
    assert!(!second.is_site_admin(&member.id).await.unwrap());
    assert!(store.revoke_site_admin(&admin.id).await.is_err());
    assert!(second.is_site_admin(&admin.id).await.unwrap());
    store
        .database()
        .execute_unprepared(
            "DROP TRIGGER reject_audit ON cp_site_audit; DROP FUNCTION reject_audit()",
        )
        .await
        .unwrap();

    // Hold the settings row until the write owns its grant SHARE lock and
    // revocation waits on that grant. The write's audit FK must be able to take
    // user KEY SHARE despite the operator's serialization lock on the user.
    let blocker = store.database().begin().await.unwrap();
    blocker
        .execute_unprepared("SELECT singleton FROM cp_site_settings WHERE singleton FOR UPDATE")
        .await
        .unwrap();
    let update = {
        let store = store.clone();
        let user = admin.id.clone();
        let defaults = defaults.clone();
        tokio::spawn(async move { store.update_site_settings(&user, &defaults).await })
    };
    wait_for_lock(
        &store,
        &schema,
        "SELECT * FROM cp_site_settings WHERE singleton FOR UPDATE",
    )
    .await;
    let revoke = {
        let store = store.clone();
        let user = admin.id.clone();
        tokio::spawn(async move { store.revoke_site_admin(&user).await })
    };
    wait_for_lock(
        &store,
        &schema,
        "DELETE FROM cp_site_admins WHERE user_id=$1",
    )
    .await;
    blocker.commit().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        assert_eq!(update.await.unwrap().unwrap(), defaults);
        assert!(revoke.await.unwrap().unwrap());
    })
    .await
    .expect("concurrent settings update and revocation complete without deadlock");
    assert!(!store.revoke_site_admin(&admin.id).await.unwrap());
    assert!(!second.is_site_admin(&admin.id).await.unwrap());
    assert!(matches!(
        second.read_site_settings(&admin.id).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        second.update_site_settings(&admin.id, &defaults).await,
        Err(Error::Forbidden)
    ));
    let entries = audit(&store).await;
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[2]["action"], "settings.update");
    assert_eq!(entries[2]["before_value"], json!(changed));
    assert_eq!(entries[2]["after_value"], json!(defaults));
    assert_eq!(entries[3]["action"], "admin.revoke");
    assert_eq!(entries[3]["before_value"], json!({"siteAdmin": true}));
    assert_eq!(entries[3]["after_value"], json!({"siteAdmin": false}));
    // Explicit CLI recovery still works after revoking the last administrator.
    assert!(second.grant_site_admin(&member.id).await.unwrap());
    second
        .update_site_settings(&member.id, &defaults)
        .await
        .unwrap();
    assert!(
        second
            .create_team(&admin.id, "Creation reopened")
            .await
            .is_ok()
    );
    second.close().await.unwrap();
    store.close().await.unwrap();
    database
        .execute_unprepared(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    database.close().await.unwrap();
}
