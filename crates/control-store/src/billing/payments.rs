use super::{BillingAnalyticsEvent, BillingProfile, Plan, analytics, profile};
use crate::entities::{
    cp_billing_profiles as profiles, cp_checkout_attempts as checkouts,
    cp_payment_events as payments, cp_teams as teams,
};
use crate::{ControlStore, Error, Result, now_ms, one_query, resource_id};
use sea_orm::sea_query::{
    Asterisk, Cond, Expr, ExprTrait, Func, IntoIden, LockBehavior, LockType, OnConflict, Order,
    Query, TableRef,
};
use sea_orm::{ConnectionTrait, DatabaseTransaction, TransactionTrait};

#[derive(Clone, Debug)]
pub struct CheckoutAttempt {
    pub request_id: String,
    pub team_id: String,
    pub plan: String,
    pub billing_interval: String,
    pub session_id: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub actor_user_id: Option<String>,
}
#[derive(Clone, Debug)]
pub struct PaymentEvent {
    pub id: String,
    pub event_type: String,
    pub object_id: String,
    pub claim_token: String,
    pub occurred_at: Option<i64>,
    pub payment_attempt: Option<i64>,
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
        actor_user_id: row.try_get("", "actor_user_id")?,
    })
}
fn parse_interval(interval: &str) -> Result<&str> {
    match interval {
        "month" | "year" => Ok(interval),
        _ => Err(Error::Invalid("interval must be month or year")),
    }
}

async fn lock_billing_operation(tx: &DatabaseTransaction, team: i64, token: &str) -> Result<()> {
    // Match subscription reconciliation: Team, profile, then checkout/outbox.
    one_query(
        tx,
        Query::select()
            .column(teams::Column::Id)
            .from(teams::Entity)
            .and_where(Expr::col(teams::Column::Id).eq(team))
            .lock(LockType::KeyShare),
    )
    .await?;
    let row = one_query(
        tx,
        Query::select()
            .columns([profiles::Column::LeaseToken, profiles::Column::LeaseUntil])
            .from(profiles::Entity)
            .and_where(Expr::col(profiles::Column::TeamId).eq(team))
            .lock(LockType::Update),
    )
    .await?;
    // Check time after waiting, and retain the profile lock through commit so
    // a replacement claim cannot invalidate a checkout's authorization mid-write.
    if row.try_get::<Option<String>>("", "lease_token")?.as_deref() != Some(token)
        || !row
            .try_get::<Option<i64>>("", "lease_until")?
            .is_some_and(|until| until > now_ms())
    {
        return Err(Error::Conflict("checkout operation changed; retry"));
    }
    Ok(())
}

