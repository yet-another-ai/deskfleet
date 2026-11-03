ALTER TABLE cp_peer_negotiations
 DROP CONSTRAINT cp_negotiation_options_bytes,
 DROP CONSTRAINT cp_negotiation_pending_bytes,
 DROP CONSTRAINT cp_negotiation_offer_bytes,
 DROP CONSTRAINT cp_negotiation_answer_bytes;
