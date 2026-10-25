//! Versioned database migrations for the deskfleet resource catalog.

pub use sea_orm_migration::prelude::*;

mod m20261023_000001_create_catalog;
mod m20261023_000002_agent_sessions;
mod m20261025_000003_agent_elicitations;
mod m20261025_000003_session_archive;

/// Applies the catalog migrations in their declared order.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261023_000001_create_catalog::Migration),
            Box::new(m20261023_000002_agent_sessions::Migration),
            Box::new(m20261025_000003_agent_elicitations::Migration),
            Box::new(m20261025_000003_session_archive::Migration),
        ]
    }
}

#[cfg(test)]
mod tests;
