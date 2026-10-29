DROP INDEX cp_members_one_owner;
UPDATE cp_members SET role='admin' WHERE role='owner';
ALTER TABLE cp_members DROP CONSTRAINT cp_members_role_check;
ALTER TABLE cp_members ADD CONSTRAINT cp_members_role_check CHECK (role IN ('admin','member'));
