//! Team mutations serialize with account disabling before changing membership.
use std::time::Duration;

use deskfleet_control_store::{ControlStore, Error};
use sea_orm::{
    ConnectionTrait, Database, DatabaseConnection, DatabaseTransaction, DbBackend, Statement,
    TransactionTrait,
};

fn sql(text: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, text, values)
}

struct Fixture {
    store: ControlStore,
    admin: DatabaseConnection,
    schema: String,
    owner: String,
    member: String,
    team: String,
}

impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
        let admin = Database::connect(&url).await.unwrap();
        let schema = format!("team_accounts_{}", uuid::Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let separator = if url.contains('?') { '&' } else { '?' };
        let store =
            ControlStore::connect(&format!("{url}{separator}options=-csearch_path%3D{schema}"))
                .await
                .unwrap();
        let owner = store
            .verified_user("owner@fixture.test", "Owner")
            .await
            .unwrap()
            .id;
        let member = store
            .verified_user("member@fixture.test", "Member")
            .await
            .unwrap()
            .id;
        let team = store.create_team(&owner, "Team").await.unwrap().id;
        Self {
            store,
            admin,
            schema,
            owner,
            member,
            team,
        }
    }

    async fn disable_pending(&self, user: &str) -> DatabaseTransaction {
        let tx = self.store.database().begin().await.unwrap();
        // Match disable_account's lock before its account and session writes.
        tx.execute_raw(sql(
            "SELECT id FROM cp_users WHERE id=$1 FOR UPDATE",
            vec![user.into()],
        ))
        .await
        .unwrap();
        tx.execute_raw(sql(
            "UPDATE cp_users SET disabled=TRUE WHERE id=$1",
            vec![user.into()],
        ))
        .await
        .unwrap();
        tx
    }

    async fn wait_for_operation<T>(
        &self,
        tx: &DatabaseTransaction,
        task: &tokio::task::JoinHandle<T>,
    ) {
        let pid: i32 = tx
            .query_one_raw(sql("SELECT pg_backend_pid() AS pid", vec![]))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "pid")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let blocked: bool = self.admin.query_one_raw(sql(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
                    vec![pid.into()],
                )).await.unwrap().unwrap().try_get("", "blocked").unwrap();
                if blocked || task.is_finished() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("operation must finish or reach the account lock");
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

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn invite_acceptance_does_not_commit_membership_after_account_disabling() {
    let fixture = Fixture::new().await;
    let invite = fixture
        .store
        .invite(
            &fixture.owner,
            &fixture.team,
            "member@fixture.test",
            "member",
        )
        .await
        .unwrap();
    let token = invite["token"].as_str().unwrap().to_owned();
    let blocker = fixture.disable_pending(&fixture.member).await;
    let store = fixture.store.clone();
    let member = fixture.member.clone();
    let task = tokio::spawn(async move { store.accept_invite(&member, &token).await });
    fixture.wait_for_operation(&blocker, &task).await;
    blocker.commit().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Forbidden)));
    let row = fixture.store.database().query_one_raw(sql(
        "SELECT EXISTS(SELECT 1 FROM cp_members WHERE team_id=$1 AND user_id=$2) AS joined, EXISTS(SELECT 1 FROM cp_invites WHERE team_id=$1) AS invited",
        vec![fixture.team.parse::<i64>().unwrap().into(), fixture.member.clone().into()],
    )).await.unwrap().unwrap();
    assert!(!row.try_get::<bool>("", "joined").unwrap());
    assert!(row.try_get::<bool>("", "invited").unwrap());
    fixture
        .store
        .database()
        .execute_raw(sql(
            "UPDATE cp_users SET disabled=FALSE WHERE id=$1",
            vec![fixture.member.clone().into()],
        ))
        .await
        .unwrap();
    let joined = fixture
        .store
        .accept_invite(&fixture.member, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(joined.role, "member");
    // A fresh invitation cannot downgrade an existing owner's effective role.
    let invite = fixture
        .store
        .invite(
            &fixture.owner,
            &fixture.team,
            "owner@fixture.test",
            "member",
        )
        .await
        .unwrap();
    let existing = fixture
        .store
        .accept_invite(&fixture.owner, invite["token"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(existing.role, "owner");
    fixture.close().await;
}

#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn ownership_transfer_rechecks_both_accounts_after_concurrent_disabling() {
    for disable_owner in [false, true] {
        let fixture = Fixture::new().await;
        fixture
            .store
            .database()
            .execute_raw(sql(
                "INSERT INTO cp_members VALUES($1,$2,'member')",
                vec![
                    fixture.team.parse::<i64>().unwrap().into(),
                    fixture.member.clone().into(),
                ],
            ))
            .await
            .unwrap();
        let blocker = fixture
            .disable_pending(if disable_owner {
                &fixture.owner
            } else {
                &fixture.member
            })
            .await;
        let store = fixture.store.clone();
        let owner = fixture.owner.clone();
        let member = fixture.member.clone();
        let team = fixture.team.clone();
        let task =
            tokio::spawn(
                async move { store.transfer_team_ownership(&owner, &team, &member).await },
            );
        fixture.wait_for_operation(&blocker, &task).await;
        blocker.commit().await.unwrap();
        let result = task.await.unwrap();
        if disable_owner {
            assert!(matches!(result, Err(Error::Forbidden)));
        } else {
            assert!(matches!(result, Err(Error::Invalid(_))));
        }
        let owner: String = fixture
            .store
            .database()
            .query_one_raw(sql(
                "SELECT user_id FROM cp_members WHERE team_id=$1 AND role='owner'",
                vec![fixture.team.parse::<i64>().unwrap().into()],
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get("", "user_id")
            .unwrap();
        assert_eq!(owner, fixture.owner);
        fixture.close().await;
    }
}
