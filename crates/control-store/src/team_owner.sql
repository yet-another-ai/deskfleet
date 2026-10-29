ALTER TABLE cp_members DROP CONSTRAINT cp_members_role_check;
ALTER TABLE cp_members ADD CONSTRAINT cp_members_role_check CHECK (role IN ('owner','admin','member'));

-- Development Teams did not record their creator. Promote the first current
-- administrator in the same stable account order used by the member list.
UPDATE cp_members m SET role='owner'
FROM (SELECT DISTINCT ON (team_id) team_id,user_id FROM cp_members WHERE role='admin' ORDER BY team_id,user_id) first_admin
WHERE m.team_id=first_admin.team_id AND m.user_id=first_admin.user_id;

CREATE UNIQUE INDEX cp_members_one_owner ON cp_members(team_id) WHERE role='owner';
