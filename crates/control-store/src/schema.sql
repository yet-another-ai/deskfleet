CREATE TABLE cp_users (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
 name TEXT NOT NULL, email TEXT, email_verified BOOLEAN NOT NULL,
 UNIQUE (issuer, subject)
);
CREATE TABLE cp_login_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES cp_users(id),
 device_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 expires_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE cp_login_attempts (
 state_hash TEXT PRIMARY KEY, record JSONB NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE cp_login_codes (
 code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES cp_users(id), verifier_hash TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE cp_teams (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE cp_members (
 team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES cp_users(id),
 role TEXT NOT NULL CHECK (role IN ('admin','member')), PRIMARY KEY (team_id,user_id)
);
CREATE TABLE cp_invites (
 token_hash TEXT PRIMARY KEY, team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
 email TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','member')), expires_at BIGINT NOT NULL
);
CREATE TABLE cp_machines (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 team_id BIGINT NOT NULL REFERENCES cp_teams(id), owner_id TEXT NOT NULL REFERENCES cp_users(id),
 name TEXT NOT NULL, origin_id TEXT NOT NULL UNIQUE, local_machine_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, capabilities JSONB NOT NULL, last_seen_at BIGINT,
 revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE cp_catalogs (
 machine_id BIGINT PRIMARY KEY REFERENCES cp_machines(id), snapshot JSONB NOT NULL, providers JSONB NOT NULL, observed_at BIGINT NOT NULL
);
CREATE TABLE cp_sessions (
 machine_id BIGINT NOT NULL REFERENCES cp_machines(id), session_id TEXT NOT NULL,
 snapshot JSONB NOT NULL, snapshot_seq BIGINT NOT NULL DEFAULT 0,
 event_seq BIGINT NOT NULL DEFAULT 0, observed_at BIGINT NOT NULL,
 PRIMARY KEY(machine_id,session_id)
);
CREATE TABLE cp_events (
 machine_id BIGINT NOT NULL, session_id TEXT NOT NULL, seq BIGINT NOT NULL CHECK(seq > 0),
 record JSONB NOT NULL, PRIMARY KEY(machine_id,session_id,seq),
 FOREIGN KEY(machine_id,session_id) REFERENCES cp_sessions(machine_id,session_id)
);
CREATE TABLE cp_commands (
 machine_id BIGINT NOT NULL REFERENCES cp_machines(id), command_id TEXT NOT NULL, record JSONB NOT NULL,
 PRIMARY KEY(machine_id,command_id)
);
CREATE TABLE cp_peers (
 id TEXT PRIMARY KEY, machine_id BIGINT NOT NULL REFERENCES cp_machines(id),
 team_id BIGINT NOT NULL REFERENCES cp_teams(id), user_id TEXT NOT NULL REFERENCES cp_users(id),
 login_session_id TEXT NOT NULL REFERENCES cp_login_sessions(id),
 grant_json JSONB NOT NULL, expires_at BIGINT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX cp_peers_login ON cp_peers(login_session_id) WHERE NOT revoked;
CREATE INDEX cp_peers_machine ON cp_peers(machine_id) WHERE NOT revoked;
