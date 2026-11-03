-- Usage is a billing record and outlives the short-lived peer grant.
ALTER TABLE cp_turn_usage DROP CONSTRAINT cp_turn_usage_peer_id_fkey;
