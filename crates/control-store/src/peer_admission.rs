//! Quota locks serialize admission across replicas, independently of authorization locks.
use crate::{Error, Result, now_ms, one, sql};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::{ConnectionTrait, DatabaseTransaction};

pub(crate) async fn lock(tx: &DatabaseTransaction, user: &str, team: i64) -> Result<()> {
    // Always user then Team. The Team lock also serializes registration quotas.
    for key in [format!("peer-user:{user}"), format!("peer-team:{team}")] {
        tx.execute_raw(sql(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,761946022))",
            vec![key.into()],
        ))
        .await?;
    }
    Ok(())
}

pub(crate) async fn reserve(
    tx: &DatabaseTransaction,
    auth: &PeerAuthorization,
    login: &str,
    team: i64,
    registration: i64,
) -> Result<()> {
    lock(tx, &auth.actor.user_id, team).await?;
    let row = one(
        tx,
        "SELECT count(*) FILTER (WHERE user_id=$1) AS per_user,
         count(*) FILTER (WHERE login_session_id=$2) AS per_login,
         count(*) FILTER (WHERE team_id=$3) AS per_team,
         count(*) FILTER (WHERE registration_id=$4) AS per_registration,
         count(*) FILTER (WHERE registration_id=$4 AND grant_json->>'purpose'=$6) AS per_purpose
         FROM cp_peers WHERE NOT revoked AND expires_at>$5 AND (user_id=$1 OR team_id=$3)",
        vec![
            auth.actor.user_id.clone().into(),
            login.into(),
            team.into(),
            registration.into(),
            now_ms().into(),
            auth.purpose.clone().into(),
        ],
    )
    .await?;
    for (column, limit) in [
        ("per_user", 64),
        ("per_login", 16),
        ("per_team", 256),
        ("per_registration", 64),
        (
            "per_purpose",
            if auth.purpose == "desktop" { 8 } else { 32 },
        ),
    ] {
        if row.try_get::<i64>("", column)? >= limit {
            return Err(Error::Limited("peer capacity exceeded"));
        }
    }
    Ok(())
}
