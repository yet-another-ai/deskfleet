//! Central PostgreSQL schema. Keep these mappings aligned with schema migrations.
pub(crate) mod cp_account_deletion_requests;
pub(crate) mod cp_ai_turns;
pub(crate) mod cp_auth_limits;
pub(crate) mod cp_billing_analytics;
pub(crate) mod cp_billing_profiles;
pub(crate) mod cp_catalogs;
pub(crate) mod cp_checkout_attempts;
pub(crate) mod cp_cloudflare_turn_collector;
pub(crate) mod cp_cloudflare_turn_daily;
pub(crate) mod cp_cloudflare_turn_settings;
pub(crate) mod cp_cloudflare_turn_sources;
pub(crate) mod cp_cloudflare_turn_usage;
pub(crate) mod cp_commands;
pub(crate) mod cp_events;
pub(crate) mod cp_github_app_authorizations;
pub(crate) mod cp_github_identities;
pub(crate) mod cp_google_identities;
pub(crate) mod cp_identity_challenges;
pub(crate) mod cp_invites;
pub(crate) mod cp_login_attempts;
pub(crate) mod cp_login_codes;
pub(crate) mod cp_login_sessions;
pub(crate) mod cp_machine_registrations;
pub(crate) mod cp_machines;
pub(crate) mod cp_maintenance;
pub(crate) mod cp_members;
pub(crate) mod cp_migrations;
pub(crate) mod cp_passkeys;
pub(crate) mod cp_payment_events;
pub(crate) mod cp_peer_negotiations;
pub(crate) mod cp_peers;
pub(crate) mod cp_realtime_messages;
pub(crate) mod cp_realtime_nodes;
pub(crate) mod cp_realtime_routes;
pub(crate) mod cp_registration_policy;
pub(crate) mod cp_schedule_snapshots;
pub(crate) mod cp_schedules;
pub(crate) mod cp_search_documents;
pub(crate) mod cp_search_entries;
pub(crate) mod cp_search_progress;
pub(crate) mod cp_session_admissions;
pub(crate) mod cp_sessions;
pub(crate) mod cp_site_admins;
pub(crate) mod cp_site_audit;
pub(crate) mod cp_site_settings;
pub(crate) mod cp_team_turn_servers;
pub(crate) mod cp_teams;
pub(crate) mod cp_turn_collector;
pub(crate) mod cp_turn_settings;
pub(crate) mod cp_turn_usage;
// Written by the atomic compaction function; validated with the other mappings.
#[allow(dead_code)]
pub(crate) mod cp_turn_usage_archive;
// Written by database triggers; the mapping is validated with the rest of the schema.
#[allow(dead_code)]
pub(crate) mod cp_turn_usage_minutes;
pub(crate) mod cp_users;

#[cfg(test)]
mod tests;
