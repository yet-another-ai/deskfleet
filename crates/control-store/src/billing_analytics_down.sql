DROP TABLE cp_billing_analytics;
ALTER TABLE cp_payment_events DROP COLUMN payment_attempt, DROP COLUMN occurred_at;
ALTER TABLE cp_checkout_attempts DROP COLUMN actor_user_id;
