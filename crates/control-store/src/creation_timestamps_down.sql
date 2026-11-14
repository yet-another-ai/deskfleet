DROP INDEX cp_turn_usage_minutes_time;
DROP INDEX cp_ai_turns_time;
DROP TRIGGER cp_sessions_created_at ON cp_sessions;
DROP FUNCTION cp_record_session_created_at();
DROP FUNCTION cp_session_created_at(JSONB, BIGINT);
ALTER TABLE cp_sessions DROP COLUMN created_at;
ALTER TABLE cp_teams DROP COLUMN created_at;
ALTER TABLE cp_users DROP COLUMN created_at;
