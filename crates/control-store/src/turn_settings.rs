//! Private installation-wide TURN endpoints and the ICE snapshot of each peer grant.
use crate::{
    ControlStore, Error, Result, now_ms, one,
    policies::{SiteAction, SitePolicy, authorize},
    sql,
};
use deskfleet_protocol::control::{IceServer, TurnSettings};
use sea_orm::{ConnectionTrait, QueryResult, TransactionTrait};
use serde_json::json;

fn settings(row: &QueryResult) -> Result<TurnSettings> {
    Ok(TurnSettings {
        urls: serde_json::from_value(row.try_get("", "urls")?)?,
    })
}

fn turn_url(input: &str) -> Result<String> {
    let value = input.trim();
    let invalid = || {
        Error::Invalid(
            "TURN URLs must use turn: or turns: with a host, optional port, and optional transport=udp or transport=tcp",
        )
    };
    let (scheme, address) = value.split_once(':').ok_or_else(invalid)?;
    if !scheme.eq_ignore_ascii_case("turn") && !scheme.eq_ignore_ascii_case("turns") {
        return Err(invalid());
    }
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid());
    }
    let authority = if let Some((authority, query)) = address.split_once('?') {
        if !matches!(query, "transport=udp" | "transport=tcp") {
            return Err(invalid());
        }
        authority
    } else {
        address
    };
    // TURN URIs have an authority without the usual // prefix. Reuse the URL
    // parser for host, bracketed IPv6 and port validation without accepting
    // credentials, paths or fragments that the TURN URI syntax does not allow.
    if authority.is_empty() || authority.ends_with(':') || authority.contains(['/', '\\', '@', '#'])
    {
        return Err(invalid());
    }
    let parsed = url::Url::parse(&format!("http://{authority}")).map_err(|_| invalid())?;
    if parsed.host_str().is_none() {
        return Err(invalid());
    }
    Ok(value.to_owned())
}

fn normalized(urls: &[String]) -> Result<TurnSettings> {
    Ok(TurnSettings {
        urls: urls
            .iter()
            .map(|value| turn_url(value))
            .collect::<Result<_>>()?,
    })
}

impl ControlStore {
    /// Initialize from deployment configuration only once, including an empty list.
    pub async fn seed_turn_settings(&self, urls: &[String]) -> Result<()> {
        let settings = normalized(urls)?;
        self.db
            .execute_raw(sql(
                "INSERT INTO cp_turn_settings(singleton, urls) VALUES(TRUE, $1) ON CONFLICT(singleton) DO NOTHING",
                vec![json!(settings.urls).into()],
            ))
            .await?;
        Ok(())
    }

    /// Internal grant generation reads the current list directly from PostgreSQL.
    pub async fn turn_settings(&self) -> Result<TurnSettings> {
        settings(
            &one(
                &self.db,
                "SELECT urls FROM cp_turn_settings WHERE singleton",
                vec![],
            )
            .await?,
        )
    }

    pub async fn read_turn_settings(&self, user_id: &str) -> Result<TurnSettings> {
        authorize(
            &SitePolicy::new(self.is_site_admin(user_id).await?),
            SiteAction::ReadTurnSettings,
        )?;
        self.turn_settings().await
    }

    /// Retain the administrator grant through the audited settings transaction.
    pub async fn update_turn_settings(
        &self,
        user_id: &str,
        input: &TurnSettings,
    ) -> Result<TurnSettings> {
        let tx = self.db.begin().await?;
        let is_admin = tx
            .query_one_raw(sql(
                "SELECT user_id FROM cp_site_admins WHERE user_id=$1 FOR SHARE",
                vec![user_id.into()],
            ))
            .await?
            .is_some();
        authorize(&SitePolicy::new(is_admin), SiteAction::UpdateTurnSettings)?;
        let after = normalized(&input.urls)?;
        let before = settings(
            &one(
                &tx,
                "SELECT urls FROM cp_turn_settings WHERE singleton FOR UPDATE",
                vec![],
            )
            .await?,
        )?;
        tx.execute_raw(sql(
            "UPDATE cp_turn_settings SET urls=$1 WHERE singleton",
            vec![json!(after.urls).into()],
        ))
        .await?;
        tx.execute_raw(sql(
            "INSERT INTO cp_site_audit(actor_user_id, source, action, before_value, after_value, occurred_at) VALUES($1, 'user', 'turn.settings.update', $2, $3, $4)",
            vec![user_id.into(), json!(before).into(), json!(after).into(), now_ms().into()],
        ))
        .await?;
        tx.commit().await?;
        Ok(after)
    }

    /// Save the issued short-lived ICE credentials with their owning peer grant.
    pub async fn save_peer_ice_servers(&self, peer_id: &str, servers: &[IceServer]) -> Result<()> {
        self.db
            .execute_raw(sql(
                "UPDATE cp_peers SET ice_servers=$2 WHERE id=$1",
                vec![peer_id.into(), json!(servers).into()],
            ))
            .await?;
        Ok(())
    }

    /// Offer forwarding uses the issued snapshot even after TURN settings change.
    pub async fn peer_ice_servers(&self, peer_id: &str) -> Result<Vec<IceServer>> {
        let row = one(
            &self.db,
            "SELECT ice_servers FROM cp_peers WHERE id=$1",
            vec![peer_id.into()],
        )
        .await?;
        Ok(serde_json::from_value(row.try_get("", "ice_servers")?)?)
    }
}

#[cfg(test)]
mod tests {
    use super::turn_url;

    #[test]
    fn turn_urls_accept_endpoints_and_preserve_their_spelling() {
        for input in [
            "turn:turn.example.test",
            "turn:turn.example.test:3478?transport=udp",
            "turn:127.0.0.1:3478?transport=tcp",
            "turns:turn.example.test:5349?transport=tcp",
            "turn:[2001:db8::1]:3478?transport=udp",
            "TURNS:relay.example.test",
        ] {
            assert_eq!(turn_url(&format!("  {input} \n")).unwrap(), input);
        }
    }

    #[test]
    fn turn_urls_reject_empty_entries_and_invalid_uri_parts() {
        for input in [
            "",
            " ",
            "turn:",
            "stun:relay.test",
            "https://relay.test",
            "turn://relay.test",
            "turn:user:password@relay.test",
            "turn:relay.test/path",
            "turn:relay.test#fragment",
            "turn:relay.test:",
            "turn:relay.test:65536",
            "turn:relay.test:port",
            "turn:2001:db8::1",
            "turn:relay test",
            "turn:relay\ntest",
            "turn:relay.test\\path",
            "turn:relay.test?transport=sctp",
            "turn:relay.test?transport=udp&extra=true",
            "turn:relay.test?",
            "turn:relay.test?transport=udp#fragment",
        ] {
            assert!(
                turn_url(input).is_err(),
                "accepted invalid TURN URL {input:?}"
            );
        }
    }
}
