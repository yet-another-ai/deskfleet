DROP TRIGGER cp_turn_usage_minute_insert ON cp_turn_usage;
DROP FUNCTION cp_record_turn_usage_minute();
DROP FUNCTION cp_turn_sent_bytes(BIGINT, BIGINT, BIGINT);
DROP TABLE cp_turn_usage_minutes;
DROP INDEX cp_billing_reconcile_due;
ALTER TABLE cp_billing_profiles DROP COLUMN reconcile_after;
DROP INDEX cp_admissions_machine;
DROP INDEX cp_payment_claimable;
CREATE INDEX cp_payment_pending ON cp_payment_events(available_at) WHERE status <> 'processed';
