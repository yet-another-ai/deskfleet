DROP TABLE cp_plan_limits;
DELETE FROM cp_site_audit WHERE action = 'plan.limits.update';
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
    action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update',
        'account.create', 'account.disable', 'account.delete', 'account.deletion.reject',
        'registration.update', 'turn.settings.update', 'cloudflare.turn.settings.update')
);
