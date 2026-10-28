CREATE TABLE cp_peer_negotiations (
 peer_id TEXT PRIMARY KEY REFERENCES cp_peers(id) ON DELETE CASCADE,
 offer TEXT, options JSONB NOT NULL DEFAULT 'null', answer TEXT,
 pending JSONB NOT NULL DEFAULT '[]', started_at BIGINT,
 failed BOOLEAN NOT NULL DEFAULT FALSE,
 CHECK (jsonb_typeof(pending) = 'array'),
 CHECK (jsonb_array_length(pending) <= 256)
);
