CREATE TABLE cp_github_app_authorizations (
    user_id TEXT PRIMARY KEY REFERENCES cp_users(id),
    client_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    login TEXT NOT NULL,
    access_token TEXT NOT NULL,
    expires_at BIGINT,
    refresh_token TEXT,
    refresh_expires_at BIGINT,
    act_as_you BOOLEAN NOT NULL DEFAULT FALSE
);
