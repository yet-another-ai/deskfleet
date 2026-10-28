use super::{BillingProfile, Plan, profile};
use crate::{ControlStore, Error, Result, now_ms, one, resource_id, sql};
use sea_orm::ConnectionTrait;

#[derive(Clone, Debug)]
pub struct CheckoutAttempt {
    pub request_id: String,
    pub team_id: String,
    pub plan: String,
    pub billing_interval: String,
    pub session_id: Option<String>,
    pub status: String,
    pub created_at: i64,
}
#[derive(Clone, Debug)]
pub struct PaymentEvent {
    pub id: String,
    pub event_type: String,
    pub object_id: String,
    pub claim_token: String,
}
pub struct SubscriptionProjection {
    pub subscription_id: String,
    pub status: String,
    pub paid_plan: Option<String>,
    pub paid_through: Option<i64>,
    pub period_anchor: i64,
    pub cancel_at_period_end: bool,
}

fn checkout(row: sea_orm::QueryResult) -> Result<CheckoutAttempt> {
    Ok(CheckoutAttempt {
        request_id: row.try_get("", "request_id")?,
        team_id: row.try_get::<i64>("", "team_id")?.to_string(),
        plan: row.try_get("", "plan")?,
        billing_interval: row.try_get("", "billing_interval")?,
        session_id: row.try_get("", "session_id")?,
        status: row.try_get("", "status")?,
        created_at: row.try_get("", "created_at")?,
    })
}
fn parse_interval(interval: &str) -> Result<&str> {
    match interval {
        "month" | "year" => Ok(interval),
        _ => Err(Error::Invalid("interval must be month or year")),
    }
}

