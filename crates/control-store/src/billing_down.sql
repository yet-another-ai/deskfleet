DROP TABLE IF EXISTS cp_turn_collector;
ALTER TABLE cp_peers DROP COLUMN IF EXISTS relay_allowed;
DROP TABLE IF EXISTS cp_session_admissions;
DROP TABLE IF EXISTS cp_payment_events;
DROP TABLE IF EXISTS cp_checkout_attempts;
DROP TABLE IF EXISTS cp_billing_profiles;
DELETE FROM cp_migrations WHERE version=4;
