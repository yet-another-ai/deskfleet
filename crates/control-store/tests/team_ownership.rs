//! Team ownership migration, authorization, and transaction invariants.
use deskfleet_control_store::{ControlStore, Error, policies::TeamAction, schema};
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use serde_json::{Value, json};

fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

async fn fixture() -> (ControlStore, DatabaseConnection, String) {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
    let db = Database::connect(&url).await.unwrap();
    let name = format!("team_owner_{}", uuid::Uuid::new_v4().simple());
    db.execute_unprepared(&format!("CREATE SCHEMA {name}"))
        .await
        .unwrap();
    let separator = if url.contains('?') { '&' } else { '?' };
    let store = ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{name}"))
        .await
        .unwrap();
    (store, db, name)
}

async fn cleanup(store: ControlStore, db: DatabaseConnection, name: String) {
    store.close().await.unwrap();
    db.execute_unprepared(&format!("DROP SCHEMA {name} CASCADE"))
        .await
        .unwrap();
    db.close().await.unwrap();
}

async fn join(store: &ControlStore, owner: &str, team: &str, user: &str, email: &str, role: &str) {
    let invite = store.invite(owner, team, email, role).await.unwrap();
    store
        .accept_invite(user, invite["token"].as_str().unwrap())
        .await
        .unwrap();
}

