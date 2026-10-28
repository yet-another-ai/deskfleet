CREATE TABLE cp_realtime_nodes (
 id TEXT PRIMARY KEY,
 lease_until TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '30 seconds')
);
CREATE TABLE cp_realtime_routes (
 machine_id BIGINT PRIMARY KEY REFERENCES cp_machines(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL REFERENCES cp_realtime_nodes(id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL
);
CREATE INDEX cp_realtime_routes_node ON cp_realtime_routes(node_id);
CREATE TABLE cp_realtime_messages (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 node_id TEXT NOT NULL REFERENCES cp_realtime_nodes(id) ON DELETE CASCADE,
 payload JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '120 seconds')
);
CREATE INDEX cp_realtime_messages_node ON cp_realtime_messages(node_id,id);
CREATE INDEX cp_realtime_messages_expiry ON cp_realtime_messages(expires_at);
