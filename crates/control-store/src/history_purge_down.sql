-- Purged content cannot be reconstructed. Restore the prior projection behavior.
CREATE OR REPLACE FUNCTION cp_project_ai_turns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.snapshot IS NOT DISTINCT FROM OLD.snapshot THEN RETURN NEW; END IF;
 END IF;
 PERFORM cp_sync_ai_turns(NEW.registration_id, NEW.session_id, NEW.snapshot);
 RETURN NEW;
END
$$;
