ALTER TABLE cp_users ADD COLUMN deleted_at BIGINT;
CREATE TABLE cp_account_deletion_requests (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES cp_users(id),
 reason TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 2000),
 status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
 requested_at BIGINT NOT NULL,
 reviewed_at BIGINT,
 reviewed_by TEXT REFERENCES cp_users(id),
 review_note TEXT CHECK (review_note IS NULL OR octet_length(review_note) <= 2000)
);
CREATE UNIQUE INDEX cp_account_deletion_requests_pending
 ON cp_account_deletion_requests(user_id) WHERE status = 'pending';
CREATE INDEX cp_account_deletion_requests_review
 ON cp_account_deletion_requests(status, id);
ALTER TABLE cp_site_audit DROP CONSTRAINT cp_site_audit_action_check;
ALTER TABLE cp_site_audit ADD CONSTRAINT cp_site_audit_action_check CHECK (
 action IN ('admin.grant', 'admin.revoke', 'settings.update', 'enterprise.update',
   'account.disable', 'account.delete', 'account.deletion.reject',
   'registration.update', 'turn.settings.update', 'cloudflare.turn.settings.update')
);
