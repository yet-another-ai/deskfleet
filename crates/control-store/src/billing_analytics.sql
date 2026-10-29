ALTER TABLE cp_checkout_attempts ADD COLUMN actor_user_id TEXT REFERENCES cp_users(id) ON DELETE SET NULL;
ALTER TABLE cp_payment_events ADD COLUMN occurred_at BIGINT;
ALTER TABLE cp_payment_events ADD COLUMN payment_attempt BIGINT;
CREATE TABLE cp_billing_analytics (
 event_id TEXT PRIMARY KEY,
 team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
 event JSONB NOT NULL,
 available_at BIGINT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 claim_token TEXT, claimed_until BIGINT, sent_at BIGINT
);
CREATE INDEX cp_billing_analytics_pending ON cp_billing_analytics(available_at) WHERE sent_at IS NULL;
