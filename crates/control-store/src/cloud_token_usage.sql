CREATE TABLE cp_cloud_token_usage (
    team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    line BIGINT NOT NULL CHECK (line >= 0),
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurred_at BIGINT NOT NULL,
    model TEXT,
    input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
    cached_read_tokens BIGINT CHECK (cached_read_tokens >= 0),
    cached_write_tokens BIGINT CHECK (cached_write_tokens >= 0),
    PRIMARY KEY (team_id, session_id, line, event_index)
);
CREATE INDEX cp_cloud_token_usage_period ON cp_cloud_token_usage (team_id, occurred_at);
