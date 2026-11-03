use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, QueryResult, QuerySelect,
    QueryTrait,
    sea_query::{Alias, Expr, ExprTrait, Func, Query, SelectStatement},
};
use serde::de::DeserializeOwned;

use crate::{
    StoreError,
    entities::{agent_command, agent_elicitation, agent_input, agent_permission, agent_turn},
};

pub(super) fn inputs(session_id: i64) -> SelectStatement {
    agent_input::Entity::find()
        .select_only()
        .column(agent_input::Column::RecordJson)
        .filter(agent_input::Column::SessionId.eq(session_id))
        .order_by_asc(agent_input::Column::AcceptedSeq)
        .order_by_asc(agent_input::Column::Id)
        .into_query()
}

pub(super) fn turns(session_id: i64) -> SelectStatement {
    agent_turn::Entity::find()
        .select_only()
        .column(agent_turn::Column::RecordJson)
        .filter(agent_turn::Column::SessionId.eq(session_id))
        .order_by_asc(agent_turn::Column::Id)
        .into_query()
}

pub(super) fn permissions(session_id: i64) -> SelectStatement {
    agent_permission::Entity::find()
        .select_only()
        .column(agent_permission::Column::RecordJson)
        .filter(agent_permission::Column::SessionId.eq(session_id))
        .order_by_asc(agent_permission::Column::Id)
        .into_query()
}

pub(super) fn elicitations(session_id: i64) -> SelectStatement {
    agent_elicitation::Entity::find()
        .select_only()
        .column(agent_elicitation::Column::RecordJson)
        .filter(agent_elicitation::Column::SessionId.eq(session_id))
        .order_by_asc(agent_elicitation::Column::Id)
        .into_query()
}

pub(super) fn commands(session_id: i64) -> SelectStatement {
    agent_command::Entity::find()
        .select_only()
        .column(agent_command::Column::RecordJson)
        .filter(agent_command::Column::SessionId.eq(session_id))
        .order_by_asc(agent_command::Column::Id)
        .into_query()
}

pub(super) fn command_changes(session_id: i64, revision: i64) -> SelectStatement {
    agent_command::Entity::find()
        .select_only()
        .column(agent_command::Column::RecordJson)
        .filter(agent_command::Column::SessionId.eq(session_id))
        .filter(agent_command::Column::Revision.gt(revision))
        .order_by_asc(agent_command::Column::Revision)
        .order_by_asc(agent_command::Column::Id)
        .into_query()
}

pub(super) fn command(operation_id: &str) -> SelectStatement {
    agent_command::Entity::find()
        .select_only()
        .column(agent_command::Column::RecordJson)
        .filter(agent_command::Column::OperationId.eq(operation_id))
        // The literal TRUE must match the partial index predicate.
        .filter(
            Expr::col((agent_command::Entity, agent_command::Column::IsCanonical))
                .eq(Expr::Constant(true.into())),
        )
        .into_query()
}

pub(super) fn deleted_admission(session_id: i64) -> SelectStatement {
    let deleted = agent_command::Entity::find()
        .select_only()
        .expr(Expr::Constant(1.into()))
        .filter(agent_command::Column::SessionId.is_null())
        .filter(
            Func::cust("json_extract")
                .arg(Expr::col(agent_command::Column::RecordJson))
                // The path is a literal so SQLite can use its expression index.
                .arg(Expr::Constant("$.sessionId".into()))
                .eq(session_id.to_string()),
        )
        .filter(
            Expr::col((agent_command::Entity, agent_command::Column::IsCanonical))
                .eq(Expr::Constant(true.into())),
        )
        .filter(
            Func::cust("json_extract")
                .arg(Expr::col(agent_command::Column::RecordJson))
                .arg(Expr::Constant("$.method".into()))
                .eq("_deskfleet/session/delete"),
        )
        .into_query();
    Query::select()
        .expr_as(Expr::exists(deleted), Alias::new("deleted"))
        .to_owned()
}

pub(super) async fn records<T: DeserializeOwned>(
    db: &impl ConnectionTrait,
    query: SelectStatement,
) -> Result<Vec<T>, StoreError> {
    db.query_all(&query)
        .await?
        .into_iter()
        .map(decode_record)
        .collect()
}

pub(super) async fn record<T: DeserializeOwned>(
    db: &impl ConnectionTrait,
    query: SelectStatement,
) -> Result<Option<T>, StoreError> {
    db.query_one(&query).await?.map(decode_record).transpose()
}

fn decode_record<T: DeserializeOwned>(row: QueryResult) -> Result<T, StoreError> {
    let json: String = row.try_get("", "record_json")?;
    Ok(serde_json::from_str(&json)?)
}

pub(super) fn positive(value: i64) -> Result<i64, StoreError> {
    if value <= 0 {
        return Err(StoreError::InvalidAgent("IDs must be positive"));
    }
    Ok(value)
}

pub(super) fn generation(value: u64) -> Result<i64, StoreError> {
    positive(
        i64::try_from(value).map_err(|_| StoreError::InvalidAgent("generation is out of range"))?,
    )
}
