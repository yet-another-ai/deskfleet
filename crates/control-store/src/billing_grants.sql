ALTER TABLE cp_billing_profiles ADD COLUMN grant_plan TEXT CHECK (grant_plan IN ('free', 'go', 'pro', 'enterprise'));
ALTER TABLE cp_billing_profiles ADD COLUMN grant_expires_at BIGINT;
UPDATE cp_billing_profiles SET grant_plan = 'enterprise' WHERE enterprise;
