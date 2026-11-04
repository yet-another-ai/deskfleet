-- Restore exact counters before removing the archive. Expired allocation
-- diagnostics cannot be recovered; synthetic rows carry only their billing facts.
-- A merged millisecond can exceed bigint, so split it into bigint-sized deltas.
LOCK TABLE cp_turn_usage IN ACCESS EXCLUSIVE MODE;
ALTER TABLE cp_turn_usage DISABLE TRIGGER cp_turn_usage_minute_insert;
INSERT INTO cp_turn_usage(peer_id, team_id, realm, allocation_id, side,
 received_bytes, sent_bytes, collected_at)
SELECT 'archived', archive.team_id, '', 'archived', 'client', 0,
 LEAST(9223372036854775807::numeric,
  detail.value::numeric - part * 9223372036854775807::numeric)::bigint,
 archive.minute_at + detail.key::bigint
FROM cp_turn_usage_archive archive
CROSS JOIN LATERAL jsonb_each(archive.sent_bytes_by_ms) detail
CROSS JOIN LATERAL generate_series(0::numeric,
 div(detail.value::numeric - 1, 9223372036854775807::numeric), 1::numeric) parts(part);
ALTER TABLE cp_turn_usage ENABLE TRIGGER cp_turn_usage_minute_insert;

CREATE OR REPLACE FUNCTION cp_coturn_sent_bytes(usage_team BIGINT, period_start BIGINT, period_end BIGINT)
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
DROP FUNCTION cp_compact_turn_usage(BIGINT, BIGINT);
DROP FUNCTION cp_merge_turn_usage_milliseconds(JSONB, JSONB);
DROP INDEX cp_turn_usage_expiry;
DROP TABLE cp_turn_usage_archive;
