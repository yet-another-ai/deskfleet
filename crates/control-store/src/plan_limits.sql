CREATE TABLE cp_plan_limits (
    plan TEXT PRIMARY KEY CHECK (plan IN ('free', 'go', 'pro', 'enterprise', 'selfHosted')),
    -- Finite allowances are also sent to clients as JSON numbers.
    max_active_sessions BIGINT CHECK (max_active_sessions BETWEEN 0 AND 9007199254740991),
    max_turns_per_session BIGINT CHECK (max_turns_per_session BETWEEN 0 AND 9007199254740991),
    max_members BIGINT CHECK (max_members BETWEEN 0 AND 9007199254740991),
    turn_bytes BIGINT CHECK (turn_bytes BETWEEN 0 AND 9007199254740991),
    super_agent_tokens BIGINT CHECK (super_agent_tokens BETWEEN 0 AND 9007199254740991),
    team_turn_servers BOOLEAN NOT NULL,
    CHECK (plan <> 'selfHosted' OR
        (max_active_sessions IS NULL AND max_turns_per_session IS NULL AND max_members IS NULL
         AND turn_bytes IS NULL AND super_agent_tokens IS NULL AND team_turn_servers))
);

INSERT INTO cp_plan_limits
    (plan, max_active_sessions, max_turns_per_session, max_members, turn_bytes, super_agent_tokens, team_turn_servers)
VALUES
    ('free', 3, 30, 3, 0, 0, FALSE),
    ('go', NULL, NULL, NULL, 2147483648, 0, FALSE),
    ('pro', NULL, NULL, NULL, 21474836480, 0, TRUE),
    ('enterprise', NULL, NULL, NULL, NULL, 0, TRUE),
    ('selfHosted', NULL, NULL, NULL, NULL, NULL, TRUE);

ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
    action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update',
        'account.create', 'account.disable', 'account.delete', 'account.deletion.reject',
        'registration.update', 'turn.settings.update', 'cloudflare.turn.settings.update',
        'plan.limits.update')
);
