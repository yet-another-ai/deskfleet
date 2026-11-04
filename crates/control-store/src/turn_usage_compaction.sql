-- Raw allocation diagnostics expire; exact billing counters remain durable.
-- One archive row per Team/minute has at most 60,000 millisecond keys, regardless
-- of the number of allocations or notifications within that minute.
CREATE TABLE cp_turn_usage_archive (
 team_id BIGINT NOT NULL REFERENCES cp_teams(id),
 minute_at BIGINT NOT NULL,
 sent_bytes_by_ms JSONB NOT NULL CHECK(jsonb_typeof(sent_bytes_by_ms) = 'object'),
 PRIMARY KEY(team_id, minute_at)
);
CREATE INDEX cp_turn_usage_expiry ON cp_turn_usage(collected_at, id);

CREATE FUNCTION cp_merge_turn_usage_milliseconds(left_value JSONB, right_value JSONB)
 RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_object_agg(offset_ms, bytes), '{}'::jsonb)
 FROM (
  SELECT key AS offset_ms, SUM(value::numeric) AS bytes
  FROM (
   SELECT * FROM jsonb_each(left_value)
   UNION ALL
   SELECT * FROM jsonb_each(right_value)
  ) values_by_ms GROUP BY key
 ) merged
$$;

CREATE FUNCTION cp_compact_turn_usage(before_at BIGINT, batch_limit BIGINT)
 RETURNS BIGINT LANGUAGE sql AS $$
 WITH candidates AS (
  SELECT id FROM cp_turn_usage WHERE collected_at < before_at
  ORDER BY collected_at, id LIMIT GREATEST(1, LEAST(batch_limit, 10000))
  FOR UPDATE SKIP LOCKED
 ), removed AS (
  DELETE FROM cp_turn_usage raw USING candidates
  WHERE raw.id = candidates.id
  RETURNING raw.team_id, raw.collected_at, raw.sent_bytes
 ), milliseconds AS (
  SELECT team_id, collected_at / 60000 * 60000 AS minute_at,
   collected_at % 60000 AS offset_ms, SUM(sent_bytes) AS bytes
  FROM removed WHERE sent_bytes > 0
  GROUP BY team_id, collected_at
 ), archived AS (
  INSERT INTO cp_turn_usage_archive(team_id, minute_at, sent_bytes_by_ms)
  SELECT team_id, minute_at, jsonb_object_agg(offset_ms::text, bytes)
  FROM milliseconds GROUP BY team_id, minute_at ORDER BY team_id, minute_at
  ON CONFLICT(team_id, minute_at) DO UPDATE
  SET sent_bytes_by_ms = cp_merge_turn_usage_milliseconds(
   cp_turn_usage_archive.sent_bytes_by_ms, EXCLUDED.sent_bytes_by_ms)
  RETURNING team_id
 )
 SELECT COUNT(*) FROM removed
$$;

-- Existing minute totals already include compacted rows. Only the two partial
-- minute boundaries combine raw and archived counters. STABLE gives all reads
-- the caller's statement snapshot during concurrent compaction and late inserts.
CREATE OR REPLACE FUNCTION cp_coturn_sent_bytes(usage_team BIGINT, period_start BIGINT, period_end BIGINT)
 RETURNS NUMERIC LANGUAGE sql STABLE AS $$
 WITH bounds AS (
  SELECT period_start + (60000 - period_start % 60000) % 60000 AS first_minute,
   period_end / 60000 * 60000 AS last_minute
 ), edges AS (
  SELECT period_start AS start_at, LEAST(period_end, first_minute) AS end_at FROM bounds
  UNION ALL
  SELECT GREATEST(first_minute, last_minute), period_end FROM bounds
 )
 SELECT COALESCE(SUM(bytes), 0) FROM (
  SELECT SUM(sent_bytes) AS bytes FROM cp_turn_usage_minutes, bounds
   WHERE team_id = usage_team AND minute_at >= first_minute AND minute_at < last_minute
  UNION ALL
  SELECT SUM(raw.sent_bytes) FROM cp_turn_usage raw JOIN edges
   ON raw.collected_at >= edges.start_at AND raw.collected_at < edges.end_at
   WHERE raw.team_id = usage_team
  UNION ALL
  SELECT SUM(detail.value::numeric) FROM edges
   JOIN cp_turn_usage_archive archive
    ON archive.team_id = usage_team AND edges.start_at < edges.end_at
     AND archive.minute_at = edges.start_at / 60000 * 60000
   CROSS JOIN LATERAL jsonb_each(archive.sent_bytes_by_ms) detail
   WHERE archive.minute_at + detail.key::bigint >= edges.start_at
    AND archive.minute_at + detail.key::bigint < edges.end_at
 ) amounts
$$;
