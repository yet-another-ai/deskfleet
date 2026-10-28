WITH turns AS (
    SELECT s.machine_id, s.session_id, m.name AS machine_name,
        COALESCE(s.snapshot #>> '{session,title}', '') AS title,
        s.snapshot -> 'inputs' AS inputs, t.turn,
        CASE WHEN pg_input_is_valid(t.turn ->> 'endedAt', 'timestamp with time zone')
            THEN (t.turn ->> 'endedAt')::timestamptz END AS ended_at
    FROM cp_sessions s
    JOIN cp_machines m ON m.id=s.machine_id
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(s.snapshot -> 'turns')='array'
            THEN s.snapshot -> 'turns' ELSE '[]'::jsonb END
    ) AS t(turn)
    WHERE m.team_id=$1
        AND t.turn ->> 'state' IN ('completed', 'cancelled', 'interrupted', 'failed')
        AND (t.turn ->> 'consumed') IS DISTINCT FROM 'false'
), completed AS (
    SELECT DISTINCT ON (machine_id, session_id, turn ->> 'id') *
    FROM turns
    WHERE ended_at >= COALESCE(to_timestamp($3::bigint::double precision / 1000), '-infinity'::timestamptz)
        AND ended_at < to_timestamp($4::bigint::double precision / 1000)
    ORDER BY machine_id, session_id, turn ->> 'id', ended_at DESC
)
SELECT c.machine_id::text, c.machine_name, c.session_id, c.title,
    (EXTRACT(EPOCH FROM c.ended_at) * 1000)::bigint AS ended_at,
    (c.ended_at AT TIME ZONE $2)::date::text AS date,
    (EXTRACT(EPOCH FROM (date_trunc('day', c.ended_at AT TIME ZONE $2) AT TIME ZONE $2)) * 1000)::bigint AS day_start,
    COALESCE(NULLIF(c.turn #>> '{model,id}', ''), 'unknown') AS model_id,
    COALESCE(NULLIF(c.turn #>> '{model,name}', ''), NULLIF(c.turn #>> '{model,id}', ''), '') AS model_name,
    COALESCE(NULLIF(author.user_id, ''), 'unknown') AS member_id,
    COALESCE(u.name, '') AS member_name,
    COALESCE(c.turn -> 'usage', 'null'::jsonb) AS usage
FROM completed c
LEFT JOIN LATERAL (
    SELECT input #>> '{author,userId}' AS user_id
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.inputs)='array'
        THEN c.inputs ELSE '[]'::jsonb END) AS input
    WHERE input ->> 'id'=c.turn ->> 'initialInputId'
    LIMIT 1
) AS author ON true
LEFT JOIN cp_users u ON u.id=author.user_id
ORDER BY c.ended_at, c.machine_id, c.session_id, c.turn ->> 'id'
