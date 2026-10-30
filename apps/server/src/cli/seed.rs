//! Explicit development fixture; ordinary startup never provisions an account.
use argon2::{Argon2, PasswordHasher};
use deskfleet_control_store::ControlStore;
use std::io;

const EMAIL: &str = "admin@deskfleet.test";
const PASSWORD: &str = "deskfleet-dev-password";

pub(super) async fn run(store: &ControlStore) -> io::Result<()> {
    let password_hash = tokio::task::spawn_blocking(|| {
        let salt = uuid::Uuid::new_v4();
        Argon2::default()
            .hash_password_with_salt(PASSWORD.as_bytes(), salt.as_bytes())
            .map(|hash| hash.to_string())
            .map_err(io::Error::other)
    })
    .await
    .map_err(io::Error::other)??;
    let created = store
        .seed_development_admin(EMAIL, "Development Admin", &password_hash)
        .await
        .map_err(io::Error::other)?;
    if created {
        println!("Created verified development Site Admin.");
        println!("Email: {EMAIL}\nPassword: {PASSWORD}");
    } else {
        println!("Account {EMAIL} already exists; credentials and permissions left unchanged.");
    }
    Ok(())
}
