ALTER TABLE cp_site_settings
    ADD COLUMN terms_of_service_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN privacy_terms_url TEXT NOT NULL DEFAULT '';
