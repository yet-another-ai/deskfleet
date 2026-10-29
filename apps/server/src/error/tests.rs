use super::*;
use sea_orm::sqlx::error::{DatabaseError, ErrorKind};
use std::{
    error::Error as StdError,
    fmt,
    io::{self, Write},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
struct LogBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn convert(error: deskfleet_control_store::Error) -> (ApiError, String) {
    let output = LogBuffer::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let response = tracing::subscriber::with_default(subscriber, || ApiError::from(error));
    let logs = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
    (response, logs)
}

async fn assert_internal_response(error: ApiError) {
    let response = error.error_response();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = actix_web::body::to_bytes(response.into_body())
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        json!({"error": {"code": "internal", "message": "server operation failed"}})
    );
}

#[derive(Debug)]
struct DatabaseFailure {
    private_detail: &'static str,
}

impl fmt::Display for DatabaseFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.private_detail)
    }
}

impl StdError for DatabaseFailure {}

impl DatabaseError for DatabaseFailure {
    fn message(&self) -> &str {
        self.private_detail
    }

    fn code(&self) -> Option<Cow<'_, str>> {
        Some("23514".into())
    }

    fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn StdError + Send + Sync + 'static> {
        self
    }

    fn table(&self) -> Option<&str> {
        Some("cp_machines")
    }

    fn constraint(&self) -> Option<&str> {
        Some("cp_machines_name_check")
    }

    fn kind(&self) -> ErrorKind {
        ErrorKind::CheckViolation
    }
}

#[actix_web::test]
async fn database_failures_log_diagnostics_without_row_or_credential_details() {
    let source = SqlxError::Database(Box::new(DatabaseFailure {
        private_detail: "private-row-value postgres://user:private-password@localhost/db",
    }));
    let (error, logs) = convert(DbErr::Query(RuntimeErr::SqlxError(Arc::new(source))).into());
    assert!(logs.contains("storage=\"database\""), "{logs}");
    assert!(logs.contains("phase=\"query\""), "{logs}");
    assert!(logs.contains("sqlstate=\"23514\""), "{logs}");
    assert!(logs.contains("table=\"cp_machines\""), "{logs}");
    assert!(
        logs.contains("constraint=\"cp_machines_name_check\""),
        "{logs}"
    );
    assert!(!logs.contains("private-"), "{logs}");
    assert_internal_response(error).await;
}

#[actix_web::test]
async fn json_failures_log_schema_diagnostics_without_stored_values() {
    #[derive(Debug, serde::Deserialize)]
    struct RequiredRecord {
        #[serde(rename = "schemaVersion")]
        _schema_version: u64,
    }

    let source = serde_json::from_str::<RequiredRecord>("{}").unwrap_err();
    let (error, logs) = convert(source.into());
    assert!(logs.contains("storage=\"json\""), "{logs}");
    assert!(logs.contains("category=Data"), "{logs}");
    assert!(logs.contains("line=1 column=2"), "{logs}");
    assert!(logs.contains("missing_field=\"schemaVersion\""), "{logs}");
    assert_internal_response(error).await;

    let source = serde_json::from_str::<u64>("\"private-record-value\"").unwrap_err();
    assert!(source.to_string().contains("private-record-value"));
    let (error, logs) = convert(source.into());
    assert!(logs.contains("category=Data"), "{logs}");
    assert!(!logs.contains("private-record-value"), "{logs}");
    assert!(!logs.contains("missing_field="), "{logs}");
    assert_internal_response(error).await;
}

#[actix_web::test]
async fn pool_failures_identify_connection_exhaustion_without_driver_text() {
    let (error, logs) = convert(DbErr::ConnectionAcquire(ConnAcquireErr::Timeout).into());
    assert!(logs.contains("phase=\"connection_acquire\""), "{logs}");
    assert!(logs.contains("category=\"pool_timeout\""), "{logs}");
    assert!(!logs.contains("sqlstate="), "{logs}");
    assert_internal_response(error).await;
}
