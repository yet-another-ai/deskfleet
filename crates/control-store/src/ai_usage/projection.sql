-- Backfill and snapshot writes must share one atomic projection history.
LOCK TABLE cp_sessions IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE cp_ai_turns (
 machine_id BIGINT NOT NULL,
 session_id TEXT NOT NULL,
 turn_id TEXT,
 ended_at TIMESTAMPTZ NOT NULL,
 member_id TEXT,
 model JSONB,
 usage JSONB,
 UNIQUE NULLS NOT DISTINCT (machine_id, session_id, turn_id),
 FOREIGN KEY(machine_id, session_id) REFERENCES cp_sessions(machine_id, session_id) ON DELETE CASCADE
);
CREATE INDEX cp_ai_turns_machine_time ON cp_ai_turns(machine_id, ended_at);

-- Resolve input authors once per snapshot, rather than scanning inputs per turn.
CREATE FUNCTION cp_ai_turn_facts(value JSONB)
RETURNS TABLE(turn_id TEXT, ended_at TIMESTAMPTZ, member_id TEXT, model JSONB, usage JSONB)
LANGUAGE SQL STABLE AS $$
 WITH authors AS (
  SELECT jsonb_object_agg(input->>'id', input#>'{author,userId}' ORDER BY ordinal DESC) AS names
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(value->'inputs')='array'
   THEN value->'inputs' ELSE '[]'::jsonb END) WITH ORDINALITY AS i(input, ordinal)
  WHERE input->>'id' IS NOT NULL
 ), turns AS (
  SELECT turn, ordinal,
   CASE WHEN pg_input_is_valid(turn->>'endedAt', 'timestamp with time zone')
    THEN (turn->>'endedAt')::timestamptz END AS ended_at
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(value->'turns')='array'
   THEN value->'turns' ELSE '[]'::jsonb END) WITH ORDINALITY AS t(turn, ordinal)
  WHERE turn->>'state' IN ('completed', 'cancelled', 'interrupted', 'failed')
   AND (turn->>'consumed') IS DISTINCT FROM 'false'
 )
 SELECT DISTINCT ON (turn->>'id') turn->>'id', ended_at,
  names->>(turn->>'initialInputId'), turn->'model', turn->'usage'
 FROM turns CROSS JOIN authors WHERE ended_at IS NOT NULL
 ORDER BY turn->>'id', ended_at DESC, ordinal;
$$;

CREATE FUNCTION cp_sync_ai_turns(machine BIGINT, session TEXT, value JSONB)
RETURNS VOID LANGUAGE SQL AS $$
 WITH incoming AS MATERIALIZED (SELECT * FROM cp_ai_turn_facts(value)),
 written AS (
  INSERT INTO cp_ai_turns(machine_id, session_id, turn_id, ended_at, member_id, model, usage)
  SELECT machine, session, turn_id, ended_at, member_id, model, usage FROM incoming
  ON CONFLICT(machine_id, session_id, turn_id) DO UPDATE
  SET ended_at=EXCLUDED.ended_at, member_id=EXCLUDED.member_id,
   model=EXCLUDED.model, usage=EXCLUDED.usage
  WHERE (cp_ai_turns.ended_at, cp_ai_turns.member_id, cp_ai_turns.model, cp_ai_turns.usage)
   IS DISTINCT FROM (EXCLUDED.ended_at, EXCLUDED.member_id, EXCLUDED.model, EXCLUDED.usage)
 )
 DELETE FROM cp_ai_turns old WHERE machine_id=machine AND session_id=session
  AND CASE WHEN old.turn_id IS NULL
   THEN NOT EXISTS (SELECT 1 FROM incoming WHERE turn_id IS NULL)
   ELSE old.turn_id NOT IN (SELECT turn_id FROM incoming WHERE turn_id IS NOT NULL)
  END;
$$;

CREATE FUNCTION cp_project_ai_turns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.snapshot IS NOT DISTINCT FROM OLD.snapshot THEN RETURN NEW; END IF;
 END IF;
 PERFORM cp_sync_ai_turns(NEW.machine_id, NEW.session_id, NEW.snapshot);
 RETURN NEW;
END
$$;
CREATE TRIGGER cp_ai_turns_snapshot AFTER INSERT OR UPDATE OF snapshot ON cp_sessions
 FOR EACH ROW EXECUTE FUNCTION cp_project_ai_turns();
SELECT cp_sync_ai_turns(machine_id, session_id, snapshot) FROM cp_sessions;
