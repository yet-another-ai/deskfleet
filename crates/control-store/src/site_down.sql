DROP TABLE cp_site_audit;
DROP TABLE cp_site_settings;
DROP TABLE cp_site_admins;
DELETE FROM cp_migrations WHERE version=3;
