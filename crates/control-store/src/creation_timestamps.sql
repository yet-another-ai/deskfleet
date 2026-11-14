-- Keep creation dates separate from mutable observation and billing timestamps.
ALTER TABLE cp_users ADD COLUMN created_at BIGINT;
ALTER TABLE cp_teams ADD COLUMN created_at BIGINT;
ALTER TABLE cp_sessions ADD COLUMN created_at BIGINT;

-- UUIDv7 user IDs retain their original Unix-millisecond creation timestamp.
-- Legacy IDs fall back to an explicit account-creation audit, then deployment.
UPDATE cp_users u SET created_at = LEAST(u.deleted_at, COALESCE(
 CASE WHEN u.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN ('x' || substr(replace(u.id, '-', ''), 1, 12))::bit(48)::bigint END,
 (SELECT MIN(occurred_at) FROM cp_site_audit
  WHERE target_user_id = u.id AND action = 'account.create'),
 floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint));

CREATE FUNCTION cp_session_created_at(value JSONB, fallback BIGINT)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE created TIMESTAMPTZ;
BEGIN
 IF pg_input_is_valid(value #>> '{session,createdAt}', 'timestamp with time zone') THEN
  created := (value #>> '{session,createdAt}')::timestamptz;
  IF isfinite(created) THEN
   RETURN floor(extract(epoch FROM created) * 1000)::bigint;
  END IF;
 END IF;
 RETURN fallback;
END
$$;

-- Purged or older snapshots can only retain their last observed timestamp.
UPDATE cp_sessions SET created_at = LEAST(deleted_at,
 cp_session_created_at(snapshot, observed_at));

-- Teams previously had no creation field. Their earliest retained activity is
-- an explicit historical approximation; no timestamp can recover removed Teams.
UPDATE cp_teams t SET created_at = LEAST(
 (SELECT period_anchor FROM cp_billing_profiles WHERE team_id = t.id),
 (SELECT MIN(created_at) FROM cp_session_admissions WHERE team_id = t.id),
 (SELECT MIN(s.created_at) FROM cp_sessions s
  JOIN cp_machine_registrations r ON r.id = s.registration_id WHERE r.team_id = t.id),
 floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint);

ALTER TABLE cp_users ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE cp_users ALTER COLUMN created_at SET DEFAULT
 floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint;
ALTER TABLE cp_teams ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE cp_teams ALTER COLUMN created_at SET DEFAULT
 floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint;
ALTER TABLE cp_sessions ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE cp_sessions ALTER COLUMN created_at SET DEFAULT
 floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint;

-- Derive the original creation date only on insertion. Re-syncing, archive,
-- restore and content cleanup must never move it to the last observation time.
CREATE FUNCTION cp_record_session_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.created_at := cp_session_created_at(NEW.snapshot, NEW.created_at);
 RETURN NEW;
END
$$;
CREATE TRIGGER cp_sessions_created_at BEFORE INSERT ON cp_sessions
 FOR EACH ROW EXECUTE FUNCTION cp_record_session_created_at();

CREATE INDEX cp_ai_turns_time ON cp_ai_turns(ended_at);
CREATE INDEX cp_turn_usage_minutes_time ON cp_turn_usage_minutes(minute_at);
