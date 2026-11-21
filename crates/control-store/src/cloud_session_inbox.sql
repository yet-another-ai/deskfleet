ALTER TABLE cp_cloud_sessions ADD COLUMN title TEXT;
ALTER TABLE cp_cloud_sessions ADD COLUMN meter_claim_until BIGINT;
CREATE INDEX cp_cloud_sessions_claim_expiry ON cp_cloud_sessions(meter_claim_until)
    WHERE meter_claim_until IS NOT NULL;
CREATE INDEX cp_cloud_sessions_team_activity ON cp_cloud_sessions(team_id, last_active_at DESC, session_id);
