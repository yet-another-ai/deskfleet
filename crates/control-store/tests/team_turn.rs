//! A Team's own TURN server: plan and site gating, administrator-only access,
//! and a write-only shared secret.
use deskfleet_control_store::{ControlStore, Error, now_ms};
use deskfleet_protocol::control::{
    TeamTurnAvailability, TeamTurnSettings, TeamTurnSettingsUpdate, TurnSettings,
};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};

struct Fixture {
    admin: DatabaseConnection,
    schema: String,
    store: ControlStore,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = Database::connect(&url).await.unwrap();
        // The site switch is a singleton, so each case owns its schema.
        let schema = format!("team_turn_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let url = format!("{url}{separator}options=-csearch_path%3D{schema}");
        let store = ControlStore::connect(&url)
            .await
            .unwrap()
            .with_hosted_mode(true);
        store.seed_turn_settings(&[]).await.unwrap();
        Self {
            admin,
            schema,
            store,
        }
    }

    async fn plan(&self, team: &str, plan: Option<&str>, enterprise: bool) {
        self.store.billing_profile(team).await.unwrap();
        self.store
            .database()
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE cp_billing_profiles SET plan=$2, paid_through=$3, enterprise=$4 WHERE team_id=$1",
                vec![
                    team.parse::<i64>().unwrap().into(),
                    plan.into(),
                    plan.map(|_| now_ms() + 86_400_000).into(),
                    enterprise.into(),
                ],
            ))
            .await
            .unwrap();
    }

    async fn close(self) {
        self.store.close().await.unwrap();
        self.admin
            .execute_unprepared(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
        self.admin.close().await.unwrap();
    }
}

fn update(urls: &[&str], secret: Option<&str>) -> TeamTurnSettingsUpdate {
    TeamTurnSettingsUpdate {
        urls: urls.iter().map(|value| (*value).into()).collect(),
        secret: secret.map(str::to_owned),
    }
}

fn configured(availability: TeamTurnAvailability, urls: &[&str]) -> TeamTurnSettings {
    TeamTurnSettings {
        availability,
        urls: urls.iter().map(|value| (*value).into()).collect(),
        secret_configured: !urls.is_empty(),
    }
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn team_servers_follow_plan_site_and_role_and_keep_secrets_private() {
    let fixture = Fixture::new().await;
    let store = &fixture.store;
    let owner = store
        .verified_user("owner@team-turn.test", "Owner")
        .await
        .unwrap();
    let admin = store
        .verified_user("admin@team-turn.test", "Admin")
        .await
        .unwrap();
    let member = store
        .verified_user("member@team-turn.test", "Member")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Relay team").await.unwrap().id;
    for (user, role) in [(&admin, "admin"), (&member, "member")] {
        let invite = store
            .invite(&owner.id, &team, user.email.as_deref().unwrap(), role)
            .await
            .unwrap();
        store
            .accept_invite(&user.id, invite["token"].as_str().unwrap())
            .await
            .unwrap();
    }
    let relay = ["turn:relay.team-turn.test:3478?transport=udp"];

    // Members cannot see or change the server; owners and administrators can.
    assert!(matches!(
        store.team_turn_settings(&member.id, &team).await,
        Err(Error::Forbidden)
    ));
    assert!(matches!(
        store
            .update_team_turn_settings(&member.id, &team, &update(&relay, Some("secret")))
            .await,
        Err(Error::Forbidden)
    ));

    // Free and Go cannot add a server; Pro and Enterprise can.
    for plan in [None, Some("go")] {
        fixture.plan(&team, plan, false).await;
        assert_eq!(
            store.team_turn_settings(&owner.id, &team).await.unwrap(),
            configured(TeamTurnAvailability::PlanRequired, &[])
        );
        assert!(matches!(
            store
                .update_team_turn_settings(&owner.id, &team, &update(&relay, Some("secret")))
                .await,
            Err(Error::Conflict(_))
        ));
    }
    fixture.plan(&team, Some("pro"), false).await;
    assert!(matches!(
        store
            .update_team_turn_settings(&admin.id, &team, &update(&relay, None))
            .await,
        Err(Error::Invalid(_))
    ));
    for invalid in [
        update(&["https://relay.team-turn.test"], Some("secret")),
        update(&relay, Some(" padded")),
        update(&[], Some("secret")),
    ] {
        assert!(matches!(
            store
                .update_team_turn_settings(&admin.id, &team, &invalid)
                .await,
            Err(Error::Invalid(_))
        ));
    }
    assert!(store.team_turn_server(&team).await.unwrap().is_none());
    assert_eq!(
        store
            .update_team_turn_settings(&admin.id, &team, &update(&relay, Some("team-secret")))
            .await
            .unwrap(),
        configured(TeamTurnAvailability::Available, &relay)
    );
    // Changing only the URLs keeps the stored secret.
    let moved = ["turns:relay.team-turn.test:5349?transport=tcp"];
    store
        .update_team_turn_settings(&owner.id, &team, &update(&moved, None))
        .await
        .unwrap();
    let server = store.team_turn_server(&team).await.unwrap().unwrap();
    assert_eq!(server.urls, moved);
    assert_eq!(server.secret, "team-secret");
    let response =
        serde_json::to_value(store.team_turn_settings(&owner.id, &team).await.unwrap()).unwrap();
    assert!(!response.to_string().contains("team-secret"));

    // A downgrade keeps the stored server but stops using it.
    fixture.plan(&team, Some("go"), false).await;
    assert!(store.team_turn_server(&team).await.unwrap().is_none());
    assert_eq!(
        store.team_turn_settings(&owner.id, &team).await.unwrap(),
        configured(TeamTurnAvailability::PlanRequired, &moved)
    );
    fixture.plan(&team, None, true).await;
    assert!(store.team_turn_server(&team).await.unwrap().is_some());

    // The site switch overrides every plan, and removal remains possible.
    store.grant_site_admin(&owner.id).await.unwrap();
    store
        .update_turn_settings(
            &owner.id,
            &TurnSettings {
                urls: vec![],
                allow_team_servers: false,
            },
        )
        .await
        .unwrap();
    assert!(store.team_turn_server(&team).await.unwrap().is_none());
    assert_eq!(
        store.team_turn_settings(&owner.id, &team).await.unwrap(),
        configured(TeamTurnAvailability::DisabledBySite, &moved)
    );
    assert!(matches!(
        store
            .update_team_turn_settings(&owner.id, &team, &update(&relay, Some("other")))
            .await,
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        store
            .update_team_turn_settings(&owner.id, &team, &update(&[], None))
            .await
            .unwrap(),
        configured(TeamTurnAvailability::DisabledBySite, &[])
    );
    store
        .update_turn_settings(&owner.id, &TurnSettings::default())
        .await
        .unwrap();
    assert!(store.team_turn_server(&team).await.unwrap().is_none());
    fixture.close().await;
}
