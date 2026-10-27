CREATE TABLE cp_billing_profiles (
 team_id BIGINT PRIMARY KEY REFERENCES cp_teams(id) ON DELETE CASCADE,
 customer_id TEXT UNIQUE, subscription_id TEXT UNIQUE,
 plan TEXT CHECK(plan IN ('go','pro')), subscription_status TEXT,
 paid_through BIGINT, period_anchor BIGINT NOT NULL,
 cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
 enterprise BOOLEAN NOT NULL DEFAULT FALSE,
 reconciled_at BIGINT, lease_token TEXT, lease_until BIGINT
);
CREATE TABLE cp_checkout_attempts (
 request_id TEXT PRIMARY KEY, team_id BIGINT NOT NULL REFERENCES cp_teams(id),
 plan TEXT NOT NULL CHECK(plan IN ('go','pro')),
 session_id TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','open','complete','expired')),
 created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX cp_checkout_one_open ON cp_checkout_attempts(team_id) WHERE status IN ('pending','open');
CREATE TABLE cp_payment_events (
 id TEXT PRIMARY KEY, event_type TEXT NOT NULL, object_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 available_at BIGINT NOT NULL, claim_token TEXT, claimed_until BIGINT,
 error_code TEXT, received_at BIGINT NOT NULL
);
CREATE INDEX cp_payment_pending ON cp_payment_events(available_at) WHERE status <> 'processed';
CREATE TABLE cp_session_admissions (
 id TEXT PRIMARY KEY, team_id BIGINT NOT NULL REFERENCES cp_teams(id),
 machine_id BIGINT NOT NULL REFERENCES cp_machines(id),
 kind TEXT NOT NULL CHECK(kind IN ('create','fork','restore')),
 requested_session_id TEXT, session_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
 created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX cp_session_admission_live ON cp_session_admissions(machine_id,session_id)
 WHERE session_id IS NOT NULL AND status <> 'released';
CREATE INDEX cp_admissions_team ON cp_session_admissions(team_id) WHERE status <> 'released';
ALTER TABLE cp_peers ADD COLUMN relay_allowed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE cp_turn_collector (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 owner TEXT, lease_until BIGINT, last_seen_at BIGINT, gap_since BIGINT
);
INSERT INTO cp_turn_collector(singleton) VALUES(TRUE);
