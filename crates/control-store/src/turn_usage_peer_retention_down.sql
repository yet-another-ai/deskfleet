-- Existing usage may refer to peers already pruned after the upgrade.
ALTER TABLE cp_turn_usage ADD CONSTRAINT cp_turn_usage_peer_id_fkey
 FOREIGN KEY (peer_id) REFERENCES cp_peers(id) NOT VALID;
