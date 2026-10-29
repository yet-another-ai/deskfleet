-- Before local channels existed, every persisted peer grant used WebRTC.
-- Expired and revoked grants are also decoded by cleanup and revocation paths.
UPDATE cp_peers
SET grant_json = jsonb_set(grant_json, '{transport}', '"webrtc"'::jsonb)
WHERE NOT (grant_json ? 'transport');
