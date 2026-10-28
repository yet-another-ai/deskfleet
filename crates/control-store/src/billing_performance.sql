DROP INDEX cp_payment_pending;
CREATE INDEX cp_payment_claimable ON cp_payment_events(received_at)
 WHERE status <> 'processed' AND attempts < 10;
CREATE INDEX cp_admissions_machine ON cp_session_admissions(machine_id, created_at)
 WHERE status <> 'released';

ALTER TABLE cp_billing_profiles ADD COLUMN reconcile_after BIGINT NOT NULL DEFAULT 0;
CREATE INDEX cp_billing_reconcile_due ON cp_billing_profiles(reconcile_after, team_id)
 WHERE customer_id IS NOT NULL;

-- Keep the backfill and all subsequent inserts in the same accounting history.
LOCK TABLE cp_turn_usage IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE cp_turn_usage_minutes (
 team_id BIGINT NOT NULL REFERENCES cp_teams(id),
 minute_at BIGINT NOT NULL,
 sent_bytes NUMERIC NOT NULL CHECK (sent_bytes >= 0),
 PRIMARY KEY(team_id, minute_at)
);
INSERT INTO cp_turn_usage_minutes(team_id, minute_at, sent_bytes)
 SELECT team_id, collected_at / 60000 * 60000, SUM(sent_bytes)
 FROM cp_turn_usage GROUP BY team_id, collected_at / 60000 * 60000;

CREATE FUNCTION cp_record_turn_usage_minute() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO cp_turn_usage_minutes(team_id, minute_at, sent_bytes)
 VALUES (NEW.team_id, NEW.collected_at / 60000 * 60000, NEW.sent_bytes)
 ON CONFLICT(team_id, minute_at) DO UPDATE
 SET sent_bytes = cp_turn_usage_minutes.sent_bytes + EXCLUDED.sent_bytes;
 RETURN NEW;
END
$$;
CREATE TRIGGER cp_turn_usage_minute_insert AFTER INSERT ON cp_turn_usage
 FOR EACH ROW EXECUTE FUNCTION cp_record_turn_usage_minute();

-- Full minutes use aggregates; each incomplete boundary uses an indexed raw range.
-- The second boundary starts after the first, including sub-minute intervals.
CREATE FUNCTION cp_turn_sent_bytes(usage_team BIGINT, period_start BIGINT, period_end BIGINT)
 RETURNS NUMERIC LANGUAGE sql STABLE AS $$
 WITH bounds AS (
  SELECT period_start + (60000 - period_start % 60000) % 60000 AS first_minute,
   period_end / 60000 * 60000 AS last_minute
 )
 SELECT COALESCE(SUM(bytes), 0) FROM (
  SELECT SUM(sent_bytes) AS bytes FROM cp_turn_usage_minutes, bounds
   WHERE team_id = usage_team AND minute_at >= first_minute AND minute_at < last_minute
  UNION ALL
  SELECT SUM(sent_bytes) FROM cp_turn_usage, bounds
   WHERE team_id = usage_team AND collected_at >= period_start
    AND collected_at < LEAST(period_end, first_minute)
  UNION ALL
  SELECT SUM(sent_bytes) FROM cp_turn_usage, bounds
   WHERE team_id = usage_team AND collected_at >= GREATEST(first_minute, last_minute)
    AND collected_at < period_end
 ) amounts
$$;
