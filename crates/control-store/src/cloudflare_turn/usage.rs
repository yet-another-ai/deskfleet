use super::CloudflareTurnConfig;
use crate::{ControlStore, Error, Result, billing::period_at, now_ms, one, resource_id, sql};
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::json;

/// One aggregate query for a Team, TURN key, and billing period. Credentials stay internal.
pub struct CloudflareTurnUsageQuery {
    pub identifier: String,
    pub team_id: String,
    pub account_id: String,
    pub key_id: String,
    pub analytics_token: String,
    pub period_start: i64,
    pub period_end: i64,
    pub query_end: i64,
    pub expires_at: i64,
}

impl ControlStore {
    /// Retain the identifier across credentials and replicas; retain analytics access
    /// through the final backfill even when the administrator disables or rotates TURN.
    pub async fn prepare_cloudflare_turn_usage(
        &self,
        team_id: &str,
        config: &CloudflareTurnConfig,
        expires_at: i64,
    ) -> Result<String> {
        let now = now_ms();
        if !config.enabled || config.analytics_token.is_empty() || expires_at <= now {
            return Err(Error::Invalid("invalid Cloudflare TURN usage registration"));
        }
        let profile = self.billing_profile(team_id).await?;
        let tx = self.db.begin().await?;
        let identifier: String = one(&tx,
            "INSERT INTO cp_cloudflare_turn_sources(identifier,team_id,account_id,key_id,analytics_token,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(team_id,account_id,key_id) DO UPDATE SET analytics_token=EXCLUDED.analytics_token,created_at=CASE WHEN cp_cloudflare_turn_sources.expires_at<$7 AND NOT EXISTS(SELECT 1 FROM cp_cloudflare_turn_usage u WHERE u.identifier=cp_cloudflare_turn_sources.identifier AND u.period_start<=$7 AND u.period_end>$7 AND (u.collected_at IS NULL OR u.collected_at<u.expires_at+300000 OR u.query_end<u.expires_at)) THEN $7 ELSE cp_cloudflare_turn_sources.created_at END,expires_at=GREATEST(cp_cloudflare_turn_sources.expires_at,EXCLUDED.expires_at) RETURNING identifier",
            vec![uuid::Uuid::new_v4().simple().to_string().into(),resource_id(team_id)?.into(),config.account_id.as_str().into(),config.key_id.as_str().into(),config.analytics_token.as_str().into(),expires_at.into(),now.into()],
        ).await?.try_get("", "identifier")?;
        let mut start = period_at(profile.period_anchor, now).0;
        while start < expires_at {
            let (_, end) = period_at(profile.period_anchor, start);
            tx.execute_raw(sql("INSERT INTO cp_cloudflare_turn_usage(identifier,period_start,period_end,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(identifier,period_start,period_end) DO UPDATE SET expires_at=GREATEST(cp_cloudflare_turn_usage.expires_at,EXCLUDED.expires_at)",vec![identifier.as_str().into(),start.into(),end.into(),expires_at.min(end).into()])).await?;
            start = end;
        }
        tx.commit().await?;
        Ok(identifier)
    }

    /// Poll complete aggregates, never sum sampled minute buckets. A period gets a
    /// final refresh after five minutes, and updates replace its previous snapshot.
    pub async fn cloudflare_turn_usage_queries(
        &self,
        now: i64,
        limit: usize,
    ) -> Result<Vec<CloudflareTurnUsageQuery>> {
        // A replacement subscription can move the billing anchor without issuing
        // another credential. Retain analytics access for the maximum monthly
        // lookback so even a previously finalized source can be queried again.
        self.db.execute_raw(sql("UPDATE cp_cloudflare_turn_sources SET analytics_token='' WHERE expires_at<$1-2764800000 AND analytics_token<>''",vec![now.into()])).await?;
        let mut periods = Vec::new();
        for row in self.db.query_all_raw(sql("SELECT s.identifier,s.expires_at,b.period_anchor FROM cp_cloudflare_turn_sources s JOIN cp_billing_profiles b ON b.team_id=s.team_id WHERE s.analytics_token<>''",vec![])).await? {
            let (start,end) = period_at(row.try_get("","period_anchor")?,now);
            let expires: i64 = row.try_get("","expires_at")?;
            if expires>start {
                periods.push(json!({"identifier":row.try_get::<String>("","identifier")?,"period_start":start,"period_end":end,"expires_at":expires.min(end)}));
            }
        }
        if !periods.is_empty() {
            self.db.execute_raw(sql("INSERT INTO cp_cloudflare_turn_usage(identifier,period_start,period_end,expires_at) SELECT identifier,period_start,period_end,expires_at FROM jsonb_to_recordset($1) AS p(identifier text,period_start bigint,period_end bigint,expires_at bigint) ON CONFLICT DO NOTHING",vec![json!(periods).into()])).await?;
        }
        self.db.query_all_raw(sql(
            "SELECT s.*,u.period_start,u.period_end,u.expires_at AS window_expires_at,LEAST($1,u.expires_at) AS query_end FROM cp_cloudflare_turn_usage u JOIN cp_cloudflare_turn_sources s USING(identifier) WHERE s.analytics_token<>'' AND u.period_start<$1 AND (u.last_attempt_at IS NULL OR u.last_attempt_at<=$1-60000) AND (u.collected_at IS NULL OR u.collected_at<u.expires_at+300000 OR u.query_end<u.expires_at) ORDER BY u.last_attempt_at NULLS FIRST,u.period_start,s.identifier LIMIT $2",
            vec![now.into(),(limit.clamp(1,1000) as i64).into()],
        )).await?.into_iter().map(|row| Ok(CloudflareTurnUsageQuery {
            identifier: row.try_get("", "identifier")?,
            team_id: row.try_get::<i64>("", "team_id")?.to_string(),
            account_id: row.try_get("", "account_id")?,
            key_id: row.try_get("", "key_id")?,
            analytics_token: row.try_get("", "analytics_token")?,
            period_start: row.try_get("", "period_start")?,
            period_end: row.try_get("", "period_end")?,
            query_end: row.try_get("", "query_end")?,
            expires_at: row.try_get("", "window_expires_at")?,
        })).collect()
    }

