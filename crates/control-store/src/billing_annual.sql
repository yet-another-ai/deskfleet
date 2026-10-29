ALTER TABLE cp_checkout_attempts
 ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'month';
DO $$
BEGIN
 ALTER TABLE cp_checkout_attempts
  ADD CONSTRAINT cp_checkout_attempts_billing_interval_check
  CHECK (billing_interval IN ('month', 'year'));
EXCEPTION
 WHEN duplicate_object THEN NULL;
END $$;
