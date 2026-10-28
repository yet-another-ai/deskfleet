//! Leased API socket ownership and short-lived cross-process delivery.
use crate::{ControlStore, Error, Result, one, resource_id, sql};
use sea_orm::{ConnectionTrait, DatabaseTransaction, QueryResult, TransactionTrait};
use serde_json::Value;

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
    /// Register an API process using its newly generated UUID.
    pub async fn register_node(&self, node: &str) -> Result<()> {
        uuid::Uuid::parse_str(node)
            .map_err(|_| Error::Invalid("invalid realtime node identity"))?;
        let tx = self.db.begin().await?;
        tx.execute_raw(sql(
            "INSERT INTO cp_realtime_nodes(id) VALUES($1) ON CONFLICT(id) DO NOTHING",
            vec![node.into()],
        ))
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
            .execute_raw(sql(
                "DELETE FROM cp_realtime_nodes WHERE id=$1",
                vec![node.into()],
            ))
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
        one(
            &tx,
            "SELECT id FROM cp_machines WHERE id=$1 AND NOT revoked FOR UPDATE",
            vec![machine.into()],
        )
        .await?;
        if !lock_node(&tx, node).await? {
            return Err(Error::NotFound);
        }
        let previous = tx
            .query_one_raw(sql(
                "SELECT node_id,connection_id FROM cp_realtime_routes WHERE machine_id=$1",
                vec![machine.into()],
            ))
            .await?
            .map(RealtimeRoute::from_row)
            .transpose()?;
        tx.execute_raw(sql(
            "INSERT INTO cp_realtime_routes(machine_id,node_id,connection_id) VALUES($1,$2,$3) ON CONFLICT(machine_id) DO UPDATE SET node_id=EXCLUDED.node_id,connection_id=EXCLUDED.connection_id",
            vec![machine.into(), node.into(), connection.into()],
        )).await?;
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
        Ok(self.db.execute_raw(sql(
            "DELETE FROM cp_realtime_routes WHERE machine_id=$1 AND node_id=$2 AND connection_id=$3",
            vec![resource_id(machine)?.into(), node.into(), connection.into()],
        )).await?.rows_affected() == 1)
    }

    /// Expired nodes and revoked machines are never advertised as online.
    pub async fn machine_route(&self, machine: &str) -> Result<Option<RealtimeRoute>> {
        self.db.query_one_raw(sql(
            "SELECT r.node_id,r.connection_id FROM cp_realtime_routes r JOIN cp_realtime_nodes n ON n.id=r.node_id JOIN cp_machines m ON m.id=r.machine_id WHERE r.machine_id=$1 AND n.lease_until>clock_timestamp() AND NOT m.revoked",
            vec![resource_id(machine)?.into()],
        )).await?.map(RealtimeRoute::from_row).transpose()
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
        Ok(self.db.execute_raw(sql(
            "INSERT INTO cp_realtime_messages(node_id,payload) SELECT id,$2 FROM cp_realtime_nodes WHERE id=$1 AND lease_until>clock_timestamp() FOR KEY SHARE",
            vec![target.into(), payload.clone().into()],
        )).await?.rows_affected() == 1)
    }

    /// Each live process receives its own copy; the caller handles local delivery.
    pub async fn broadcast_nodes(&self, exclude_node: &str, payload: &Value) -> Result<()> {
        self.db.execute_raw(sql(
            "INSERT INTO cp_realtime_messages(node_id,payload) SELECT id,$2 FROM cp_realtime_nodes WHERE id<>$1 AND lease_until>clock_timestamp() FOR KEY SHARE",
            vec![exclude_node.into(), payload.clone().into()],
        )).await?;
        Ok(())
    }

    /// Consume committed messages without an ID cursor: a lower ID can commit
    /// after a later ID has already been delivered. Consumption is at-most-once.
    pub async fn take_node_messages(&self, node: &str, limit: u32) -> Result<Vec<Value>> {
        self.db.query_all_raw(sql(
            "WITH consumed AS (DELETE FROM cp_realtime_messages WHERE id IN (SELECT m.id FROM cp_realtime_messages m JOIN cp_realtime_nodes n ON n.id=m.node_id WHERE m.node_id=$1 AND n.lease_until>clock_timestamp() AND m.expires_at>clock_timestamp() ORDER BY m.id LIMIT $2 FOR UPDATE OF m SKIP LOCKED) RETURNING id,payload) SELECT payload FROM consumed ORDER BY id",
            vec![node.into(), i64::from(limit).into()],
        )).await?.into_iter().map(|row| row.try_get("", "payload").map_err(Error::from)).collect()
    }

    /// Expired process rows cascade to routes and messages; TTL also bounds
    /// queued messages for a live process whose consumer has stopped advancing.
    pub async fn prune_realtime(&self) -> Result<()> {
        let tx = self.db.begin().await?;
        tx.execute_unprepared("DELETE FROM cp_realtime_nodes WHERE lease_until<=clock_timestamp()")
            .await?;
        tx.execute_unprepared(
            "DELETE FROM cp_realtime_messages WHERE expires_at<=clock_timestamp()",
        )
        .await?;
        tx.execute_unprepared(
            "DELETE FROM cp_peer_negotiations n USING cp_peers p WHERE n.peer_id=p.id AND (p.revoked OR p.expires_at<=(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)",
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn renew_node(tx: &DatabaseTransaction, node: &str) -> Result<bool> {
    let live = lock_node(tx, node).await?;
    if !live {
        tx.execute_raw(sql(
            "DELETE FROM cp_realtime_routes WHERE node_id=$1",
            vec![node.into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "DELETE FROM cp_realtime_messages WHERE node_id=$1",
            vec![node.into()],
        ))
        .await?;
    }
    tx.execute_raw(sql(
        "UPDATE cp_realtime_nodes SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1",
        vec![node.into()],
    )).await?;
    Ok(live)
}

async fn lock_node(tx: &DatabaseTransaction, node: &str) -> Result<bool> {
    one(
        tx,
        "SELECT id FROM cp_realtime_nodes WHERE id=$1 FOR UPDATE",
        vec![node.into()],
    )
    .await?;
    // Evaluate after acquiring the lock: waiting can outlive the prior lease.
    Ok(one(
        tx,
        "SELECT lease_until>clock_timestamp() AS live FROM cp_realtime_nodes WHERE id=$1",
        vec![node.into()],
    )
    .await?
    .try_get("", "live")?)
}
