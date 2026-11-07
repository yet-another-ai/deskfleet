-- Deleted Session content may be purged, but its finalized AI usage remains a
-- durable billing fact. Active Session snapshots still maintain the projection.
CREATE OR REPLACE FUNCTION cp_project_ai_turns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.snapshot IS NOT DISTINCT FROM OLD.snapshot THEN RETURN NEW; END IF;
 END IF;
 PERFORM cp_sync_ai_turns(NEW.registration_id, NEW.session_id, NEW.snapshot);
 RETURN NEW;
END
$$;
