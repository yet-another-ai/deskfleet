SELECT c.machine_id::text, m.name AS machine_name, c.session_id,
    COALESCE(s.summary #>> '{session,title}', '') AS title,
    (EXTRACT(EPOCH FROM c.ended_at) * 1000)::bigint AS ended_at,
    (c.ended_at AT TIME ZONE $2)::date::text AS date,
    (EXTRACT(EPOCH FROM (date_trunc('day', c.ended_at AT TIME ZONE $2) AT TIME ZONE $2)) * 1000)::bigint AS day_start,
    COALESCE(NULLIF(c.model ->> 'id', ''), 'unknown') AS model_id,
    COALESCE(NULLIF(c.model ->> 'name', ''), NULLIF(c.model ->> 'id', ''), '') AS model_name,
    COALESCE(NULLIF(c.member_id, ''), 'unknown') AS member_id,
    COALESCE(u.name, '') AS member_name,
    COALESCE(c.usage, 'null'::jsonb) AS usage
FROM cp_ai_turns c
JOIN cp_machines m ON m.id=c.machine_id
JOIN cp_sessions s ON s.machine_id=c.machine_id AND s.session_id=c.session_id
LEFT JOIN cp_users u ON u.id=c.member_id
WHERE m.team_id=$1
    AND c.ended_at >= COALESCE(to_timestamp($3::bigint::double precision / 1000), '-infinity'::timestamptz)
    AND c.ended_at < to_timestamp($4::bigint::double precision / 1000)
ORDER BY c.ended_at, c.machine_id, c.session_id, c.turn_id
