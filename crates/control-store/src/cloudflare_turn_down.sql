DROP FUNCTION cp_turn_sent_bytes(BIGINT,BIGINT,BIGINT);
ALTER FUNCTION cp_coturn_sent_bytes(BIGINT,BIGINT,BIGINT) RENAME TO cp_turn_sent_bytes;
DROP TABLE cp_cloudflare_turn_usage;
DROP TABLE cp_cloudflare_turn_sources;
DROP TABLE cp_cloudflare_turn_collector;
DROP TABLE cp_cloudflare_turn_settings;
DELETE FROM cp_site_audit WHERE action='cloudflare.turn.settings.update';
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
 action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update', 'account.disable', 'registration.update', 'turn.settings.update')
);
