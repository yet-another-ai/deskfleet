CREATE INDEX cp_peers_user_active ON cp_peers(user_id,expires_at) WHERE NOT revoked;
CREATE INDEX cp_peers_team_active ON cp_peers(team_id,expires_at) WHERE NOT revoked;
CREATE INDEX cp_peers_expiry ON cp_peers(expires_at);
