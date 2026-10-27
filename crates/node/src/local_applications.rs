//! Thin adapter for client-owned local application discovery and launch.

use deskfleet_native::local_applications;
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(string_enum = "camelCase")]
pub enum LocalApplicationKind {
    Editor,
    Terminal,
    FileManager,
}

#[napi(object)]
pub struct LocalApplication {
    pub id: String,
    pub name: String,
    pub kind: LocalApplicationKind,
}

#[napi]
pub async fn scan_local_applications() -> Result<Vec<LocalApplication>> {
    Ok(local_applications::scan_local_applications()
        .await
        .map_err(native_error)?
        .into_iter()
        .map(|application| LocalApplication {
            id: application.id.to_owned(),
            name: application.name.to_owned(),
            kind: match application.kind {
                local_applications::LocalApplicationKind::Editor => LocalApplicationKind::Editor,
                local_applications::LocalApplicationKind::Terminal => {
                    LocalApplicationKind::Terminal
                }
                local_applications::LocalApplicationKind::FileManager => {
                    LocalApplicationKind::FileManager
                }
            },
        })
        .collect())
}

#[napi]
pub async fn open_local_application(application_id: String, directory: String) -> Result<()> {
    local_applications::open_local_application(application_id, directory.into())
        .await
        .map_err(native_error)
}
