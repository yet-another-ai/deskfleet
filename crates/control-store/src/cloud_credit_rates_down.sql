DROP TRIGGER cp_charge_cloud_token_usage ON cp_cloud_token_usage;
DROP FUNCTION cp_charge_cloud_token_usage();
ALTER TABLE cp_cloud_token_usage DROP COLUMN charged_credits;
DROP TABLE cp_cloud_credit_rates;
