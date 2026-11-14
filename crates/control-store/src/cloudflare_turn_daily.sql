CREATE TABLE cp_cloudflare_turn_daily (
 identifier TEXT NOT NULL REFERENCES cp_cloudflare_turn_sources(identifier),
 day_start BIGINT NOT NULL CHECK(day_start % 86400000 = 0),
 egress_bytes BIGINT NOT NULL CHECK(egress_bytes >= 0),
 query_end BIGINT NOT NULL CHECK(query_end > day_start AND query_end <= day_start + 86400000),
 collected_at BIGINT NOT NULL,
 PRIMARY KEY(identifier,day_start)
);
CREATE INDEX cp_cloudflare_turn_daily_day ON cp_cloudflare_turn_daily(day_start);
ALTER TABLE cp_cloudflare_turn_usage ADD COLUMN daily_collected_at BIGINT;
