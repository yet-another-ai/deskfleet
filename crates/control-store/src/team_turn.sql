ALTER TABLE cp_turn_settings ADD COLUMN allow_team_servers BOOLEAN NOT NULL DEFAULT TRUE;
-- A Team's own TURN REST API server. Its shared secret signs short-lived peer
-- credentials and is never returned through the API. A row exists only while
-- the Team has at least one URL; removing the server deletes the secret.
CREATE TABLE cp_team_turn_servers (
 team_id BIGINT PRIMARY KEY REFERENCES cp_teams(id) ON DELETE CASCADE,
 urls JSONB NOT NULL CHECK (jsonb_typeof(urls) = 'array' AND jsonb_array_length(urls) > 0),
 secret TEXT NOT NULL CHECK (secret <> '')
);
