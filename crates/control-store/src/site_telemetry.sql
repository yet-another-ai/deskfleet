ALTER TABLE cp_site_settings
    ADD COLUMN telemetry_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE cp_user_marketing_attribution (
    user_id TEXT PRIMARY KEY REFERENCES cp_users(id) ON DELETE CASCADE,
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    ga_client_id TEXT,
    consented_at BIGINT NOT NULL
);
