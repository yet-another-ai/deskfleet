CREATE TABLE cp_cloud_agent_requests (
    id TEXT PRIMARY KEY,
    team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    session_id TEXT,
    position BIGINT GENERATED ALWAYS AS IDENTITY,
    prewarm_claim_until BIGINT,
    result_id TEXT
);
CREATE INDEX cp_cloud_agent_requests_session ON cp_cloud_agent_requests(session_id, position)
    WHERE session_id IS NOT NULL;
