CREATE TABLE cp_cloud_sessions (
    session_id TEXT PRIMARY KEY,
    team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
    next_line BIGINT NOT NULL DEFAULT 0 CHECK (next_line >= 0),
    last_active_at BIGINT NOT NULL DEFAULT 0,
    next_check_at BIGINT
);
CREATE INDEX cp_cloud_sessions_meter_due ON cp_cloud_sessions(next_check_at, session_id)
    WHERE next_check_at IS NOT NULL;
