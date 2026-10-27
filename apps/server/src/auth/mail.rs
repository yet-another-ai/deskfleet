use super::config::MailConfig;
use crate::error::{ApiError, Result};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    transport::smtp::authentication::Credentials,
};
use std::time::Duration;

pub struct Mailer {
    config: MailConfig,
    smtp: Option<AsyncSmtpTransport<Tokio1Executor>>,
}
impl Mailer {
    pub fn new(config: MailConfig) -> Result<Self> {
        let smtp = if let MailConfig::Smtp {
            host,
            port,
            username,
            password,
            ..
        } = &config
        {
            Some(
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
                    .map_err(|_| ApiError::bad("invalid SMTP relay"))?
                    .port(*port)
                    .credentials(Credentials::new(username.clone(), password.clone()))
                    .timeout(Some(Duration::from_secs(15)))
                    .build(),
            )
        } else {
            None
        };
        Ok(Self { config, smtp })
    }
    pub async fn send(&self, to: &str, subject: &str, body: &str) -> Result<()> {
        let from = match &self.config {
            MailConfig::Smtp { from, .. } => from.as_str(),
            MailConfig::Local { .. } => "deskfleet@localhost.test",
        };
        let message = Message::builder()
            .from(
                from.parse()
                    .map_err(|_| ApiError::bad("invalid mail sender"))?,
            )
            .to(to
                .parse()
                .map_err(|_| ApiError::bad("invalid email address"))?)
            .subject(subject)
            .body(body.to_owned())
            .map_err(|_| ApiError::internal())?;
        match &self.config {
            MailConfig::Smtp { .. } => {
                self.smtp
                    .as_ref()
                    .ok_or_else(ApiError::internal)?
                    .send(message)
                    .await
                    .map_err(|_| {
                        tracing::error!(
                            "authentication email delivery failed; request a new link to retry"
                        );
                        ApiError::new(
                            actix_web::http::StatusCode::SERVICE_UNAVAILABLE,
                            "mail_unavailable",
                            "Email delivery failed. Request a new link to retry.",
                        )
                    })?;
            }
            MailConfig::Local { directory } => {
                let directory = directory.clone();
                let bytes = message.formatted();
                tokio::task::spawn_blocking(move || -> std::io::Result<()> {
                    use std::io::Write;
                    std::fs::create_dir_all(&directory)?;
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    options
                        .open(directory.join(format!("{}.eml", uuid::Uuid::new_v4())))?
                        .write_all(&bytes)
                })
                .await
                .map_err(|_| ApiError::internal())?
                .map_err(|_| ApiError::internal())?;
            }
        }
        Ok(())
    }
}
