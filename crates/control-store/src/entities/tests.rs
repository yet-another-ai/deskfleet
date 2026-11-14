use super::*;
use crate::ControlStore;
use sea_orm::{ConnectionTrait, EntityTrait, QuerySelect};

/// Every table/column mapping must resolve against the migrated PostgreSQL schema.
/// This catches schema typos even in paths without populated fixture records.
#[tokio::test]
#[ignore = "requires a real PostgreSQL TEST_DATABASE_URL"]
async fn entity_mappings_match_migrated_schema() {
    let url = std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL");
    let store = ControlStore::connect(&url).await.unwrap();
    let db = store.database();
    cp_account_deletion_requests::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_account_deletion_requests mapping");
    cp_auth_limits::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_auth_limits mapping");
    cp_billing_analytics::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_billing_analytics mapping");
    cp_billing_profiles::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_billing_profiles mapping");
    cp_catalogs::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_catalogs mapping");
    cp_checkout_attempts::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_checkout_attempts mapping");
    cp_cloudflare_turn_collector::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_cloudflare_turn_collector mapping");
    cp_cloudflare_turn_daily::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_cloudflare_turn_daily mapping");
    cp_cloudflare_turn_settings::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_cloudflare_turn_settings mapping");
    cp_cloudflare_turn_sources::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_cloudflare_turn_sources mapping");
    cp_cloudflare_turn_usage::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_cloudflare_turn_usage mapping");
    cp_commands::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_commands mapping");
    cp_events::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_events mapping");
    cp_github_app_authorizations::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_github_app_authorizations mapping");
    cp_github_identities::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_github_identities mapping");
    cp_google_identities::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_google_identities mapping");
    cp_identity_challenges::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_identity_challenges mapping");
    cp_invites::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_invites mapping");
    cp_login_attempts::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_login_attempts mapping");
    cp_login_codes::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_login_codes mapping");
    cp_login_sessions::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_login_sessions mapping");
    cp_machine_registrations::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_machine_registrations mapping");
    cp_machines::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_machines mapping");
    cp_maintenance::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_maintenance mapping");
    cp_members::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_members mapping");
    cp_migrations::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_migrations mapping");
    cp_passkeys::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_passkeys mapping");
    cp_payment_events::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_payment_events mapping");
    cp_peer_negotiations::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_peer_negotiations mapping");
    cp_peers::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_peers mapping");
    cp_realtime_messages::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_realtime_messages mapping");
    cp_realtime_nodes::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_realtime_nodes mapping");
    cp_realtime_routes::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_realtime_routes mapping");
    cp_registration_policy::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_registration_policy mapping");
    cp_schedule_snapshots::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_schedule_snapshots mapping");
    cp_schedules::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_schedules mapping");
    cp_search_documents::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_search_documents mapping");
    cp_search_entries::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_search_entries mapping");
    cp_search_progress::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_search_progress mapping");
    cp_session_admissions::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_session_admissions mapping");
    cp_sessions::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_sessions mapping");
    cp_site_admins::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_site_admins mapping");
    cp_site_audit::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_site_audit mapping");
    cp_site_settings::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_site_settings mapping");
    cp_team_turn_servers::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_team_turn_servers mapping");
    cp_teams::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_teams mapping");
    cp_turn_collector::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_turn_collector mapping");
    cp_turn_settings::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_turn_settings mapping");
    cp_turn_usage::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_turn_usage mapping");
    cp_turn_usage_minutes::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_turn_usage_minutes mapping");
    cp_turn_usage_archive::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_turn_usage_archive mapping");
    cp_users::Entity::find()
        .limit(0)
        .all(db)
        .await
        .expect("cp_users mapping");
    use cp_ai_turns::{Column, Entity};
    use sea_orm::sea_query::Query;
    db.query_all(
        Query::select()
            .from(Entity)
            .columns([
                Column::RegistrationId,
                Column::SessionId,
                Column::TurnId,
                Column::EndedAt,
                Column::MemberId,
                Column::Model,
                Column::Usage,
            ])
            .limit(0),
    )
    .await
    .expect("cp_ai_turns projection mapping");
    store.close().await.unwrap();
}
