ALTER TABLE cp_checkout_attempts DROP CONSTRAINT IF EXISTS cp_checkout_attempts_billing_interval_check;
ALTER TABLE cp_checkout_attempts DROP COLUMN IF EXISTS billing_interval;
