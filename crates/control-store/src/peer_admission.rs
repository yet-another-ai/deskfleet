//! Quota locks serialize admission across replicas, independently of authorization locks.
use crate::entities::cp_peers as peers;
use crate::{Error, Result, now_ms, one_query};
use deskfleet_protocol::control::PeerAuthorization;
use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Alias, Expr, ExprTrait, Func, Query};
use sea_orm::{ConnectionTrait, DatabaseTransaction};

pub(crate) async fn lock(tx: &DatabaseTransaction, user: &str, team: i64) -> Result<()> {
    // Always user then Team. The Team lock also serializes registration quotas.
    for key in [format!("peer-user:{user}"), format!("peer-team:{team}")] {
        tx.execute(
            Query::select().expr(
                Func::cust(Alias::new("pg_advisory_xact_lock")).arg(
                    Func::cust(Alias::new("hashtextextended"))
                        .args([Expr::val(key), Expr::val(761946022_i64)]),
                ),
            ),
        )
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
    let row = one_query(
        tx,
        Query::select()
            .from(peers::Entity)
            .expr_as(
                Func::count(Expr::col(sea_orm::sea_query::Asterisk))
                    .filter(Expr::col(peers::Column::UserId).eq(&auth.actor.user_id)),
                Alias::new("per_user"),
            )
            .expr_as(
                Func::count(Expr::col(sea_orm::sea_query::Asterisk))
                    .filter(Expr::col(peers::Column::LoginSessionId).eq(login)),
                Alias::new("per_login"),
            )
            .expr_as(
                Func::count(Expr::col(sea_orm::sea_query::Asterisk))
                    .filter(Expr::col(peers::Column::TeamId).eq(team)),
                Alias::new("per_team"),
            )
            .expr_as(
                Func::count(Expr::col(sea_orm::sea_query::Asterisk))
                    .filter(Expr::col(peers::Column::RegistrationId).eq(registration)),
                Alias::new("per_registration"),
            )
            .expr_as(
                Func::count(Expr::col(sea_orm::sea_query::Asterisk)).filter(
                    Expr::col(peers::Column::RegistrationId)
                        .eq(registration)
                        .and(
                            Expr::col(peers::Column::GrantJson)
                                .cast_json_field("purpose")
                                .eq(&auth.purpose),
                        ),
                ),
                Alias::new("per_purpose"),
            )
            .and_where(Expr::col(peers::Column::Revoked).not())
            .and_where(Expr::col(peers::Column::ExpiresAt).gt(now_ms()))
            .and_where(
                Expr::col(peers::Column::UserId)
                    .eq(&auth.actor.user_id)
                    .or(Expr::col(peers::Column::TeamId).eq(team)),
            ),
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
