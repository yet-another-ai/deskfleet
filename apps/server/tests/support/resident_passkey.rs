//! Test-only resident storage around the real software authenticator. The
//! upstream SoftPasskey signs assertions but cannot discover its own keys.
use serde_json::json;
use webauthn_authenticator_rs::{
    WebauthnAuthenticator, error::WebauthnCError, softpasskey::SoftPasskey,
};
use webauthn_rs::prelude::*;

pub struct ResidentPasskey {
    authenticator: WebauthnAuthenticator<SoftPasskey>,
    credentials: Vec<(String, Base64UrlSafeData, Base64UrlSafeData)>,
}

impl ResidentPasskey {
    pub fn new() -> Self {
        Self {
            authenticator: WebauthnAuthenticator::new(SoftPasskey::new(true)),
            credentials: Vec::new(),
        }
    }

    pub fn do_registration(
        &mut self,
        origin: Url,
        mut options: CreationChallengeResponse,
    ) -> Result<RegisterPublicKeyCredential, WebauthnCError> {
        let selection = options.public_key.authenticator_selection.as_mut().unwrap();
        assert!(selection.require_resident_key);
        assert_eq!(
            serde_json::to_value(selection.resident_key).unwrap(),
            "required"
        );
        // This adapter supplies resident storage; SoftPasskey still generates
        // the key and signs the original RP, challenge, origin and UV flags.
        selection.require_resident_key = false;
        selection.resident_key = None;
        let rp = options.public_key.rp.id.clone();
        let user = options.public_key.user.id.clone();
        let credential = self.authenticator.do_registration(origin, options)?;
        self.credentials.push((rp, user, credential.raw_id.clone()));
        Ok(credential)
    }

    pub fn do_authentication(
        &mut self,
        origin: Url,
        mut options: RequestChallengeResponse,
    ) -> Result<PublicKeyCredential, WebauthnCError> {
        if options.public_key.allow_credentials.is_empty() {
            let (_, _, id) = self
                .credentials
                .iter()
                .find(|(rp, _, _)| rp == &options.public_key.rp_id)
                .ok_or(WebauthnCError::NotSupported)?;
            options.public_key.allow_credentials =
                serde_json::from_value(json!([{"type":"public-key","id":id}])).unwrap();
        }
        let mut credential = self.authenticator.do_authentication(origin, options)?;
        let (_, user, _) = self
            .credentials
            .iter()
            .find(|(_, _, id)| id == &credential.raw_id)
            .ok_or(WebauthnCError::NotSupported)?;
        credential.response.user_handle = Some(user.clone());
        Ok(credential)
    }
}
