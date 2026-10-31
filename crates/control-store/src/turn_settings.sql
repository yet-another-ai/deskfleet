CREATE TABLE cp_turn_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
 urls JSONB NOT NULL CHECK (jsonb_typeof(urls) = 'array')
);
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
 action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update', 'account.disable', 'registration.update', 'turn.settings.update')
);
-- NULL identifies grants issued before this snapshot existed, including grants
-- created by older API instances during a rolling deployment. [] is an issued
-- snapshot with no ICE servers and must never trigger legacy reconstruction.
ALTER TABLE cp_peers ADD COLUMN ice_servers JSONB;
