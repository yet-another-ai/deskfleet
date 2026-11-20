CREATE TABLE cp_cloud_credit_rates (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    input NUMERIC(18,6) NOT NULL CHECK (input >= 0),
    output NUMERIC(18,6) NOT NULL CHECK (output >= 0),
    cache_read NUMERIC(18,6) NOT NULL CHECK (cache_read >= 0),
    cache_write NUMERIC(18,6) NOT NULL CHECK (cache_write >= 0)
);
INSERT INTO cp_cloud_credit_rates (input, output, cache_read, cache_write) VALUES (1, 1, 1, 1);

-- Old events were admitted at one credit per token, regardless of cache breakdown.
ALTER TABLE cp_cloud_token_usage ADD COLUMN charged_credits NUMERIC;
UPDATE cp_cloud_token_usage SET charged_credits = input_tokens::numeric + output_tokens;
ALTER TABLE cp_cloud_token_usage ALTER COLUMN charged_credits SET NOT NULL;
ALTER TABLE cp_cloud_token_usage ADD CHECK (charged_credits >= 0);

-- Snapshot rates in the same transaction as the immutable usage event, including
-- inserts by older collectors during a rolling deployment. ON CONFLICT DO NOTHING
-- keeps the first charge when an event is replayed.
CREATE FUNCTION cp_charge_cloud_token_usage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    rates cp_cloud_credit_rates%ROWTYPE;
    cache_read BIGINT := COALESCE(NEW.cached_read_tokens, 0);
    cache_write BIGINT := COALESCE(NEW.cached_write_tokens, 0);
BEGIN
    SELECT * INTO STRICT rates FROM cp_cloud_credit_rates WHERE singleton FOR SHARE;
    -- A breakdown larger than the total cannot partition the input. Price the
    -- full input at the ordinary rate and retain the provider's original facts.
    IF cache_read::numeric + cache_write > NEW.input_tokens THEN
        cache_read := 0;
        cache_write := 0;
    END IF;
    NEW.charged_credits := (NEW.input_tokens::numeric - cache_read - cache_write) * rates.input
        + NEW.output_tokens * rates.output
        + cache_read * rates.cache_read
        + cache_write * rates.cache_write;
    RETURN NEW;
END
$$;
CREATE TRIGGER cp_charge_cloud_token_usage BEFORE INSERT ON cp_cloud_token_usage
    FOR EACH ROW EXECUTE FUNCTION cp_charge_cloud_token_usage();
