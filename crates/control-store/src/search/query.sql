WITH candidates AS (
 SELECT d.*,m.name AS machine_name,
  CASE WHEN d.kind='chat' THEN s.summary#>>'{session,title}' ELSE t.record->>'title' END AS title,
  CASE WHEN d.kind='chat' THEN s.summary#>>'{session,workspaceId}' ELSE t.record->>'workspaceId' END AS workspace_id,
  COALESCE(CASE WHEN d.kind='chat' THEN s.summary#>>'{session,updatedAt}' ELSE t.record->>'updatedAt' END,'') AS updated_at,
  c.snapshot->'workspaces' AS workspaces
 FROM cp_search_documents d
 JOIN cp_machines m ON m.id=d.machine_id
 JOIN cp_members member ON member.team_id=m.team_id AND member.user_id=$2
 JOIN cp_catalogs c ON c.machine_id=m.id
 LEFT JOIN cp_sessions s ON d.kind='chat' AND s.machine_id=d.machine_id AND s.session_id=d.resource_id
 LEFT JOIN cp_schedules t ON d.kind='schedule' AND t.machine_id=d.machine_id AND t.schedule_id=d.resource_id
 WHERE m.team_id=$1 AND NOT m.revoked AND ($3='all' OR d.kind=$3)
  AND d.content ILIKE $4 ESCAPE '\'
  AND ((d.kind='chat' AND s.summary#>>'{session,archiveState}'='active'
        AND (c.snapshot->'sessionIds') ? d.resource_id)
       OR (d.kind='schedule' AND t.schedule_id IS NOT NULL))
), best AS (
 SELECT DISTINCT ON(machine_id,kind,resource_id) * FROM candidates
 ORDER BY machine_id,kind,resource_id,priority,entry_id,block_no
), page AS (
 SELECT *,GREATEST(1,strpos(lower(content),lower($7))-70) AS snippet_start
 FROM best
 WHERE $5::jsonb IS NULL
  OR priority>($5->>'priority')::smallint
  OR (priority=($5->>'priority')::smallint AND updated_at<($5->>'updatedAt'))
  OR (priority=($5->>'priority')::smallint AND updated_at=($5->>'updatedAt')
      AND (kind,machine_id,resource_id)>(($5->>'kind'),($5->>'machineId')::bigint,($5->>'resourceId')))
 ORDER BY priority,updated_at DESC,kind,machine_id,resource_id LIMIT $6
)
SELECT jsonb_strip_nulls(jsonb_build_object(
 'kind',kind,'machineId',machine_id::text,'machineName',machine_name,
 'workspaceId',workspace_id,
 'workspaceName',(SELECT w->>'name' FROM jsonb_array_elements(COALESCE(workspaces,'[]'::jsonb)) w WHERE w->>'id'=workspace_id LIMIT 1),
 'resourceId',resource_id,'title',title,'updatedAt',updated_at,
 'entryId',CASE WHEN kind='chat' AND entry_id<>'$title' THEN entry_id END,
 'snippet',CASE WHEN snippet_start>1 THEN '…' ELSE '' END
   ||substring(content FROM snippet_start FOR char_length($7)+160)
   ||CASE WHEN char_length(content)>=snippet_start+char_length($7)+160 THEN '…' ELSE '' END
)) AS result,
jsonb_build_object('priority',priority,'updatedAt',updated_at,'kind',kind,'machineId',machine_id,'resourceId',resource_id) AS cursor
FROM page ORDER BY priority,updated_at DESC,kind,machine_id,resource_id
