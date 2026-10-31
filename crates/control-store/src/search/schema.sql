CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
LOCK TABLE cp_sessions IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE cp_search_documents (
 machine_id BIGINT NOT NULL REFERENCES cp_machines(id),
 kind TEXT NOT NULL CHECK(kind IN ('chat','schedule')),
 resource_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 block_no BIGINT NOT NULL,
 priority SMALLINT NOT NULL,
 content TEXT NOT NULL,
 PRIMARY KEY(machine_id,kind,resource_id,entry_id,block_no)
);
CREATE INDEX cp_search_content ON cp_search_documents USING GIN(content public.gin_trgm_ops);

-- Only bounded message tails are mutable. Completed blocks never grow.
CREATE TABLE cp_search_entries (
 machine_id BIGINT NOT NULL,
 session_id TEXT NOT NULL,
 entry_key TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 tail TEXT NOT NULL DEFAULT '',
 next_block BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(machine_id,session_id,entry_key),
 FOREIGN KEY(machine_id,session_id) REFERENCES cp_sessions(machine_id,session_id) ON DELETE CASCADE
);
CREATE TABLE cp_search_progress (
 machine_id BIGINT NOT NULL,
 session_id TEXT NOT NULL,
 indexed_seq BIGINT NOT NULL DEFAULT 0,
 stable_seq BIGINT NOT NULL DEFAULT 0,
 snapshot_idle_seq BIGINT NOT NULL DEFAULT 0,
 previous_key TEXT,
 previous_turn TEXT,
 PRIMARY KEY(machine_id,session_id),
 FOREIGN KEY(machine_id,session_id) REFERENCES cp_sessions(machine_id,session_id) ON DELETE CASCADE
);

CREATE TABLE cp_schedule_snapshots (
 machine_id BIGINT PRIMARY KEY REFERENCES cp_machines(id),
 observed_at BIGINT NOT NULL
);
CREATE TABLE cp_schedules (
 machine_id BIGINT NOT NULL REFERENCES cp_machines(id),
 schedule_id TEXT NOT NULL,
 record JSONB NOT NULL,
 PRIMARY KEY(machine_id,schedule_id)
);