impl ControlStore {
    /// A fencing lease serializes provider I/O without holding a SQL transaction.
    pub async fn claim_billing_operation(&self, team_id: &str) -> Result<Option<String>> {
        self.billing_profile(team_id).await?;
        let token = uuid::Uuid::new_v4().to_string();
        let changed=self.db.execute_raw(sql("UPDATE cp_billing_profiles SET lease_token=$2,lease_until=$3+180000 WHERE team_id=$1 AND (lease_until IS NULL OR lease_until<$3)",vec![resource_id(team_id)?.into(),token.clone().into(),now_ms().into()])).await?.rows_affected()==1;
        Ok(changed.then_some(token))
    }
    pub async fn release_billing_operation(&self, team_id: &str, token: &str) -> Result<()> {
        self.db.execute_raw(sql("UPDATE cp_billing_profiles SET lease_token=NULL,lease_until=NULL WHERE team_id=$1 AND lease_token=$2",vec![resource_id(team_id)?.into(),token.into()])).await?;
        Ok(())
    }
    pub async fn billing_customer(
        &self,
        team_id: &str,
        token: &str,
        customer_id: &str,
    ) -> Result<()> {
        let changed=self.db.execute_raw(sql("UPDATE cp_billing_profiles SET customer_id=$3 WHERE team_id=$1 AND lease_token=$2 AND lease_until>$4 AND (customer_id IS NULL OR customer_id=$3)",vec![resource_id(team_id)?.into(),token.into(),customer_id.into(),now_ms().into()])).await?.rows_affected()==1;
        if changed {
            Ok(())
        } else {
            Err(Error::Conflict("billing operation changed; retry"))
        }
    }
    pub async fn billing_profile_by_customer(&self, customer: &str) -> Result<BillingProfile> {
        profile(
            one(
                &self.db,
                "SELECT * FROM cp_billing_profiles WHERE customer_id=$1",
                vec![customer.into()],
            )
            .await?,
        )
    }
    /// Claim one due customer without retaining SQL locks during provider I/O.
    pub async fn claim_billing_reconciliation(&self) -> Result<Option<(String, String)>> {
        let token = uuid::Uuid::new_v4().to_string();
        let row = self.db.query_one_raw(sql(
            "UPDATE cp_billing_profiles b SET lease_token=$2,lease_until=$1+180000,reconcile_after=$1+180000 FROM (SELECT team_id FROM cp_billing_profiles WHERE customer_id IS NOT NULL AND reconcile_after<=$1 AND (lease_until IS NULL OR lease_until<$1) ORDER BY reconcile_after,team_id FOR UPDATE SKIP LOCKED LIMIT 1) candidate WHERE b.team_id=candidate.team_id RETURNING b.team_id",
            vec![now_ms().into(),token.clone().into()],
        )).await?;
        row.map(|row| Ok((row.try_get::<i64>("", "team_id")?.to_string(), token)))
            .transpose()
    }
    pub async fn finish_billing_reconciliation(
        &self,
        team_id: &str,
        token: &str,
        success: bool,
    ) -> Result<()> {
        self.db.execute_raw(sql(
            "UPDATE cp_billing_profiles SET lease_token=NULL,lease_until=NULL,reconcile_after=$3 WHERE team_id=$1 AND lease_token=$2",
            vec![resource_id(team_id)?.into(),token.into(),(now_ms()+if success {60_000} else {300_000}).into()],
        )).await?;
        Ok(())
    }
    pub async fn apply_subscription(
        &self,
        team_id: &str,
        token: &str,
        projection: &SubscriptionProjection,
    ) -> Result<()> {
        if let Some(plan) = projection.paid_plan.as_deref() {
            Plan::paid(plan)?;
        }
        if projection.paid_plan.is_some() != projection.paid_through.is_some() {
            return Err(Error::Invalid("incomplete paid coverage"));
        }
        let changed=self.db.execute_raw(sql(
            "UPDATE cp_billing_profiles SET subscription_id=$3,subscription_status=$4,plan=COALESCE($5,plan),paid_through=CASE WHEN $5::text IS NULL THEN paid_through ELSE $6 END,period_anchor=CASE WHEN subscription_id IS NULL OR subscription_id<>$3 THEN $7 ELSE period_anchor END,cancel_at_period_end=$8,reconciled_at=$9 WHERE team_id=$1 AND lease_token=$2 AND lease_until>$9 AND (subscription_id IS NULL OR subscription_id=$3 OR paid_through IS NULL OR paid_through<=$9)",
            vec![resource_id(team_id)?.into(),token.into(),projection.subscription_id.clone().into(),projection.status.clone().into(),projection.paid_plan.clone().into(),projection.paid_through.into(),projection.period_anchor.into(),projection.cancel_at_period_end.into(),now_ms().into()]
        )).await?.rows_affected()==1;
        if changed {
            Ok(())
        } else {
            Err(Error::Conflict("billing reconciliation superseded"))
        }
    }
    pub async fn checkout_attempt(&self, request_id: &str) -> Result<Option<CheckoutAttempt>> {
        self.db
            .query_one_raw(sql(
                "SELECT * FROM cp_checkout_attempts WHERE request_id=$1",
                vec![request_id.into()],
            ))
            .await?
            .map(checkout)
            .transpose()
    }
    pub async fn open_checkout(&self, team_id: &str) -> Result<Option<CheckoutAttempt>> {
        self.db.query_one_raw(sql("SELECT * FROM cp_checkout_attempts WHERE team_id=$1 AND status IN ('pending','open')",vec![resource_id(team_id)?.into()])).await?.map(checkout).transpose()
    }
    pub async fn create_checkout_attempt(
        &self,
        team_id: &str,
        token: &str,
        request_id: &str,
        plan: &str,
        interval: &str,
    ) -> Result<CheckoutAttempt> {
        Plan::paid(plan)?;
        let interval = parse_interval(interval)?;
        uuid::Uuid::parse_str(request_id)
            .map_err(|_| Error::Invalid("requestId must be a UUID"))?;
        one(&self.db,"INSERT INTO cp_checkout_attempts(request_id,team_id,plan,billing_interval,status,created_at) SELECT $3,team_id,$4,$5,'pending',$6 FROM cp_billing_profiles WHERE team_id=$1 AND lease_token=$2 AND lease_until>$6 RETURNING *",vec![resource_id(team_id)?.into(),token.into(),request_id.into(),plan.into(),interval.into(),now_ms().into()]).await.and_then(checkout)
    }
    pub async fn update_checkout_attempt(
        &self,
        team_id: &str,
        token: &str,
        request_id: &str,
        session_id: &str,
        status: &str,
    ) -> Result<()> {
        if !matches!(status, "open" | "complete" | "expired") {
            return Err(Error::Invalid("invalid checkout state"));
        }
        let changed=self.db.execute_raw(sql("UPDATE cp_checkout_attempts a SET session_id=$4,status=$5 FROM cp_billing_profiles b WHERE a.request_id=$3 AND a.team_id=$1 AND b.team_id=a.team_id AND b.lease_token=$2 AND b.lease_until>$6",vec![resource_id(team_id)?.into(),token.into(),request_id.into(),session_id.into(),status.into(),now_ms().into()])).await?.rows_affected()==1;
        if changed {
            Ok(())
        } else {
            Err(Error::Conflict("checkout operation changed; retry"))
        }
    }
    pub async fn complete_checkout_request(
        &self,
        team_id: &str,
        token: &str,
        request_id: &str,
    ) -> Result<()> {
        self.db.execute_raw(sql("UPDATE cp_checkout_attempts a SET status='complete' FROM cp_billing_profiles b WHERE a.team_id=$1 AND a.request_id=$3 AND b.team_id=a.team_id AND b.lease_token=$2 AND b.lease_until>$4",vec![resource_id(team_id)?.into(),token.into(),request_id.into(),now_ms().into()])).await?;
        Ok(())
    }
    pub async fn receive_payment_event(
        &self,
        id: &str,
        event_type: &str,
        object_id: &str,
    ) -> Result<()> {
        if id.is_empty() || id.len() > 255 || object_id.is_empty() || object_id.len() > 255 {
            return Err(Error::Invalid("invalid payment event"));
        }
        self.db.execute_raw(sql("INSERT INTO cp_payment_events(id,event_type,object_id,available_at,received_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(id) DO NOTHING",vec![id.into(),event_type.into(),object_id.into(),now_ms().into()])).await?;
        Ok(())
    }
    pub async fn claim_payment_event(&self) -> Result<Option<PaymentEvent>> {
        let token = uuid::Uuid::new_v4().to_string();
        let row=self.db.query_one_raw(sql("UPDATE cp_payment_events e SET status='processing',attempts=attempts+1,claim_token=$2,claimed_until=$1+180000 FROM (SELECT id FROM cp_payment_events WHERE status<>'processed' AND attempts<10 AND available_at<=$1 AND (claimed_until IS NULL OR claimed_until<$1) ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1) candidate WHERE e.id=candidate.id RETURNING e.*",vec![now_ms().into(),token.clone().into()])).await?;
        row.map(|r| {
            Ok(PaymentEvent {
                id: r.try_get("", "id")?,
                event_type: r.try_get("", "event_type")?,
                object_id: r.try_get("", "object_id")?,
                claim_token: token,
            })
        })
        .transpose()
    }
    pub async fn finish_payment_event(&self, event: &PaymentEvent, success: bool) -> Result<()> {
        self.db.execute_raw(sql("UPDATE cp_payment_events SET status=$3,claim_token=NULL,claimed_until=NULL,available_at=$4+(LEAST(3600,power(2,attempts)::integer)*1000),error_code=$5 WHERE id=$1 AND claim_token=$2",vec![event.id.clone().into(),event.claim_token.clone().into(),(if success {"processed"}else{"failed"}).into(),now_ms().into(),(!success).then_some("reconciliation_failed").into()])).await?;
        Ok(())
    }
}
