use crate::{
    AppState,
    error::{ApiError, Result},
};
use actix_web::{HttpRequest, HttpResponse, web};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;

pub(super) async fn receive(
    req: HttpRequest,
    s: web::Data<AppState>,
    body: web::Bytes,
) -> Result<HttpResponse> {
    if !s.billing.enabled() {
        return Err(super::billing_error(
            "payments_unavailable",
            "Payments are not configured",
        ));
    }
    if body.len() > 256 * 1024 {
        return Err(ApiError::bad("webhook body too large"));
    }
    let secret = s
        .billing
        .config
        .stripe_webhook_secret
        .as_deref()
        .ok_or_else(ApiError::internal)?;
    let header = req
        .headers()
        .get("Stripe-Signature")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::bad("invalid webhook signature"))?;
    verify_signature(
        secret,
        header,
        &body,
        deskfleet_control_store::now_ms() / 1000,
    )?;
    let event: Value =
        serde_json::from_slice(&body).map_err(|_| ApiError::bad("invalid payment event"))?;
    let event_type = event["type"]
        .as_str()
        .ok_or_else(|| ApiError::bad("invalid payment event"))?;
    if !supported(event_type) {
        return Ok(HttpResponse::NoContent().finish());
    }
    let live = s
        .billing
        .config
        .stripe_secret_key
        .as_deref()
        .is_some_and(|key| key.starts_with("sk_live_") || key.starts_with("rk_live_"));
    if event["livemode"].as_bool() != Some(live) {
        return Err(ApiError::bad("payment event mode mismatch"));
    }
    let id = event["id"]
        .as_str()
        .ok_or_else(|| ApiError::bad("invalid payment event"))?;
    let object = event["data"]["object"]["id"]
        .as_str()
        .ok_or_else(|| ApiError::bad("invalid payment event"))?;
    s.store
        .receive_payment_event(id, event_type, object)
        .await?;
    Ok(HttpResponse::Ok().finish())
}
fn supported(event: &str) -> bool {
    matches!(
        event,
        "checkout.session.completed"
            | "checkout.session.async_payment_succeeded"
            | "customer.subscription.created"
            | "customer.subscription.updated"
            | "customer.subscription.deleted"
            | "customer.subscription.paused"
            | "customer.subscription.resumed"
            | "customer.subscription.pending_update_applied"
            | "invoice.paid"
            | "invoice.payment_succeeded"
            | "invoice.payment_failed"
    )
}
fn verify_signature(secret: &str, header: &str, body: &[u8], now: i64) -> Result<()> {
    let fields: Vec<(&str, &str)> = header
        .split(',')
        .filter_map(|part| part.trim().split_once('='))
        .collect();
    let timestamp = fields
        .iter()
        .find(|(key, _)| *key == "t")
        .and_then(|(_, value)| value.parse::<i64>().ok())
        .ok_or_else(|| ApiError::bad("invalid webhook signature"))?;
    if now.abs_diff(timestamp) > 300 {
        return Err(ApiError::bad("expired webhook signature"));
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| ApiError::internal())?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    let verified = fields
        .iter()
        .filter(|(key, _)| *key == "v1")
        .any(|(_, signature)| {
            if signature.len() != 64 {
                return false;
            }
            let bytes: Option<Vec<u8>> = signature
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| {
                    let high = (pair[0] as char).to_digit(16)?;
                    let low = (pair[1] as char).to_digit(16)?;
                    Some((high * 16 + low) as u8)
                })
                .collect();
            bytes.is_some_and(|bytes| mac.clone().verify_slice(&bytes).is_ok())
        });
    if verified {
        Ok(())
    } else {
        Err(ApiError::bad("invalid webhook signature"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_binds_raw_bytes_and_time_and_allows_rotated_signatures() {
        let body = br#"{"id":"evt"}"#;
        let mut mac = Hmac::<Sha256>::new_from_slice(b"secret").unwrap();
        mac.update(b"1000.");
        mac.update(body);
        let signature: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect();
        let header = format!("t=1000,v1=wrong,v1={signature}");
        assert!(verify_signature("secret", &header, body, 1000).is_ok());
        assert!(verify_signature("secret", &header, b"changed", 1000).is_err());
        assert!(verify_signature("secret", &header, body, 1301).is_err());
    }
}
