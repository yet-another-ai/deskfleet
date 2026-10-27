CREATE TABLE cp_turn_usage (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 peer_id TEXT NOT NULL REFERENCES cp_peers(id),
 team_id BIGINT NOT NULL REFERENCES cp_teams(id),
 realm TEXT NOT NULL,
 allocation_id TEXT NOT NULL,
 side TEXT NOT NULL CHECK (side IN ('client', 'peer')),
 received_bytes BIGINT NOT NULL CHECK (received_bytes >= 0),
 sent_bytes BIGINT NOT NULL CHECK (sent_bytes >= 0),
 collected_at BIGINT NOT NULL CHECK (collected_at >= 0)
);
CREATE INDEX cp_turn_usage_team ON cp_turn_usage(team_id, collected_at);
