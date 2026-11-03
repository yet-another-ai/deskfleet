CREATE TABLE cp_cloudflare_turn_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 account_id TEXT NOT NULL DEFAULT '', key_id TEXT NOT NULL DEFAULT '',
 api_token TEXT NOT NULL DEFAULT '', analytics_token TEXT NOT NULL DEFAULT ''
);
INSERT INTO cp_cloudflare_turn_settings(singleton) VALUES(TRUE);
CREATE TABLE cp_cloudflare_turn_sources (
 identifier TEXT PRIMARY KEY,
 team_id BIGINT NOT NULL REFERENCES cp_teams(id),
 account_id TEXT NOT NULL, key_id TEXT NOT NULL, analytics_token TEXT NOT NULL,
 expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
 UNIQUE(team_id,account_id,key_id)
);
CREATE TABLE cp_cloudflare_turn_usage (
 identifier TEXT NOT NULL REFERENCES cp_cloudflare_turn_sources(identifier),
 period_start BIGINT NOT NULL, period_end BIGINT NOT NULL CHECK(period_end > period_start),
 expires_at BIGINT NOT NULL,
 egress_bytes BIGINT NOT NULL DEFAULT 0 CHECK(egress_bytes >= 0),
 query_end BIGINT, collected_at BIGINT, last_attempt_at BIGINT,
 PRIMARY KEY(identifier,period_start,period_end)
);
CREATE TABLE cp_cloudflare_turn_collector (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 owner TEXT, lease_until BIGINT, last_seen_at BIGINT, gap_since BIGINT
);
INSERT INTO cp_cloudflare_turn_collector(singleton) VALUES(TRUE);
ALTER FUNCTION cp_turn_sent_bytes(BIGINT,BIGINT,BIGINT) RENAME TO cp_coturn_sent_bytes;
CREATE FUNCTION cp_turn_sent_bytes(usage_team BIGINT, period_start BIGINT, period_end BIGINT)
 RETURNS NUMERIC LANGUAGE sql STABLE AS $$
 SELECT cp_coturn_sent_bytes(usage_team,period_start,period_end) +
 COALESCE((SELECT SUM(u.egress_bytes) FROM cp_cloudflare_turn_usage u
 JOIN cp_cloudflare_turn_sources s USING(identifier)
 WHERE s.team_id=usage_team AND u.period_start=$2 AND u.period_end=$3),0)
$$;
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
 action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update', 'account.disable', 'registration.update', 'turn.settings.update', 'cloudflare.turn.settings.update')
);
