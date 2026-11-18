//! Mobile push notification configuration, endpoints, and APNs/FCM dispatch.
use std::{env, fs, io, sync::Arc};

use actix_web::{HttpRequest, web, web::ServiceConfig};
use armature_push::{
    ApnsConfig, ApnsEnvironment, ApnsProvider, FcmConfig, FcmProvider, Notification, Priority,
    PushError, PushProvider,
};
use deskfleet_control_store::{
    ControlStore, PushChannel, PushSubscriptionInput, PushSubscriptionTarget,
    SessionTaskNotification, TaskNotificationKind,
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::{
    AppState, auth,
    error::{ApiError, Result},
};

pub const DEFAULT_APNS_BUNDLE_ID: &str = "ai.yetanother.deskfleet";

fn invalid_input(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

#[derive(Clone, Debug, Default)]
pub struct PushConfig {
    pub apns: Option<ApnsConfig>,
    pub fcm: Option<FcmConfig>,
}

impl PushConfig {
    pub fn from_env() -> io::Result<Self> {
        let apns = Self::apns_from_values(
            non_empty_env("DESKFLEET_APNS_TEAM_ID"),
            non_empty_env("DESKFLEET_APNS_KEY_ID"),
            read_secret_or_path(
                "DESKFLEET_APNS_PRIVATE_KEY",
                "DESKFLEET_APNS_PRIVATE_KEY_PATH",
            )?,
            non_empty_env("DESKFLEET_APNS_BUNDLE_ID"),
            non_empty_env("DESKFLEET_APNS_SANDBOX"),
        )?;
        let fcm = read_secret_or_path(
            "DESKFLEET_FCM_SERVICE_ACCOUNT_JSON",
            "DESKFLEET_FCM_SERVICE_ACCOUNT_PATH",
        )?
        .map(|raw| {
            FcmConfig::from_service_account_json(&raw)
                .map_err(|e| invalid_input(format!("invalid FCM service account: {e}")))
        })
        .transpose()?;
        Ok(Self { apns, fcm })
    }

    fn apns_from_values(
        team_id: Option<String>,
        key_id: Option<String>,
        private_key: Option<String>,
        bundle_id: Option<String>,
        sandbox: Option<String>,
    ) -> io::Result<Option<ApnsConfig>> {
        if team_id.is_none() && key_id.is_none() && private_key.is_none() {
            return Ok(None);
        }
        let missing = || {
            invalid_input(
                "DESKFLEET_APNS_TEAM_ID, DESKFLEET_APNS_KEY_ID, and DESKFLEET_APNS_PRIVATE_KEY (or _PATH) must all be configured",
            )
        };
        let team_id = team_id.ok_or_else(missing)?;
        let key_id = key_id.ok_or_else(missing)?;
        let private_key = private_key
            .map(|k| k.replace("\\n", "\n"))
            .ok_or_else(missing)?;
        let bundle_id = bundle_id.unwrap_or_else(|| DEFAULT_APNS_BUNDLE_ID.to_owned());
        let is_sandbox = match sandbox.as_deref() {
            None | Some("false" | "0") => false,
            Some("true" | "1") => true,
            Some(other) => {
                return Err(invalid_input(format!(
                    "invalid DESKFLEET_APNS_SANDBOX value {other:?}"
                )));
            }
        };
        let mut config = ApnsConfig::new(team_id, key_id, private_key, bundle_id);
        if is_sandbox {
            config = config.environment(ApnsEnvironment::Development);
        }
        Ok(Some(config))
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn read_secret_or_path(inline_var: &str, path_var: &str) -> io::Result<Option<String>> {
    match (non_empty_env(inline_var), non_empty_env(path_var)) {
        (Some(_), Some(_)) => Err(invalid_input(format!(
            "set either {inline_var} or {path_var}, not both"
        ))),
        (Some(inline), None) => Ok(Some(inline)),
        (None, Some(path)) => {
            let content = fs::read_to_string(&path)
                .map_err(|e| invalid_input(format!("failed to read {path_var} at {path}: {e}")))?;
            let trimmed = content.trim().to_owned();
            if trimmed.is_empty() {
                return Err(invalid_input(format!("{path_var} file {path} is empty")));
            }
            Ok(Some(trimmed))
        }
        (None, None) => Ok(None),
    }
}

#[derive(Clone)]
pub struct PushService {
    apns: Option<Arc<ApnsProvider>>,
    fcm_config: Option<FcmConfig>,
    fcm: Arc<Mutex<Option<Arc<FcmProvider>>>>,
}

impl PushService {
    pub async fn new(config: PushConfig) -> Result<Self> {
        crate::initialize_tls_provider();
        let apns = match config.apns {
            Some(cfg) => {
                Some(Arc::new(ApnsProvider::new(cfg).await.map_err(|e| {
                    ApiError::bad(format!("invalid APNs configuration: {e}"))
                })?))
            }
            None => None,
        };
        Ok(Self {
            apns,
            fcm_config: config.fcm,
            fcm: Arc::new(Mutex::new(None)),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.apns.is_some() || self.fcm_config.is_some()
    }

    async fn fcm_provider(&self) -> std::result::Result<Option<Arc<FcmProvider>>, PushError> {
        let Some(config) = &self.fcm_config else {
            return Ok(None);
        };
        let mut guard = self.fcm.lock().await;
        if let Some(provider) = guard.as_ref() {
            return Ok(Some(Arc::clone(provider)));
        }
        let provider = Arc::new(FcmProvider::new(config.clone()).await?);
        *guard = Some(Arc::clone(&provider));
        Ok(Some(provider))
    }

    pub async fn notify_session_events(
        &self,
        store: &ControlStore,
        team_id: &str,
        machine_id: &str,
        events: Vec<SessionTaskNotification>,
    ) {
        if !self.is_enabled() || events.is_empty() {
            return;
        }
        for event in events {
            let Ok(targets) = store
                .team_push_targets(team_id, event.kind, &event.user_ids)
                .await
            else {
                continue;
            };
            for target in targets {
                self.send_to_target(store, team_id, machine_id, &event, &target)
                    .await;
            }
        }
    }

    async fn send_to_target(
        &self,
        store: &ControlStore,
        team_id: &str,
        machine_id: &str,
        event: &SessionTaskNotification,
        target: &PushSubscriptionTarget,
    ) {
        let notification = build_notification(team_id, machine_id, event, &target.locale);
        let result = match target.channel {
            PushChannel::Apns => match &self.apns {
                Some(apns) => apns.send(&target.token, &notification).await,
                None => return,
            },
            PushChannel::Fcm => match self.fcm_provider().await {
                Ok(Some(fcm)) => fcm.send(&target.token, &notification).await,
                Ok(None) => return,
                Err(error) => Err(error),
            },
        };
        if let Err(error) = result {
            if error.should_remove_device() {
                let _ = store
                    .remove_push_device_token(target.channel, &target.token)
                    .await;
            } else {
                tracing::warn!(%error, channel = target.channel.as_str(), "push delivery failed");
            }
        }
    }
}

fn build_notification(
    team_id: &str,
    machine_id: &str,
    event: &SessionTaskNotification,
    locale: &str,
) -> Notification {
    let (title, kind_key) = match (event.kind, locale) {
        (TaskNotificationKind::TaskCompleted, "zh-cmn-Hans-CN") => ("任务已完成", "taskCompleted"),
        (TaskNotificationKind::TaskNeedsInput, "zh-cmn-Hans-CN") => {
            ("任务需要你回应", "taskNeedsInput")
        }
        (TaskNotificationKind::TaskCompleted, "ja-JP") => ("タスクが完了しました", "taskCompleted"),
        (TaskNotificationKind::TaskNeedsInput, "ja-JP") => {
            ("タスクに入力が必要です", "taskNeedsInput")
        }
        (TaskNotificationKind::TaskCompleted, _) => ("Task completed", "taskCompleted"),
        (TaskNotificationKind::TaskNeedsInput, _) => ("Task needs input", "taskNeedsInput"),
    };
    let body = match (event.title.is_empty(), event.detail.as_deref()) {
        (false, Some(detail)) => format!("{}\n{detail}", event.title),
        (true, Some(detail)) => detail.to_owned(),
        _ => event.title.clone(),
    };
    Notification::new(title, body)
        .sound("default")
        .priority(Priority::High)
        .tag(format!(
            "deskfleet:{team_id}:{machine_id}:{}",
            event.session_id
        ))
        .data("kind", kind_key)
        .data("teamId", team_id)
        .data("machineId", machine_id)
        .data("sessionId", &event.session_id)
}

pub fn configure(config: &mut ServiceConfig) {
    config.service(
        web::scope("/push")
            .route("/subscription", web::put().to(upsert_subscription))
            .route("/subscription", web::delete().to(delete_subscription)),
    );
}

async fn upsert_subscription(
    req: HttpRequest,
    s: web::Data<AppState>,
    body: web::Json<PushSubscriptionInput>,
) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store
        .save_push_subscription(&a.id, &a.user.id, &body)
        .await?;
    Ok(web::Json(json!({})))
}

async fn delete_subscription(req: HttpRequest, s: web::Data<AppState>) -> Result<web::Json<Value>> {
    let a = auth::user(&req, &s).await?;
    s.store.remove_push_subscription(&a.id).await?;
    Ok(web::Json(json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apns_configs_are_optional_and_reject_partial_settings() {
        assert!(
            PushConfig::apns_from_values(None, None, None, None, None)
                .unwrap()
                .is_none()
        );
        assert!(PushConfig::apns_from_values(Some("T".into()), None, None, None, None).is_err());
        let apns = PushConfig::apns_from_values(
            Some("TEAM123".into()),
            Some("KEY123".into()),
            Some("-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----".into()),
            None,
            Some("true".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(apns.bundle_id, DEFAULT_APNS_BUNDLE_ID);
        assert_eq!(apns.environment, ApnsEnvironment::Development);
        assert!(apns.private_key.contains('\n'));
    }
}