async fn billing_record(store: &ControlStore, team: &str) -> Value {
    store
        .database()
        .query_one_raw(sql(
            "SELECT to_jsonb(b) AS record FROM cp_billing_profiles b WHERE team_id=$1",
            vec![team.parse::<i64>().unwrap().into()],
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get("", "record")
        .unwrap()
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn owner_controls_billing_and_transfer_without_changing_team_billing() {
    let (store, db, name) = fixture().await;
    let owner = store
        .verified_user("owner@ownership.test", "Owner")
        .await
        .unwrap();
    let admin = store
        .verified_user("admin@ownership.test", "Admin")
        .await
        .unwrap();
    let member = store
        .verified_user("member@ownership.test", "Member")
        .await
        .unwrap();
    let outsider = store
        .verified_user("outsider@ownership.test", "Outsider")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Owned team").await.unwrap();
    assert_eq!(team.role, "owner");
    assert_eq!(
        store
            .rename_team(&owner.id, &team.id, "Renamed")
            .await
            .unwrap()
            .role,
        "owner"
    );
    join(
        &store,
        &owner.id,
        &team.id,
        &admin.id,
        "admin@ownership.test",
        "admin",
    )
    .await;
    join(
        &store,
        &owner.id,
        &team.id,
        &member.id,
        "member@ownership.test",
        "member",
    )
    .await;
    store.require_admin(&owner.id, &team.id).await.unwrap();
    store.require_admin(&admin.id, &team.id).await.unwrap();
    store
        .authorize_team(&owner.id, &team.id, TeamAction::ManageBilling)
        .await
        .unwrap();
    for user in [&admin.id, &member.id, &outsider.id] {
        for action in [
            TeamAction::ManageBilling,
            TeamAction::Delete,
            TeamAction::TransferOwnership,
        ] {
            assert!(matches!(
                store.authorize_team(user, &team.id, action).await,
                Err(Error::Forbidden)
            ));
        }
        assert!(matches!(
            store
                .transfer_team_ownership(user, &team.id, &member.id)
                .await,
            Err(Error::Forbidden)
        ));
    }
    for actor in [&owner.id, &admin.id] {
        for role in [None, Some("admin"), Some("member")] {
            assert!(matches!(
                store.change_member(actor, &team.id, &owner.id, role).await,
                Err(Error::Conflict(_))
            ));
        }
    }
    assert!(matches!(
        store
            .change_member(&owner.id, &team.id, &member.id, Some("owner"))
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .invite(&owner.id, &team.id, "outside@ownership.test", "owner")
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .transfer_team_ownership(&owner.id, &team.id, &owner.id)
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store
            .transfer_team_ownership(&owner.id, &team.id, &outsider.id)
            .await,
        Err(Error::Invalid(_))
    ));
    for condition in ["disabled=TRUE", "disabled=FALSE,email_verified=FALSE"] {
        store
            .database()
            .execute_raw(sql(
                &format!("UPDATE cp_users SET {condition} WHERE id=$1"),
                vec![member.id.clone().into()],
            ))
            .await
            .unwrap();
        assert!(matches!(
            store
                .transfer_team_ownership(&owner.id, &team.id, &member.id)
                .await,
            Err(Error::Invalid(_))
        ));
        assert_eq!(store.team_role(&owner.id, &team.id).await.unwrap(), "owner");
    }
    store
        .database()
        .execute_raw(sql(
            "UPDATE cp_users SET email_verified=TRUE WHERE id=$1",
            vec![member.id.clone().into()],
        ))
        .await
        .unwrap();
    store.database().execute_raw(sql("UPDATE cp_billing_profiles SET customer_id='cus_existing',subscription_id='sub_existing' WHERE team_id=$1", vec![team.id.parse::<i64>().unwrap().into()])).await.unwrap();
    let before = billing_record(&store, &team.id).await;
    store
        .transfer_team_ownership(&owner.id, &team.id, &member.id)
        .await
        .unwrap();
    assert_eq!(store.team_role(&owner.id, &team.id).await.unwrap(), "admin");
    assert_eq!(store.team_role(&admin.id, &team.id).await.unwrap(), "admin");
    assert_eq!(
        store.team_role(&member.id, &team.id).await.unwrap(),
        "owner"
    );
    assert_eq!(billing_record(&store, &team.id).await, before);
    assert!(matches!(
        store
            .authorize_team(&owner.id, &team.id, TeamAction::ManageBilling)
            .await,
        Err(Error::Forbidden)
    ));
    store
        .authorize_team(&member.id, &team.id, TeamAction::ManageBilling)
        .await
        .unwrap();
    assert_eq!(
        store
            .members(&member.id, &team.id)
            .await
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "owner")
            .count(),
        1
    );
    assert!(
        store
            .database()
            .execute_raw(sql(
                "UPDATE cp_members SET role='owner' WHERE team_id=$1 AND user_id=$2",
                vec![team.id.parse::<i64>().unwrap().into(), admin.id.into()]
            ))
            .await
            .is_err()
    );
    cleanup(store, db, name).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn concurrent_transfers_have_one_winner_and_recheck_the_current_owner() {
    let (store, db, name) = fixture().await;
    let owner = store
        .verified_user("owner@ownership.test", "Owner")
        .await
        .unwrap();
    let first = store
        .verified_user("first@ownership.test", "First")
        .await
        .unwrap();
    let second = store
        .verified_user("second@ownership.test", "Second")
        .await
        .unwrap();
    let team = store.create_team(&owner.id, "Owned team").await.unwrap();
    join(
        &store,
        &owner.id,
        &team.id,
        &first.id,
        "first@ownership.test",
        "admin",
    )
    .await;
    join(
        &store,
        &owner.id,
        &team.id,
        &second.id,
        "second@ownership.test",
        "member",
    )
    .await;
    let (left, right) = tokio::join!(
        store.transfer_team_ownership(&owner.id, &team.id, &first.id),
        store.transfer_team_ownership(&owner.id, &team.id, &second.id),
    );
    assert_ne!(left.is_ok(), right.is_ok());
    assert!(matches!(
        if left.is_ok() { right } else { left },
        Err(Error::Forbidden)
    ));
    assert_eq!(store.team_role(&owner.id, &team.id).await.unwrap(), "admin");
    let members = store.members(&owner.id, &team.id).await.unwrap();
    let owners = members
        .iter()
        .filter(|m| m["role"] == "owner")
        .collect::<Vec<_>>();
    assert_eq!(owners.len(), 1);
    assert!(owners[0]["userId"] == first.id || owners[0]["userId"] == second.id);
    cleanup(store, db, name).await;
}

#[tokio::test]
#[ignore = "requires PostgreSQL TEST_DATABASE_URL"]
async fn migration_promotes_first_admin_per_team_and_preserves_billing() {
    let (store, db, name) = fixture().await;
    // Restore the exact v11 membership shape before adding legacy records.
    store
        .database()
        .execute_unprepared(include_str!("../src/team_owner_down.sql"))
        .await
        .unwrap();
    store
        .database()
        .execute_unprepared("DELETE FROM cp_migrations WHERE version=12")
        .await
        .unwrap();
    store.database().execute_unprepared("INSERT INTO cp_users(id,name,email) VALUES ('z-admin','Z','z@ownership.test'),('a-admin','A','a@ownership.test'),('0-member','M','member@ownership.test'); INSERT INTO cp_teams(name) VALUES ('Legacy A'),('Legacy B'); INSERT INTO cp_members SELECT id,'z-admin','admin' FROM cp_teams; INSERT INTO cp_members SELECT id,'a-admin','admin' FROM cp_teams WHERE name='Legacy A'; INSERT INTO cp_members SELECT id,'0-member','member' FROM cp_teams WHERE name='Legacy A'; INSERT INTO cp_billing_profiles(team_id,period_anchor,customer_id) SELECT id,1,'cus_'||id FROM cp_teams").await.unwrap();
    let before = store
        .database()
        .query_all_raw(sql(
            "SELECT to_jsonb(b) AS record FROM cp_billing_profiles b ORDER BY team_id",
            vec![],
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.try_get::<Value>("", "record").unwrap())
        .collect::<Vec<_>>();
    schema::migrate(store.database()).await.unwrap();
    schema::migrate(store.database()).await.unwrap();
    let rows = store.database().query_all_raw(sql("SELECT jsonb_build_object('team',t.name,'user',m.user_id) AS record FROM cp_teams t JOIN cp_members m ON m.team_id=t.id WHERE m.role='owner' ORDER BY t.name", vec![])).await.unwrap().into_iter().map(|r| r.try_get::<Value>("", "record").unwrap()).collect::<Vec<_>>();
    assert_eq!(
        rows,
        vec![
            json!({"team":"Legacy A","user":"a-admin"}),
            json!({"team":"Legacy B","user":"z-admin"})
        ]
    );
    let after = store
        .database()
        .query_all_raw(sql(
            "SELECT to_jsonb(b) AS record FROM cp_billing_profiles b ORDER BY team_id",
            vec![],
        ))
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.try_get::<Value>("", "record").unwrap())
        .collect::<Vec<_>>();
    assert_eq!(after, before);
    let member = store
        .database()
        .query_one_raw(sql(
            "SELECT role FROM cp_members WHERE user_id='0-member'",
            vec![],
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(member.try_get::<String>("", "role").unwrap(), "member");
    cleanup(store, db, name).await;
}
