//! Correlate server logs with bounded client error diagnostics via a per-request UUID.

use actix_web::{
    Error,
    body::MessageBody,
    dev::{ServiceRequest, ServiceResponse},
    http::header::{HeaderName, HeaderValue},
    middleware::Next,
};
use tracing::Instrument;
use uuid::Uuid;

pub const REQUEST_ID_HEADER: &str = "x-request-id";

pub async fn middleware(
    req: ServiceRequest,
    next: Next<impl MessageBody>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let request_id = Uuid::new_v4().to_string();
    let route = req.match_pattern();
    let span = tracing::info_span!(
        "http_request",
        request_id = %request_id,
        method = %req.method(),
        route = route.as_deref().unwrap_or("unmatched"),
    );
    let mut response = next.call(req).instrument(span).await?;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(REQUEST_ID_HEADER), value);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ApiError;
    use actix_web::{App, HttpResponse, http::StatusCode, middleware::from_fn, test, web};

    #[actix_web::test]
    async fn attaches_distinct_uuid_request_ids_to_success_and_error_responses() {
        async fn ok_handler() -> HttpResponse {
            HttpResponse::Ok().finish()
        }
        async fn fail_handler() -> crate::error::Result<HttpResponse> {
            Err(ApiError::internal())
        }

        let app = test::init_service(
            App::new().service(
                web::scope("/api")
                    .wrap(from_fn(middleware))
                    .route("/ok", web::get().to(ok_handler))
                    .route("/fail", web::get().to(fail_handler)),
            ),
        )
        .await;

        let ok =
            test::call_service(&app, test::TestRequest::get().uri("/api/ok").to_request()).await;
        assert_eq!(ok.status(), StatusCode::OK);
        let ok_id = ok
            .headers()
            .get(REQUEST_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .expect("x-request-id header must exist on ok response");
        assert!(Uuid::parse_str(ok_id).is_ok());

        let fail =
            test::call_service(&app, test::TestRequest::get().uri("/api/fail").to_request()).await;
        assert_eq!(fail.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let fail_id = fail
            .headers()
            .get(REQUEST_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .expect("x-request-id header must exist on error response");
        assert!(Uuid::parse_str(fail_id).is_ok());
        assert_ne!(ok_id, fail_id);
    }
}
