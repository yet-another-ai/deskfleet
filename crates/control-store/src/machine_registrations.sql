-- The public machine identity survives registration in multiple Teams.
ALTER TABLE cp_machines RENAME TO cp_machine_registrations;
ALTER SEQUENCE cp_machines_id_seq RENAME TO cp_machine_registrations_id_seq;
ALTER INDEX cp_machines_pkey RENAME TO cp_machine_registrations_pkey;
CREATE TABLE cp_machines (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 identity_token_hash TEXT NOT NULL UNIQUE
);
-- Existing installation credentials prove the original machine identity.
INSERT INTO cp_machines(id,identity_token_hash) OVERRIDING SYSTEM VALUE
 SELECT id,token_hash FROM cp_machine_registrations;
SELECT setval(pg_get_serial_sequence('cp_machines','id'),
 COALESCE((SELECT MAX(id) FROM cp_machines),1), EXISTS(SELECT 1 FROM cp_machines));
ALTER TABLE cp_machine_registrations ADD COLUMN machine_id BIGINT;
UPDATE cp_machine_registrations SET machine_id=id;
ALTER TABLE cp_machine_registrations ALTER COLUMN machine_id SET NOT NULL;
ALTER TABLE cp_machine_registrations ADD CONSTRAINT cp_machine_registration_identity
 FOREIGN KEY(machine_id) REFERENCES cp_machines(id);
ALTER TABLE cp_machine_registrations ADD CONSTRAINT cp_machine_registration_team
 UNIQUE(machine_id,team_id);
ALTER TABLE cp_catalogs RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_sessions RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_events RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_commands RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_peers RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_session_admissions RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_realtime_routes RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_ai_turns RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_search_documents RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_search_entries RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_search_progress RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_schedule_snapshots RENAME COLUMN machine_id TO registration_id;
ALTER TABLE cp_schedules RENAME COLUMN machine_id TO registration_id;
CREATE OR REPLACE FUNCTION cp_sync_ai_turns(machine BIGINT, session TEXT, value JSONB)
RETURNS VOID LANGUAGE SQL AS $$
 WITH incoming AS MATERIALIZED (SELECT * FROM cp_ai_turn_facts(value)),
 written AS (
  INSERT INTO cp_ai_turns(registration_id, session_id, turn_id, ended_at, member_id, model, usage)
  SELECT machine, session, turn_id, ended_at, member_id, model, usage FROM incoming
  ON CONFLICT(registration_id, session_id, turn_id) DO UPDATE
  SET ended_at=EXCLUDED.ended_at, member_id=EXCLUDED.member_id,
   model=EXCLUDED.model, usage=EXCLUDED.usage
  WHERE (cp_ai_turns.ended_at, cp_ai_turns.member_id, cp_ai_turns.model, cp_ai_turns.usage)
   IS DISTINCT FROM (EXCLUDED.ended_at, EXCLUDED.member_id, EXCLUDED.model, EXCLUDED.usage)
 )
 DELETE FROM cp_ai_turns old WHERE registration_id=machine AND session_id=session
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
 PERFORM cp_sync_ai_turns(NEW.registration_id, NEW.session_id, NEW.snapshot);
 RETURN NEW;
END
$$;
