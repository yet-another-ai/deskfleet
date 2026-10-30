-- Include live turns in the content-free catalog projection.
CREATE OR REPLACE FUNCTION cp_session_summary(value JSONB) RETURNS JSONB
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT jsonb_build_object(
  'session', value->'session',
  'turns', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',v->'id','state',v->'state','endedAt',v->'endedAt'))) FROM jsonb_array_elements(COALESCE(value->'turns','[]')) v WHERE v->>'state' IN ('completed', 'starting', 'running', 'cancelling')), '[]'),
  'permissions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v->'id','state',v->'state','createdAt',v->'createdAt')) FROM jsonb_array_elements(COALESCE(value->'permissions','[]')) v), '[]'),
  'elicitations', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v->'id','state',v->'state','createdAt',v->'createdAt')) FROM jsonb_array_elements(COALESCE(value->'elicitations','[]')) v), '[]')
 );
$$;
-- Recompute stored generated summaries for existing sessions.
UPDATE cp_sessions SET snapshot = snapshot;
