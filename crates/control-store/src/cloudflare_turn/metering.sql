WITH coturn AS (
 SELECT c.*, COALESCE((SELECT jsonb_array_length(urls)>0 FROM cp_turn_settings WHERE singleton),TRUE) AS required
 FROM cp_turn_collector c WHERE singleton
), sources AS (
 -- A recently collected contiguous prior period can bridge the first two
 -- minutes of a rollover while the collector writes the new period's snapshot.
 SELECT s.created_at, COALESCE((SELECT MAX(u.collected_at) FROM cp_cloudflare_turn_usage u
 WHERE u.identifier=s.identifier AND u.period_start<=$2 AND u.period_end>$2
 AND ($3::bigint IS NULL OR (u.period_start=$3 AND u.period_end=$4))),
 (SELECT MAX(u.collected_at) FROM cp_cloudflare_turn_usage u
 WHERE u.identifier=s.identifier AND u.period_end=$3
 AND s.expires_at>$2 AND $3>$2-120000 AND $3<=$2
 AND u.collected_at>$2-120000 AND u.query_end>=$3-120000)) AS last_seen_at
 FROM cp_cloudflare_turn_sources s WHERE ($1::bigint IS NULL OR s.team_id=$1)
 AND (s.expires_at>$2 OR EXISTS (
 SELECT 1 FROM cp_cloudflare_turn_usage u WHERE u.identifier=s.identifier
 AND u.period_start<=$2 AND u.period_end>$2
 AND ($3::bigint IS NULL OR (u.period_start=$3 AND u.period_end=$4))
 AND (u.collected_at IS NULL OR u.collected_at<u.expires_at+300000 OR u.query_end<u.expires_at)))
), cloudflare AS (
 SELECT MIN(last_seen_at) AS last_seen_at,
 COALESCE(BOOL_AND(created_at>$2-120000 OR COALESCE(last_seen_at>$2-120000,FALSE)),TRUE) AS fresh,
 COUNT(*)>0 AS required FROM sources
)
SELECT LEAST(CASE WHEN c.required THEN c.last_seen_at END,
 CASE WHEN f.required THEN f.last_seen_at END) AS last_seen_at,
 LEAST(CASE WHEN c.required THEN c.gap_since END,
 CASE WHEN f.required THEN (SELECT gap_since FROM cp_cloudflare_turn_collector WHERE singleton) END) AS gap_since,
 ((NOT c.required OR COALESCE(c.last_seen_at>$2-60000,FALSE)) AND f.fresh) AS fresh
FROM coturn c CROSS JOIN cloudflare f
