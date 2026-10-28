DROP TABLE cp_maintenance;
DROP INDEX cp_commands_operation;
DROP INDEX cp_commands_session_numeric;
DROP INDEX cp_sessions_archive_numeric;
DROP INDEX cp_sessions_numeric;
ALTER TABLE cp_sessions DROP COLUMN summary;
DROP FUNCTION cp_session_summary(JSONB);