    /// Lease fencing prevents a stale replica overwriting a newer aggregate.
    pub async fn save_cloudflare_turn_usage(
        &self,
        query: &CloudflareTurnUsageQuery,
        egress_bytes: i64,
        owner: &str,
    ) -> Result<bool> {
        if egress_bytes < 0
            || query.query_end < query.period_start
            || query.query_end > query.period_end
        {
            return Err(Error::Invalid("invalid Cloudflare TURN usage snapshot"));
        }
        let now = now_ms();
        let tx = self.db.begin().await?;
        let changed = tx.execute_raw(sql(
            "UPDATE cp_cloudflare_turn_usage SET egress_bytes=$4,query_end=$5,collected_at=$6,last_attempt_at=$6 WHERE identifier=$1 AND period_start=$2 AND period_end=$3 AND EXISTS(SELECT 1 FROM cp_cloudflare_turn_collector WHERE singleton AND owner=$7 AND lease_until>$6)",
            vec![query.identifier.as_str().into(),query.period_start.into(),query.period_end.into(),egress_bytes.into(),query.query_end.into(),now.into(),owner.into()],
        )).await?.rows_affected()==1;
        tx.commit().await?;
        Ok(changed)
    }

    /// A failed source gets its own retry delay without starving other Teams or
    /// making its last successful usage snapshot appear fresh.
    pub async fn fail_cloudflare_turn_usage(
        &self,
        query: &CloudflareTurnUsageQuery,
        owner: &str,
    ) -> Result<bool> {
        let now = now_ms();
        Ok(self.db.execute_raw(sql("UPDATE cp_cloudflare_turn_usage SET last_attempt_at=$4 WHERE identifier=$1 AND period_start=$2 AND period_end=$3 AND EXISTS(SELECT 1 FROM cp_cloudflare_turn_collector WHERE singleton AND owner=$5 AND lease_until>$4)",vec![query.identifier.as_str().into(),query.period_start.into(),query.period_end.into(),now.into(),owner.into()])).await?.rows_affected()==1)
    }

    pub async fn claim_cloudflare_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self.db.execute_raw(sql("UPDATE cp_cloudflare_turn_collector SET owner=$1,lease_until=$2+45000 WHERE singleton AND (owner=$1 OR lease_until IS NULL OR lease_until<$2)",vec![owner.into(),now.into()])).await?.rows_affected()==1)
    }

    /// Call after a successful analytics request, including a verified empty result.
    pub async fn heartbeat_cloudflare_turn_collector(&self, owner: &str) -> Result<bool> {
        let now = now_ms();
        Ok(self.db.execute_raw(sql("UPDATE cp_cloudflare_turn_collector SET lease_until=$2+45000,last_seen_at=$2 WHERE singleton AND owner=$1 AND lease_until>$2",vec![owner.into(),now.into()])).await?.rows_affected()==1)
    }

    pub async fn cloudflare_turn_collector_gap(&self, owner: &str) -> Result<()> {
        self.db.execute_raw(sql("UPDATE cp_cloudflare_turn_collector SET gap_since=COALESCE(gap_since,$2),lease_until=$2 WHERE singleton AND owner=$1",vec![owner.into(),now_ms().into()])).await?;
        Ok(())
    }
}
