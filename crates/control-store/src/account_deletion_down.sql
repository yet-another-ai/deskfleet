DELETE FROM cp_site_audit WHERE action IN ('account.delete', 'account.deletion.reject');
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
 action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update',
   'account.disable', 'registration.update', 'turn.settings.update',
   'cloudflare.turn.settings.update')
);
DROP INDEX cp_account_deletion_requests_review;
DROP INDEX cp_account_deletion_requests_pending;
DROP TABLE cp_account_deletion_requests;
ALTER TABLE cp_users DROP COLUMN deleted_at;
