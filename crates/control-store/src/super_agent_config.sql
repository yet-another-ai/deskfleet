CREATE TABLE cp_team_super_agent (
    team_id BIGINT PRIMARY KEY REFERENCES cp_teams(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'hosted' CHECK (mode IN ('hosted', 'byoa')),
    registration_id BIGINT REFERENCES cp_machine_registrations(id) ON DELETE SET NULL,
    provider_id TEXT CHECK (provider_id IS NULL OR provider_id <> ''),
    provider_name TEXT,
    cwd TEXT CHECK (cwd IS NULL OR cwd <> ''),
    yolo BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE cp_super_agent_machine_sessions (
    team_id BIGINT NOT NULL REFERENCES cp_teams(id) ON DELETE CASCADE,
    registration_id BIGINT NOT NULL REFERENCES cp_machine_registrations(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL CHECK (session_id <> ''),
    provider_id TEXT NOT NULL CHECK (provider_id <> ''),
    provider_name TEXT,
    title TEXT,
    last_active_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (registration_id, session_id)
);

CREATE INDEX cp_super_agent_machine_sessions_team_active
    ON cp_super_agent_machine_sessions(team_id, last_active_at DESC, session_id);
