ALTER TABLE cp_peers DROP COLUMN ice_servers;
DELETE FROM cp_site_audit WHERE action = 'turn.settings.update';
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
 action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update', 'account.disable', 'registration.update')
);
DROP TABLE cp_turn_settings;