impl ControlStore {
    /// A fencing lease serializes provider I/O without holding a SQL transaction.
    pub async fn claim_billing_operation(&self, team_id: &str) -> Result<Option<String>> {
        self.billing_profile(team_id).await?;
        let token = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let changed = self
            .db
            .execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::LeaseToken, token.clone())
                    .value(profiles::Column::LeaseUntil, now + 180_000)
                    .and_where(Expr::col(profiles::Column::TeamId).eq(resource_id(team_id)?))
                    .cond_where(
                        Cond::any()
                            .add(Expr::col(profiles::Column::LeaseUntil).is_null())
                            .add(Expr::col(profiles::Column::LeaseUntil).lt(now)),
                    ),
            )
            .await?
            .rows_affected()
            == 1;
        Ok(changed.then_some(token))
    }
    pub async fn release_billing_operation(&self, team_id: &str, token: &str) -> Result<()> {
        self.db
            .execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::LeaseToken, Option::<String>::None)
                    .value(profiles::Column::LeaseUntil, Option::<i64>::None)
                    .and_where(Expr::col(profiles::Column::TeamId).eq(resource_id(team_id)?))
                    .and_where(Expr::col(profiles::Column::LeaseToken).eq(token)),
            )
            .await?;
        Ok(())
    }
    pub async fn billing_customer(
        &self,
        team_id: &str,
        token: &str,
        customer_id: &str,
    ) -> Result<()> {
        let changed = self
            .db
            .execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::CustomerId, customer_id)
                    .and_where(Expr::col(profiles::Column::TeamId).eq(resource_id(team_id)?))
                    .and_where(Expr::col(profiles::Column::LeaseToken).eq(token))
                    .and_where(Expr::col(profiles::Column::LeaseUntil).gt(now_ms()))
                    .cond_where(
                        Cond::any()
                            .add(Expr::col(profiles::Column::CustomerId).is_null())
                            .add(Expr::col(profiles::Column::CustomerId).eq(customer_id)),
                    ),
            )
            .await?
            .rows_affected()
            == 1;
        if changed {
            Ok(())
        } else {
            Err(Error::Conflict("billing operation changed; retry"))
        }
    }
    pub async fn billing_profile_by_customer(&self, customer: &str) -> Result<BillingProfile> {
        profile(
            one_query(
                &self.db,
                Query::select()
                    .column(Asterisk)
                    .from(profiles::Entity)
                    .and_where(Expr::col(profiles::Column::CustomerId).eq(customer)),
            )
            .await?,
        )
    }
    /// Claim one due customer without retaining SQL locks during provider I/O.
    pub async fn claim_billing_reconciliation(&self) -> Result<Option<(String, String)>> {
        let token = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let candidate = Query::select()
            .column(profiles::Column::TeamId)
            .from(profiles::Entity)
            .and_where(Expr::col(profiles::Column::CustomerId).is_not_null())
            .and_where(Expr::col(profiles::Column::ReconcileAfter).lte(now))
            .cond_where(
                Cond::any()
                    .add(Expr::col(profiles::Column::LeaseUntil).is_null())
                    .add(Expr::col(profiles::Column::LeaseUntil).lt(now)),
            )
            .order_by(profiles::Column::ReconcileAfter, Order::Asc)
            .order_by(profiles::Column::TeamId, Order::Asc)
            .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
            .limit(1)
            .to_owned();
        let row = self
            .db
            .query_one(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::LeaseToken, token.clone())
                    .value(profiles::Column::LeaseUntil, now + 180_000)
                    .value(profiles::Column::ReconcileAfter, now + 180_000)
                    .from(TableRef::SubQuery(
                        Box::new(candidate),
                        "candidate".into_iden(),
                    ))
                    .and_where(
                        Expr::col((profiles::Entity, profiles::Column::TeamId))
                            .eq(Expr::col(("candidate", profiles::Column::TeamId))),
                    )
                    .returning_col((profiles::Entity, profiles::Column::TeamId)),
            )
            .await?;
        row.map(|row| Ok((row.try_get::<i64>("", "team_id")?.to_string(), token)))
            .transpose()
    }
    pub async fn finish_billing_reconciliation(
        &self,
        team_id: &str,
        token: &str,
        success: bool,
    ) -> Result<()> {
        self.db
            .execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(profiles::Column::LeaseToken, Option::<String>::None)
                    .value(profiles::Column::LeaseUntil, Option::<i64>::None)
                    .value(
                        profiles::Column::ReconcileAfter,
                        now_ms() + if success { 60_000 } else { 300_000 },
                    )
                    .and_where(Expr::col(profiles::Column::TeamId).eq(resource_id(team_id)?))
                    .and_where(Expr::col(profiles::Column::LeaseToken).eq(token)),
            )
            .await?;
        Ok(())
    }
    pub async fn apply_subscription(
        &self,
        team_id: &str,
        token: &str,
        projection: &SubscriptionProjection,
        events: &[BillingAnalyticsEvent],
    ) -> Result<()> {
        if let Some(plan) = projection.paid_plan.as_deref() {
            Plan::paid(plan)?;
        }
        if projection.paid_plan.is_some() != projection.paid_through.is_some() {
            return Err(Error::Invalid("incomplete paid coverage"));
        }
        let tx = self.db.begin().await?;
        // The analytics FK also locks this parent. Acquire it before the profile,
        // matching Enterprise updates rather than reversing their lock order.
        one_query(
            &tx,
            Query::select()
                .column(teams::Column::Id)
                .from(teams::Entity)
                .and_where(Expr::col(teams::Column::Id).eq(resource_id(team_id)?))
                .lock(LockType::KeyShare),
        )
        .await?;
        let now = now_ms();
        let changed = tx
            .execute(
                Query::update()
                    .table(profiles::Entity)
                    .value(
                        profiles::Column::SubscriptionId,
                        projection.subscription_id.clone(),
                    )
                    .value(
                        profiles::Column::SubscriptionStatus,
                        projection.status.clone(),
                    )
                    .value(
                        profiles::Column::Plan,
                        Func::coalesce([
                            Expr::val(projection.paid_plan.clone()),
                            Expr::col(profiles::Column::Plan),
                        ]),
                    )
                    .value(
                        profiles::Column::PaidThrough,
                        if projection.paid_plan.is_none() {
                            Expr::col(profiles::Column::PaidThrough)
                        } else {
                            Expr::val(projection.paid_through)
                        },
                    )
                    .value(
                        profiles::Column::PeriodAnchor,
                        Expr::case(
                            Cond::any()
                                .add(Expr::col(profiles::Column::SubscriptionId).is_null())
                                .add(
                                    Expr::col(profiles::Column::SubscriptionId)
                                        .ne(projection.subscription_id.clone()),
                                ),
                            projection.period_anchor,
                        )
                        .finally(Expr::col(profiles::Column::PeriodAnchor)),
                    )
                    .value(
                        profiles::Column::CancelAtPeriodEnd,
                        projection.cancel_at_period_end,
                    )
                    .value(profiles::Column::ReconciledAt, now)
                    .and_where(Expr::col(profiles::Column::TeamId).eq(resource_id(team_id)?))
                    .and_where(Expr::col(profiles::Column::LeaseToken).eq(token))
                    .and_where(Expr::col(profiles::Column::LeaseUntil).gt(now))
                    .cond_where(
                        Cond::any()
                            .add(Expr::col(profiles::Column::SubscriptionId).is_null())
                            .add(
                                Expr::col(profiles::Column::SubscriptionId)
                                    .eq(projection.subscription_id.clone()),
                            )
                            .add(Expr::col(profiles::Column::PaidThrough).is_null())
                            .add(Expr::col(profiles::Column::PaidThrough).lte(now)),
                    ),
            )
            .await?
            .rows_affected()
            == 1;
        if changed {
            analytics::enqueue(&tx, team_id, events).await?;
            tx.commit().await?;
            Ok(())
        } else {
            Err(Error::Conflict("billing reconciliation superseded"))
        }
    }
    pub async fn checkout_attempt(&self, request_id: &str) -> Result<Option<CheckoutAttempt>> {
        self.db
            .query_one(
                Query::select()
                    .column(Asterisk)
                    .from(checkouts::Entity)
                    .and_where(Expr::col(checkouts::Column::RequestId).eq(request_id)),
            )
            .await?
            .map(checkout)
            .transpose()
    }
    pub async fn open_checkout(&self, team_id: &str) -> Result<Option<CheckoutAttempt>> {
        self.db
            .query_one(
                Query::select()
                    .column(Asterisk)
                    .from(checkouts::Entity)
                    .and_where(Expr::col(checkouts::Column::TeamId).eq(resource_id(team_id)?))
                    .and_where(Expr::col(checkouts::Column::Status).is_in(["pending", "open"])),
            )
            .await?
            .map(checkout)
            .transpose()
    }
    pub async fn create_checkout_attempt(
        &self,
        team_id: &str,
        token: &str,
        request_id: &str,
        plan: &str,
        interval: &str,
        actor_user_id: &str,
    ) -> Result<CheckoutAttempt> {
        Plan::paid(plan)?;
        let interval = parse_interval(interval)?;
        uuid::Uuid::parse_str(request_id)
            .map_err(|_| Error::Invalid("requestId must be a UUID"))?;
        let team = resource_id(team_id)?;
        let tx = self.db.begin().await?;
        lock_billing_operation(&tx, team, token).await?;
        let attempt = checkout(
            one_query(
                &tx,
                Query::insert()
                    .into_table(checkouts::Entity)
                    .columns([
                        checkouts::Column::RequestId,
                        checkouts::Column::TeamId,
                        checkouts::Column::Plan,
                        checkouts::Column::BillingInterval,
                        checkouts::Column::Status,
                        checkouts::Column::CreatedAt,
                        checkouts::Column::ActorUserId,
                    ])
                    .values_panic([
                        request_id.into(),
                        team.into(),
                        plan.into(),
                        interval.into(),
                        "pending".into(),
                        now_ms().into(),
                        actor_user_id.into(),
                    ])
                    .returning_all(),
            )
            .await?,
        )?;
        tx.commit().await?;
        Ok(attempt)
    }
    pub async fn update_checkout_attempt(
        &self,
        team_id: &str,
        token: &str,
        request_id: &str,
        session_id: &str,
        status: &str,
        events: &[BillingAnalyticsEvent],
    ) -> Result<()> {
        if !matches!(status, "open" | "complete" | "expired") {
            return Err(Error::Invalid("invalid checkout state"));
        }
        let tx = self.db.begin().await?;
        let team = resource_id(team_id)?;
        lock_billing_operation(&tx, team, token).await?;
        let changed = tx
            .execute(
                Query::update()
                    .table(checkouts::Entity)
                    .value(checkouts::Column::SessionId, session_id)
                    .value(checkouts::Column::Status, status)
                    .and_where(Expr::col(checkouts::Column::RequestId).eq(request_id))
                    .and_where(Expr::col(checkouts::Column::TeamId).eq(team)),
            )
            .await?
            .rows_affected()
            == 1;
        if changed {
            analytics::enqueue(&tx, team_id, events).await?;
            tx.commit().await?;
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
        let team = resource_id(team_id)?;
        let tx = self.db.begin().await?;
        lock_billing_operation(&tx, team, token).await?;
        tx.execute(
            Query::update()
                .table(checkouts::Entity)
                .value(checkouts::Column::Status, "complete")
                .and_where(Expr::col(checkouts::Column::TeamId).eq(team))
                .and_where(Expr::col(checkouts::Column::RequestId).eq(request_id)),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn receive_payment_event(
        &self,
        id: &str,
        event_type: &str,
        object_id: &str,
        occurred_at: Option<i64>,
        payment_attempt: Option<i64>,
    ) -> Result<()> {
        if id.is_empty() || id.len() > 255 || object_id.is_empty() || object_id.len() > 255 {
            return Err(Error::Invalid("invalid payment event"));
        }
        let now = now_ms();
        self.db
            .execute(
                Query::insert()
                    .into_table(payments::Entity)
                    .columns([
                        payments::Column::Id,
                        payments::Column::EventType,
                        payments::Column::ObjectId,
                        payments::Column::AvailableAt,
                        payments::Column::ReceivedAt,
                        payments::Column::OccurredAt,
                        payments::Column::PaymentAttempt,
                    ])
                    .values_panic([
                        id.into(),
                        event_type.into(),
                        object_id.into(),
                        now.into(),
                        now.into(),
                        occurred_at.into(),
                        payment_attempt.into(),
                    ])
                    .on_conflict(
                        OnConflict::column(payments::Column::Id)
                            .do_nothing()
                            .to_owned(),
                    ),
            )
            .await?;
        Ok(())
    }
    pub async fn claim_payment_event(&self) -> Result<Option<PaymentEvent>> {
        let token = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let candidate = Query::select()
            .column(payments::Column::Id)
            .from(payments::Entity)
            .and_where(Expr::col(payments::Column::Status).ne("processed"))
            .and_where(Expr::col(payments::Column::Attempts).lt(10))
            .and_where(Expr::col(payments::Column::AvailableAt).lte(now))
            .cond_where(
                Cond::any()
                    .add(Expr::col(payments::Column::ClaimedUntil).is_null())
                    .add(Expr::col(payments::Column::ClaimedUntil).lt(now)),
            )
            .order_by(payments::Column::ReceivedAt, Order::Asc)
            .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
            .limit(1)
            .to_owned();
        let row = self
            .db
            .query_one(
                Query::update()
                    .table(payments::Entity)
                    .value(payments::Column::Status, "processing")
                    .value(
                        payments::Column::Attempts,
                        Expr::col(payments::Column::Attempts).add(1),
                    )
                    .value(payments::Column::ClaimToken, token.clone())
                    .value(payments::Column::ClaimedUntil, now + 180_000)
                    .from(TableRef::SubQuery(
                        Box::new(candidate),
                        "candidate".into_iden(),
                    ))
                    .and_where(
                        Expr::col((payments::Entity, payments::Column::Id))
                            .eq(Expr::col(("candidate", payments::Column::Id))),
                    )
                    .returning(
                        Query::returning()
                            .column((payments::Entity, Asterisk))
                            .to_owned(),
                    ),
            )
            .await?;
        row.map(|r| {
            Ok(PaymentEvent {
                id: r.try_get("", "id")?,
                event_type: r.try_get("", "event_type")?,
                object_id: r.try_get("", "object_id")?,
                claim_token: token,
                occurred_at: r.try_get("", "occurred_at")?,
                payment_attempt: r.try_get("", "payment_attempt")?,
            })
        })
        .transpose()
    }
    pub async fn finish_payment_event(&self, event: &PaymentEvent, success: bool) -> Result<()> {
        let delay = Func::least([
            Expr::val(3600),
            Func::cust("power")
                .args([Expr::val(2), Expr::col(payments::Column::Attempts)])
                .cast_as("integer"),
        ])
        .mul(1000);
        self.db
            .execute(
                Query::update()
                    .table(payments::Entity)
                    .value(
                        payments::Column::Status,
                        if success { "processed" } else { "failed" },
                    )
                    .value(payments::Column::ClaimToken, Option::<String>::None)
                    .value(payments::Column::ClaimedUntil, Option::<i64>::None)
                    .value(
                        payments::Column::AvailableAt,
                        Expr::val(now_ms()).add(delay),
                    )
                    .value(
                        payments::Column::ErrorCode,
                        (!success).then_some("reconciliation_failed"),
                    )
                    .and_where(Expr::col(payments::Column::Id).eq(event.id.clone()))
                    .and_where(
                        Expr::col(payments::Column::ClaimToken).eq(event.claim_token.clone()),
                    ),
            )
            .await?;
        Ok(())
    }
}
