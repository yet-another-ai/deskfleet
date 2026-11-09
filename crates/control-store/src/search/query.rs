use sea_orm::{
    DeriveIden,
    sea_query::{
        Alias, Asterisk, BinOper, CommonTableExpression, Cond, Expr, ExprTrait, Func, JoinType,
        Order, Query, SelectStatement, WithClause, extension::postgres::PgExpr,
    },
};

use super::Cursor;
use crate::entities::{
    cp_catalogs as catalogs, cp_machine_registrations as registrations, cp_members as members,
    cp_schedules as schedules, cp_search_documents as documents, cp_sessions as sessions,
};

#[derive(DeriveIden)]
enum Stage {
    Candidates,
    Best,
    Page,
}

#[derive(DeriveIden)]
enum Column {
    MachineId,
    MachineName,
    Kind,
    ResourceId,
    EntryId,
    BlockNo,
    Priority,
    Content,
    Title,
    WorkspaceId,
    UpdatedAt,
    Workspaces,
    SnippetStart,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn search(
    team: i64,
    user: &str,
    kind: &str,
    pattern: &str,
    cursor: Option<&Cursor>,
    limit: u32,
    query: &str,
) -> SelectStatement {
    let chat = Expr::col((documents::Entity, documents::Column::Kind)).eq("chat");
    let schedule = Expr::col((documents::Entity, documents::Column::Kind)).eq("schedule");
    let title = Expr::case(chat.clone(), session_field("{session,title}")).finally(
        Expr::col((schedules::Entity, schedules::Column::Record))
            .cast_json_field(Expr::Constant("title".into())),
    );
    let workspace = Expr::case(chat.clone(), session_field("{session,workspaceId}")).finally(
        Expr::col((schedules::Entity, schedules::Column::Record))
            .cast_json_field(Expr::Constant("workspaceId".into())),
    );
    let updated = Expr::case(chat.clone(), session_field("{session,updatedAt}")).finally(
        Expr::col((schedules::Entity, schedules::Column::Record))
            .cast_json_field(Expr::Constant("updatedAt".into())),
    );
    let mut candidates = Query::select();
    candidates
        .column((documents::Entity, Asterisk))
        .column((registrations::Entity, registrations::Column::MachineId))
        .expr_as(
            Expr::col((registrations::Entity, registrations::Column::Name)),
            Column::MachineName,
        )
        .expr_as(title, Column::Title)
        .expr_as(workspace, Column::WorkspaceId)
        .expr_as(
            Func::coalesce([updated.into(), Expr::val("")]),
            Column::UpdatedAt,
        )
        .expr_as(
            Expr::col((catalogs::Entity, catalogs::Column::Snapshot))
                .get_json_field(Expr::Constant("workspaces".into())),
            Column::Workspaces,
        )
        .from(documents::Entity)
        .join(
            JoinType::InnerJoin,
            registrations::Entity,
            Expr::col((registrations::Entity, registrations::Column::Id)).eq(Expr::col((
                documents::Entity,
                documents::Column::RegistrationId,
            ))),
        )
        .join(
            JoinType::InnerJoin,
            members::Entity,
            Expr::col((members::Entity, members::Column::TeamId))
                .eq(Expr::col((
                    registrations::Entity,
                    registrations::Column::TeamId,
                )))
                .and(Expr::col((members::Entity, members::Column::UserId)).eq(user)),
        )
        .join(
            JoinType::InnerJoin,
            catalogs::Entity,
            Expr::col((catalogs::Entity, catalogs::Column::RegistrationId)).eq(Expr::col((
                registrations::Entity,
                registrations::Column::Id,
            ))),
        )
        .join(
            JoinType::LeftJoin,
            sessions::Entity,
            chat.clone()
                .and(
                    Expr::col((sessions::Entity, sessions::Column::RegistrationId)).eq(Expr::col(
                        (documents::Entity, documents::Column::RegistrationId),
                    )),
                )
                .and(
                    Expr::col((sessions::Entity, sessions::Column::SessionId)).eq(Expr::col((
                        documents::Entity,
                        documents::Column::ResourceId,
                    ))),
                ),
        )
        .join(
            JoinType::LeftJoin,
            schedules::Entity,
            schedule
                .clone()
                .and(
                    Expr::col((schedules::Entity, schedules::Column::RegistrationId)).eq(
                        Expr::col((documents::Entity, documents::Column::RegistrationId)),
                    ),
                )
                .and(
                    Expr::col((schedules::Entity, schedules::Column::ScheduleId)).eq(Expr::col((
                        documents::Entity,
                        documents::Column::ResourceId,
                    ))),
                ),
        )
        .and_where(Expr::col((registrations::Entity, registrations::Column::TeamId)).eq(team))
        .and_where(Expr::col((registrations::Entity, registrations::Column::Revoked)).not())
        // PostgreSQL's default ILIKE escape is backslash, matching escape_like.
        .and_where(Expr::col((documents::Entity, documents::Column::Content)).ilike(pattern))
        .cond_where(
            Cond::any()
                .add(
                    chat.and(
                        Expr::col((sessions::Entity, sessions::Column::SessionId)).is_not_null(),
                    )
                    .and(Expr::col((sessions::Entity, sessions::Column::DeletedAt)).is_null())
                    .and(
                        Expr::col((catalogs::Entity, catalogs::Column::Snapshot))
                            .get_json_field(Expr::Constant("sessionIds".into()))
                            .binary(
                                BinOper::Custom("?"),
                                Expr::col((documents::Entity, documents::Column::ResourceId)),
                            ),
                    ),
                )
                .add(schedule.and(
                    Expr::col((schedules::Entity, schedules::Column::ScheduleId)).is_not_null(),
                )),
        );
    if kind != "all" {
        candidates.and_where(Expr::col((documents::Entity, documents::Column::Kind)).eq(kind));
    }
    let best = Query::select()
        .distinct_on([Column::MachineId, Column::Kind, Column::ResourceId])
        .column(Asterisk)
        .from(Stage::Candidates)
        .order_by(Column::MachineId, Order::Asc)
        .order_by(Column::Kind, Order::Asc)
        .order_by(Column::ResourceId, Order::Asc)
        .order_by(Column::Priority, Order::Asc)
        .order_by(Column::EntryId, Order::Asc)
        .order_by(Column::BlockNo, Order::Asc)
        .to_owned();
    let snippet_start = Func::greatest([
        Expr::val(1),
        Func::cust("strpos")
            .args([
                Expr::from(Func::lower(Expr::col(Column::Content))),
                Expr::from(Func::lower(Expr::val(query))),
            ])
            .sub(70),
    ]);
    let mut page = Query::select();
    page.column(Asterisk)
        .expr_as(snippet_start, Column::SnippetStart)
        .from(Stage::Best);
    if let Some(cursor) = cursor {
        page.cond_where(
            Cond::any()
                .add(Expr::col(Column::Priority).gt(cursor.priority))
                .add(
                    Expr::col(Column::Priority)
                        .eq(cursor.priority)
                        .and(Expr::col(Column::UpdatedAt).lt(cursor.updated_at.as_str())),
                )
                .add(
                    Expr::col(Column::Priority)
                        .eq(cursor.priority)
                        .and(Expr::col(Column::UpdatedAt).eq(cursor.updated_at.as_str()))
                        .and(
                            Expr::tuple([
                                Expr::col(Column::Kind),
                                Expr::col(Column::MachineId),
                                Expr::col(Column::ResourceId),
                            ])
                            .gt(Expr::tuple([
                                Expr::val(cursor.kind.as_str()),
                                Expr::val(cursor.machine_id),
                                Expr::val(cursor.resource_id.as_str()),
                            ])),
                        ),
                ),
        );
    }
    order_page(&mut page);
    page.limit(u64::from(limit));
    let workspaces = Func::coalesce([
        Expr::col(Column::Workspaces),
        Expr::val("[]").cast_as("jsonb"),
    ]);
    let workspace_name = Query::select()
        .expr(Expr::col(Alias::new("w")).cast_json_field(Expr::Constant("name".into())))
        .from_function(
            Func::cust("jsonb_array_elements").arg(workspaces),
            Alias::new("w"),
        )
        .and_where(
            Expr::col(Alias::new("w"))
                .cast_json_field(Expr::Constant("id".into()))
                .eq(Expr::col(Column::WorkspaceId)),
        )
        .limit(1)
        .to_owned();
    let entry = Expr::case(
        Expr::col(Column::Kind)
            .eq("chat")
            .and(Expr::col(Column::EntryId).ne("$title")),
        Expr::col(Column::EntryId),
    )
    .finally(Expr::val(Option::<String>::None));
    let prefix: Expr = Expr::case(Expr::col(Column::SnippetStart).gt(1), "…")
        .finally("")
        .into();
    let snippet = prefix
        .concatenate(Func::cust("substring").args([
            Expr::col(Column::Content),
            Expr::col(Column::SnippetStart),
            Func::char_length(Expr::val(query)).add(160),
        ]))
        .concatenate(
            Expr::case(
                Func::char_length(Expr::col(Column::Content)).gte(
                    Expr::col(Column::SnippetStart)
                        .add(Func::char_length(Expr::val(query)))
                        .add(160),
                ),
                "…",
            )
            .finally(""),
        );
    let result = Func::cust("jsonb_strip_nulls").arg(object([
        ("kind", Expr::col(Column::Kind)),
        ("machineId", Expr::col(Column::MachineId).cast_as("text")),
        ("machineName", Expr::col(Column::MachineName)),
        ("workspaceId", Expr::col(Column::WorkspaceId)),
        ("workspaceName", Expr::from(workspace_name)),
        ("resourceId", Expr::col(Column::ResourceId)),
        ("title", Expr::col(Column::Title)),
        ("updatedAt", Expr::col(Column::UpdatedAt)),
        ("entryId", entry.into()),
        ("snippet", snippet),
    ]));
    let cursor = object([
        ("priority", Expr::col(Column::Priority)),
        ("updatedAt", Expr::col(Column::UpdatedAt)),
        ("kind", Expr::col(Column::Kind)),
        ("machineId", Expr::col(Column::MachineId)),
        ("resourceId", Expr::col(Column::ResourceId)),
    ]);
    let mut query = Query::select();
    query
        .expr_as(result, Alias::new("result"))
        .expr_as(cursor, Alias::new("cursor"))
        .from(Stage::Page)
        .with_cte(
            WithClause::new()
                .cte(
                    CommonTableExpression::new()
                        .table_name(Stage::Candidates)
                        .query(candidates)
                        .to_owned(),
                )
                .cte(
                    CommonTableExpression::new()
                        .table_name(Stage::Best)
                        .query(best)
                        .to_owned(),
                )
                .cte(
                    CommonTableExpression::new()
                        .table_name(Stage::Page)
                        .query(page)
                        .to_owned(),
                )
                .to_owned(),
        );
    order_page(&mut query);
    query
}

fn order_page(query: &mut SelectStatement) {
    query
        .order_by(Column::Priority, Order::Asc)
        .order_by(Column::UpdatedAt, Order::Desc)
        .order_by(Column::Kind, Order::Asc)
        .order_by(Column::MachineId, Order::Asc)
        .order_by(Column::ResourceId, Order::Asc);
}

fn session_field(path: &'static str) -> Expr {
    // PostgreSQL's JSON path and existence operators are not exposed by PgBinOper.
    Expr::col((sessions::Entity, sessions::Column::Summary))
        .binary(BinOper::Custom("#>>"), Expr::Constant(path.into()))
}

fn object<const N: usize>(pairs: [(&'static str, Expr); N]) -> sea_orm::sea_query::FunctionCall {
    Func::cust("jsonb_build_object").args(
        pairs
            .into_iter()
            .flat_map(|(key, value)| [Expr::Constant(key.into()), value]),
    )
}
