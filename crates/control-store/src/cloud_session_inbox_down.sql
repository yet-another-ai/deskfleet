-- Unfinished reads become runnable again under the previous scheduler.
UPDATE cp_cloud_sessions SET next_check_at = COALESCE(next_check_at, meter_claim_until)
    WHERE meter_claim_until IS NOT NULL;
DROP INDEX cp_cloud_sessions_claim_expiry;
ALTER TABLE cp_cloud_sessions DROP COLUMN meter_claim_until;
DROP INDEX cp_cloud_sessions_team_activity;
ALTER TABLE cp_cloud_sessions DROP COLUMN title;
