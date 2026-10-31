DROP TRIGGER cp_ai_turns_snapshot ON cp_sessions;
DROP FUNCTION cp_project_ai_turns();
DROP FUNCTION cp_sync_ai_turns(BIGINT, TEXT, JSONB);
DROP FUNCTION cp_ai_turn_facts(JSONB);
DROP TABLE cp_ai_turns;
