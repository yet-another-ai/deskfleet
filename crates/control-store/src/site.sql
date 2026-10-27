CREATE TABLE cp_site_admins (
 user_id TEXT PRIMARY KEY REFERENCES cp_users(id),
 granted_at BIGINT NOT NULL,
 granted_by TEXT REFERENCES cp_users(id),
 source TEXT NOT NULL CHECK (source = 'cli')
);
CREATE TABLE cp_site_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
 site_name TEXT NOT NULL CHECK (octet_length(site_name) BETWEEN 1 AND 200),
 announcement TEXT NOT NULL CHECK (octet_length(announcement) <= 10000),
 allow_team_creation BOOLEAN NOT NULL
);
INSERT INTO cp_site_settings(singleton, site_name, announcement, allow_team_creation)
VALUES (TRUE, 'deskfleet', '', TRUE);
CREATE TABLE cp_site_audit (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_user_id TEXT REFERENCES cp_users(id),
 source TEXT NOT NULL CHECK (source IN ('cli', 'user')),
 action TEXT NOT NULL CHECK (action IN ('admin.grant', 'admin.revoke', 'settings.update')),
 target_user_id TEXT REFERENCES cp_users(id),
 before_value JSONB NOT NULL,
 after_value JSONB NOT NULL,
 occurred_at BIGINT NOT NULL
);
