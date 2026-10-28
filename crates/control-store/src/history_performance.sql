-- Lists carry only the fields needed by the sidebar and notification monitor.
-- Persist the projection so a list never has to detoast full conversation state.
CREATE FUNCTION cp_session_summary(value JSONB) RETURNS JSONB
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT jsonb_build_object(
  'session', value->'session',
  'turns', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',v->'id','state',v->'state','endedAt',v->'endedAt'))) FROM jsonb_array_elements(COALESCE(value->'turns','[]')) v WHERE v->>'state'='completed'), '[]'),
  'permissions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v->'id','state',v->'state','createdAt',v->'createdAt')) FROM jsonb_array_elements(COALESCE(value->'permissions','[]')) v), '[]'),
  'elicitations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v->'id','state',v->'state','createdAt',v->'createdAt')) FROM jsonb_array_elements(COALESCE(value->'elicitations','[]')) v), '[]')
 );
$$;
ALTER TABLE cp_sessions ADD COLUMN summary JSONB GENERATED ALWAYS AS (cp_session_summary(snapshot)) STORED;
CREATE INDEX cp_sessions_numeric ON cp_sessions(machine_id,(session_id::bigint));
CREATE INDEX cp_sessions_archive_numeric ON cp_sessions(machine_id,(summary#>>'{session,archiveState}'),(session_id::bigint));
CREATE INDEX cp_commands_session_numeric ON cp_commands(machine_id,(record->>'sessionId'),(command_id::bigint));
CREATE INDEX cp_commands_operation ON cp_commands(machine_id,(record->>'operationId')) WHERE record->>'isCanonical'='true';
CREATE TABLE cp_maintenance (
 name TEXT PRIMARY KEY, next_run_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity'
);
INSERT INTO cp_maintenance(name) VALUES('expiry');
