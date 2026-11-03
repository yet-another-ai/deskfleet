//! Leased API socket ownership and short-lived cross-process delivery.
use crate::entities::{
    cp_machine_registrations as registrations, cp_peer_negotiations as negotiations,
    cp_peers as peers, cp_realtime_messages as messages, cp_realtime_nodes as nodes,
    cp_realtime_routes as routes,
};
use crate::{ControlStore, Error, Result, one_query, resource_id};
use sea_orm::sea_query::{
    Alias, CommonTableExpression, Expr, ExprTrait, Func, JoinType, LockBehavior, LockType,
    OnConflict, Order, Query, WithClause,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult, TransactionTrait};
use serde_json::Value;

fn clock_timestamp() -> Expr {
    Func::cust(Alias::new("clock_timestamp")).into()
}
fn statement_timestamp() -> Expr {
    Func::cust(Alias::new("statement_timestamp")).into()
}

/// The API process and socket connection that currently own a machine route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RealtimeRoute {
    pub node_id: String,
    pub connection_id: String,
}

impl RealtimeRoute {
    fn from_row(row: QueryResult) -> Result<Self> {
        Ok(Self {
            node_id: row.try_get("", "node_id")?,
            connection_id: row.try_get("", "connection_id")?,
        })
    }
}

impl ControlStore {
    /// Resolve a collection's presence in one indexed query, including lease and
    /// machine revocation checks used by individual route lookups.
    pub async fn online_machines(
        &self,
        machines: &[String],
    ) -> Result<std::collections::HashSet<String>> {
        let ids = machines
            .iter()
            .map(|id| resource_id(id))
            .collect::<Result<Vec<_>>>()?;
        if ids.is_empty() {
            return Ok(Default::default());
        }
        self.db
            .query_all(
                Query::select()
                    .column((routes::Entity, routes::Column::RegistrationId))
                    .from_function(
                        Func::cust(Alias::new("jsonb_array_elements_text"))
                            .arg(Expr::val(serde_json::json!(ids)).cast_as(Alias::new("jsonb"))),
                        Alias::new("target"),
                    )
                    .join(
                        JoinType::InnerJoin,
                        routes::Entity,
                        Expr::col((routes::Entity, routes::Column::RegistrationId))
                            .eq(Expr::col(Alias::new("target")).cast_as(Alias::new("bigint"))),
                    )
                    .join(
                        JoinType::InnerJoin,
                        nodes::Entity,
                        Expr::col((nodes::Entity, nodes::Column::Id))
                            .equals((routes::Entity, routes::Column::NodeId)),
                    )
                    .join(
                        JoinType::InnerJoin,
                        registrations::Entity,
                        Expr::col((registrations::Entity, registrations::Column::Id))
                            .equals((routes::Entity, routes::Column::RegistrationId)),
                    )
                    .and_where(
                        Expr::col((nodes::Entity, nodes::Column::LeaseUntil))
                            .gt(statement_timestamp()),
                    )
                    .and_where(
                        Expr::col((registrations::Entity, registrations::Column::Revoked)).not(),
                    ),
            )
            .await?
            .into_iter()
            .map(|row| Ok(row.try_get::<i64>("", "registration_id")?.to_string()))
            .collect()
    }
    /// Register an API process using its newly generated UUID.
    pub async fn register_node(&self, node: &str) -> Result<()> {
        uuid::Uuid::parse_str(node)
            .map_err(|_| Error::Invalid("invalid realtime node identity"))?;
        let tx = self.db.begin().await?;
        tx.execute(
            Query::insert()
                .into_table(nodes::Entity)
                .columns([nodes::Column::Id])
                .values_panic([node.into()])
                .on_conflict(
                    OnConflict::column(nodes::Column::Id)
                        .do_nothing()
                        .to_owned(),
                ),
        )
        .await?;
        renew_node(&tx, node).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Renew the lease using the database clock. False means ownership expired:
    /// its routes and inbox were cleared, and the caller must close old sockets.
    pub async fn heartbeat_node(&self, node: &str) -> Result<bool> {
        let tx = self.db.begin().await?;
        let uninterrupted = renew_node(&tx, node).await?;
        tx.commit().await?;
        Ok(uninterrupted)
    }

    /// Drop this process's routes and undelivered messages with its registration.
    pub async fn release_node(&self, node: &str) -> Result<()> {
        self.db
            .execute(
                Query::delete()
                    .from_table(nodes::Entity)
                    .and_where(Expr::col(nodes::Column::Id).eq(node)),
            )
            .await?;
        Ok(())
    }

    /// Replace a machine's route atomically and return its previous owner.
    /// The machine row serializes claims even when no route exists yet.
    pub async fn claim_machine_route(
        &self,
        machine: &str,
        node: &str,
        connection: &str,
    ) -> Result<Option<RealtimeRoute>> {
        let machine = resource_id(machine)?;
        let tx = self.db.begin().await?;
        one_query(
            &tx,
            Query::select()
                .column(registrations::Column::Id)
                .from(registrations::Entity)
                .and_where(Expr::col(registrations::Column::Id).eq(machine))
                .and_where(Expr::col(registrations::Column::Revoked).not())
                .lock(LockType::Update),
        )
        .await?;
        if !lock_node(&tx, node).await? {
            return Err(Error::NotFound);
        }
        let previous = tx
            .query_one(
                Query::select()
                    .columns([routes::Column::NodeId, routes::Column::ConnectionId])
                    .from(routes::Entity)
                    .and_where(Expr::col(routes::Column::RegistrationId).eq(machine)),
            )
            .await?
            .map(RealtimeRoute::from_row)
            .transpose()?;
        tx.execute(
            Query::insert()
                .into_table(routes::Entity)
                .columns([
                    routes::Column::RegistrationId,
                    routes::Column::NodeId,
                    routes::Column::ConnectionId,
                ])
                .values_panic([machine.into(), node.into(), connection.into()])
                .on_conflict(
                    OnConflict::column(routes::Column::RegistrationId)
                        .update_columns([routes::Column::NodeId, routes::Column::ConnectionId])
                        .to_owned(),
                ),
        )
        .await?;
        tx.commit().await?;
        Ok(previous)
    }

    /// A replaced connection cannot remove the replacement's route.
    pub async fn release_machine_route(
        &self,
        machine: &str,
        node: &str,
        connection: &str,
    ) -> Result<bool> {
        Ok(self
            .db
            .execute(
                Query::delete()
                    .from_table(routes::Entity)
                    .and_where(Expr::col(routes::Column::RegistrationId).eq(resource_id(machine)?))
                    .and_where(Expr::col(routes::Column::NodeId).eq(node))
                    .and_where(Expr::col(routes::Column::ConnectionId).eq(connection)),
            )
            .await?
            .rows_affected()
            == 1)
    }

    /// Expired nodes and revoked machines are never advertised as online.
    pub async fn machine_route(&self, machine: &str) -> Result<Option<RealtimeRoute>> {
        self.db
            .query_one(
                Query::select()
                    .columns(
                        [routes::Column::NodeId, routes::Column::ConnectionId]
                            .map(|c| (routes::Entity, c)),
                    )
                    .from(routes::Entity)
                    .join(
                        JoinType::InnerJoin,
                        nodes::Entity,
                        Expr::col((nodes::Entity, nodes::Column::Id))
                            .equals((routes::Entity, routes::Column::NodeId)),
                    )
                    .join(
                        JoinType::InnerJoin,
                        registrations::Entity,
                        Expr::col((registrations::Entity, registrations::Column::Id))
                            .equals((routes::Entity, routes::Column::RegistrationId)),
                    )
                    .and_where(
                        Expr::col((routes::Entity, routes::Column::RegistrationId))
                            .eq(resource_id(machine)?),
                    )
                    .and_where(
                        Expr::col((nodes::Entity, nodes::Column::LeaseUntil)).gt(clock_timestamp()),
                    )
                    .and_where(
                        Expr::col((registrations::Entity, registrations::Column::Revoked)).not(),
                    ),
            )
            .await?
            .map(RealtimeRoute::from_row)
            .transpose()
    }

    pub async fn route_is_current(
        &self,
        machine: &str,
        node: &str,
        connection: &str,
    ) -> Result<bool> {
        Ok(self
            .machine_route(machine)
            .await?
            .is_some_and(|route| route.node_id == node && route.connection_id == connection))
    }

    /// Queue only for a live node. Delivery is bounded by the message's TTL.
    pub async fn publish_node(&self, target: &str, payload: &Value) -> Result<bool> {
        Ok(self
            .db
            .execute(
                Query::insert()
                    .into_table(messages::Entity)
                    .columns([messages::Column::NodeId, messages::Column::Payload])
                    .select_from(
                        Query::select()
                            .column(nodes::Column::Id)
                            .expr(Expr::val(payload.clone()))
                            .from(nodes::Entity)
                            .and_where(Expr::col(nodes::Column::Id).eq(target))
                            .and_where(Expr::col(nodes::Column::LeaseUntil).gt(clock_timestamp()))
                            .lock(LockType::KeyShare)
                            .to_owned(),
                    )
                    .expect("two selected message columns"),
            )
            .await?
            .rows_affected()
            == 1)
    }

    /// Each live process receives its own copy; the caller handles local delivery.
    pub async fn broadcast_nodes(&self, exclude_node: &str, payload: &Value) -> Result<()> {
        self.db
            .execute(
                Query::insert()
                    .into_table(messages::Entity)
                    .columns([messages::Column::NodeId, messages::Column::Payload])
                    .select_from(
                        Query::select()
                            .column(nodes::Column::Id)
                            .expr(Expr::val(payload.clone()))
                            .from(nodes::Entity)
                            .and_where(Expr::col(nodes::Column::Id).ne(exclude_node))
                            .and_where(Expr::col(nodes::Column::LeaseUntil).gt(clock_timestamp()))
                            .lock(LockType::KeyShare)
                            .to_owned(),
                    )
                    .expect("two selected message columns"),
            )
            .await?;
        Ok(())
    }

    /// Consume committed messages without an ID cursor: a lower ID can commit
    /// after a later ID has already been delivered. Consumption is at-most-once.
    pub async fn take_node_messages(&self, node: &str, limit: u32) -> Result<Vec<Value>> {
        self.db
            .query_all(
                &Query::select()
                    .column(messages::Column::Payload)
                    .from(Alias::new("consumed"))
                    .order_by(messages::Column::Id, Order::Asc)
                    .with_cte(
                        WithClause::new()
                            .cte(
                                CommonTableExpression::new()
                                    .table_name(Alias::new("consumed"))
                                    .query(
                                        Query::delete()
                                            .from_table(messages::Entity)
                                            .and_where(
                                                Expr::col(messages::Column::Id).in_subquery(
                                                    Query::select()
                                                        .column((
                                                            messages::Entity,
                                                            messages::Column::Id,
                                                        ))
                                                        .from(messages::Entity)
                                                        .join(
                                                            JoinType::InnerJoin,
                                                            nodes::Entity,
                                                            Expr::col((
                                                                nodes::Entity,
                                                                nodes::Column::Id,
                                                            ))
                                                            .equals((
                                                                messages::Entity,
                                                                messages::Column::NodeId,
                                                            )),
                                                        )
                                                        .and_where(
                                                            Expr::col((
                                                                messages::Entity,
                                                                messages::Column::NodeId,
                                                            ))
                                                            .eq(node),
                                                        )
                                                        .and_where(
                                                            Expr::col((
                                                                nodes::Entity,
                                                                nodes::Column::LeaseUntil,
                                                            ))
                                                            .gt(clock_timestamp()),
                                                        )
                                                        .and_where(
                                                            Expr::col((
                                                                messages::Entity,
                                                                messages::Column::ExpiresAt,
                                                            ))
                                                            .gt(clock_timestamp()),
                                                        )
                                                        .order_by(
                                                            (
                                                                messages::Entity,
                                                                messages::Column::Id,
                                                            ),
                                                            Order::Asc,
                                                        )
                                                        .limit(u64::from(limit))
                                                        .lock_with_tables_behavior(
                                                            LockType::Update,
                                                            [messages::Entity],
                                                            LockBehavior::SkipLocked,
                                                        )
                                                        .to_owned(),
                                                ),
                                            )
                                            .returning(Query::returning().columns([
                                                messages::Column::Id,
                                                messages::Column::Payload,
                                            ]))
                                            .to_owned(),
                                    )
                                    .to_owned(),
                            )
                            .to_owned(),
                    )
                    .to_owned(),
            )
            .await?
            .into_iter()
            .map(|row| row.try_get("", "payload").map_err(Error::from))
            .collect()
    }

    /// Expired process rows cascade to routes and messages; TTL also bounds
    /// queued messages for a live process whose consumer has stopped advancing.
    pub async fn prune_realtime(&self) -> Result<()> {
        let tx = self.db.begin().await?;
        // Match renewal's parent-before-child locks while removing expired owners.
        tx.execute(
            Query::delete().from_table(nodes::Entity).and_where(
                Expr::col(nodes::Column::Id).in_subquery(
                    Query::select()
                        .column(nodes::Column::Id)
                        .from(nodes::Entity)
                        .and_where(Expr::col(nodes::Column::LeaseUntil).lte(statement_timestamp()))
                        .limit(100)
                        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
                        .to_owned(),
                ),
            ),
        )
        .await?;
        tx.execute(
            Query::delete().from_table(messages::Entity).and_where(
                Expr::col(messages::Column::Id).in_subquery(
                    Query::select()
                        .column(messages::Column::Id)
                        .from(messages::Entity)
                        .and_where(
                            Expr::col(messages::Column::ExpiresAt).lte(statement_timestamp()),
                        )
                        .order_by(messages::Column::ExpiresAt, Order::Asc)
                        .limit(1000)
                        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
                        .to_owned(),
                ),
            ),
        )
        .await?;
        tx.execute(
            Query::delete().from_table(negotiations::Entity).and_where(
                Expr::col(negotiations::Column::PeerId).in_subquery(
                    Query::select()
                        .column((negotiations::Entity, negotiations::Column::PeerId))
                        .from(negotiations::Entity)
                        .join(
                            JoinType::InnerJoin,
                            peers::Entity,
                            Expr::col((peers::Entity, peers::Column::Id))
                                .equals((negotiations::Entity, negotiations::Column::PeerId)),
                        )
                        .and_where(
                            Expr::col((peers::Entity, peers::Column::Revoked)).or(Expr::col((
                                peers::Entity,
                                peers::Column::ExpiresAt,
                            ))
                            .lte(
                                // SeaQuery has no EXTRACT expression; preserve PostgreSQL numeric epoch rounding.
                                Expr::cust_with_expr(
                                    "EXTRACT(EPOCH FROM $1)",
                                    statement_timestamp(),
                                )
                                .mul(1000)
                                .cast_as(Alias::new("bigint")),
                            )),
                        )
                        .limit(1000)
                        .lock_with_tables_behavior(
                            LockType::Update,
                            [negotiations::Entity],
                            LockBehavior::SkipLocked,
                        )
                        .to_owned(),
                ),
            ),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn renew_node(tx: &DatabaseTransaction, node: &str) -> Result<bool> {
    let live = lock_node(tx, node).await?;
    if !live {
        tx.execute(
            Query::delete()
                .from_table(routes::Entity)
                .and_where(Expr::col(routes::Column::NodeId).eq(node)),
        )
        .await?;
        tx.execute(
            Query::delete()
                .from_table(messages::Entity)
                .and_where(Expr::col(messages::Column::NodeId).eq(node)),
        )
        .await?;
    }
    tx.execute(
        Query::update()
            .table(nodes::Entity)
            .value(
                nodes::Column::LeaseUntil,
                clock_timestamp().add(Expr::val("30 seconds").cast_as(Alias::new("interval"))),
            )
            .and_where(Expr::col(nodes::Column::Id).eq(node)),
    )
    .await?;
    Ok(live)
}

async fn lock_node(tx: &DatabaseTransaction, node: &str) -> Result<bool> {
    one_query(
        tx,
        Query::select()
            .column(nodes::Column::Id)
            .from(nodes::Entity)
            .and_where(Expr::col(nodes::Column::Id).eq(node))
            .lock(LockType::Update),
    )
    .await?;
    // Evaluate after acquiring the lock: waiting can outlive the prior lease.
    Ok(one_query(
        tx,
        Query::select()
            .expr_as(
                Expr::col(nodes::Column::LeaseUntil).gt(clock_timestamp()),
                Alias::new("live"),
            )
            .from(nodes::Entity)
            .and_where(Expr::col(nodes::Column::Id).eq(node)),
    )
    .await?
    .try_get("", "live")?)
}
