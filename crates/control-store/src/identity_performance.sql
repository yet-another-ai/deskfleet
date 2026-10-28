CREATE INDEX cp_auth_limits_expiry ON cp_auth_limits(period);
CREATE INDEX cp_login_attempts_expiry ON cp_login_attempts(expires_at);
CREATE INDEX cp_login_codes_expiry ON cp_login_codes(expires_at);
CREATE INDEX cp_login_codes_user ON cp_login_codes(user_id);
CREATE INDEX cp_login_sessions_user ON cp_login_sessions(user_id,created_at DESC);
CREATE INDEX cp_passkeys_user ON cp_passkeys(user_id,created_at);
CREATE INDEX cp_identity_challenges_user ON cp_identity_challenges(user_id);
CREATE INDEX cp_identity_challenges_registration ON cp_identity_challenges(email) WHERE purpose='registration';
CREATE INDEX cp_members_user ON cp_members(user_id,team_id);
CREATE INDEX cp_machines_team ON cp_machines(team_id,id);
CREATE INDEX cp_invites_team ON cp_invites(team_id);
CREATE INDEX cp_invites_expiry ON cp_invites(expires_at);
CREATE INDEX cp_checkout_team ON cp_checkout_attempts(team_id);
CREATE INDEX cp_admissions_team_history ON cp_session_admissions(team_id);
CREATE INDEX cp_peers_user ON cp_peers(user_id,team_id) WHERE NOT revoked;
CREATE INDEX cp_peers_team ON cp_peers(team_id);
CREATE INDEX cp_peers_machine_expiry ON cp_peers(machine_id,expires_at) WHERE NOT revoked;
DROP INDEX cp_peers_machine;

-- Include short grams so literal one- and two-character searches are indexed,
-- including punctuation and Unicode. The final strpos check rejects candidates
-- whose grams occur in another order or span the separate name/email fields.
CREATE FUNCTION cp_account_search_grams(value TEXT) RETURNS TEXT[]
LANGUAGE SQL IMMUTABLE PARALLEL SAFE STRICT AS $$
 SELECT ARRAY(
  SELECT DISTINCT substr(normalized,position,width)
  FROM (SELECT lower(value) AS normalized) text,
       generate_series(1,least(3,char_length(normalized))) width,
       LATERAL generate_series(1,char_length(normalized)-width+1) position
 )
$$;
CREATE INDEX cp_users_search ON cp_users USING GIN (
 (cp_account_search_grams(name) || cp_account_search_grams(email))
);
