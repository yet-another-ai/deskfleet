use sea_orm::Database;
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
            if let Some(versions) = deskfleet_control_store::schema::applied_versions(&db).await? {
                for version in versions {
                    println!("applied: {version}");
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
