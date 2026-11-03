-- Oversized provisional negotiations cannot be resumed under the new contract.
UPDATE cp_peers SET revoked=TRUE WHERE id IN (
 SELECT peer_id FROM cp_peer_negotiations WHERE
 octet_length(options::text)>1024 OR octet_length(pending::text)>262144
 OR octet_length(offer)>1048576 OR octet_length(answer)>1048576
);
DELETE FROM cp_peer_negotiations WHERE
 octet_length(options::text)>1024 OR octet_length(pending::text)>262144
 OR octet_length(offer)>1048576 OR octet_length(answer)>1048576;
ALTER TABLE cp_peer_negotiations
 ADD CONSTRAINT cp_negotiation_options_bytes CHECK (octet_length(options::text)<=1024),
 ADD CONSTRAINT cp_negotiation_pending_bytes CHECK (octet_length(pending::text)<=262144),
 ADD CONSTRAINT cp_negotiation_offer_bytes CHECK (octet_length(offer)<=1048576),
 ADD CONSTRAINT cp_negotiation_answer_bytes CHECK (octet_length(answer)<=1048576);
