use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    if !url.starts_with("postgres://") && !url.starts_with("postgresql://") {
        return Err("PostgreSQL DATABASE_URL required".into());
    }
    let db = Database::connect(url).await?;
    match std::env::args().nth(1).as_deref().unwrap_or("up") {
        "up" => deskfleet_control_store::schema::migrate(&db).await?,
        "down" => deskfleet_control_store::schema::down(&db).await?,
        "status" => {
            let exists = db
                .query_one_raw(Statement::from_string(
                    DbBackend::Postgres,
                    "SELECT to_regclass('cp_migrations') IS NOT NULL AS present",
                ))
                .await?
                .ok_or("missing query result")?
                .try_get::<bool>("", "present")?;
            if exists {
                for row in db
                    .query_all_raw(Statement::from_string(
                        DbBackend::Postgres,
                        "SELECT version FROM cp_migrations ORDER BY version",
                    ))
                    .await?
                {
                    println!("applied: {}", row.try_get::<i32>("", "version")?);
                }
            } else {
                println!("no central migrations applied");
            }
        }
        _ => return Err("expected up, down, or status".into()),
    }
    db.close().await?;
    Ok(())
}
