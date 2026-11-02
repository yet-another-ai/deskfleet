ALTER TABLE cp_catalogs RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_sessions RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_events RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_commands RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_peers RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_session_admissions RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_realtime_routes RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_ai_turns RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_search_documents RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_search_entries RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_search_progress RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_schedule_snapshots RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_schedules RENAME COLUMN registration_id TO machine_id;
ALTER TABLE cp_machine_registrations DROP COLUMN machine_id;
DROP TABLE cp_machines;
ALTER TABLE cp_machine_registrations RENAME TO cp_machines;
ALTER SEQUENCE cp_machine_registrations_id_seq RENAME TO cp_machines_id_seq;
ALTER INDEX cp_machine_registrations_pkey RENAME TO cp_machines_pkey;
CREATE OR REPLACE FUNCTION cp_sync_ai_turns(machine BIGINT, session TEXT, value JSONB)
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

CREATE OR REPLACE FUNCTION cp_project_ai_turns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.snapshot IS NOT DISTINCT FROM OLD.snapshot THEN RETURN NEW; END IF;
 END IF;
 PERFORM cp_sync_ai_turns(NEW.machine_id, NEW.session_id, NEW.snapshot);
 RETURN NEW;
END
$$;
