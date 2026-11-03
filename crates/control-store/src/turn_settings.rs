//! Private installation-wide TURN endpoints and the ICE snapshot of each peer grant.
//! Team-owned TURN servers live in `team_turn`.
use crate::entities::{
    cp_peers as peers, cp_site_admins as admins, cp_site_audit as audit, cp_turn_settings as turn,
};
use crate::{
    ControlStore, Error, Result, now_ms,
    policies::{SiteAction, SitePolicy, authorize},
};
use deskfleet_protocol::control::{IceServer, TurnSettings};
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect, Set, TransactionTrait};
use serde_json::json;

fn settings(row: turn::Model) -> Result<TurnSettings> {
    Ok(TurnSettings {
        urls: serde_json::from_value(row.urls)?,
        allow_team_servers: row.allow_team_servers,
    })
}

pub(crate) fn turn_url(input: &str) -> Result<String> {
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

pub(crate) fn turn_urls(urls: &[String]) -> Result<Vec<String>> {
    urls.iter().map(|value| turn_url(value)).collect()
}

impl ControlStore {
    /// Initialize from deployment configuration only once, including an empty list.
    pub async fn seed_turn_settings(&self, urls: &[String]) -> Result<()> {
        let urls = turn_urls(urls)?;
        turn::Entity::insert(turn::ActiveModel {
            singleton: Set(true),
            urls: Set(json!(urls)),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(turn::Column::Singleton)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&self.db)
        .await?;
        Ok(())
    }
    /// Internal grant generation reads the current list directly from PostgreSQL.
    pub async fn turn_settings(&self) -> Result<TurnSettings> {
        settings(
            turn::Entity::find_by_id(true)
                .one(&self.db)
                .await?
                .ok_or(Error::NotFound)?,
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
        let is_admin = admins::Entity::find_by_id(user_id)
            .lock_shared()
            .one(&tx)
            .await?
            .is_some();
        authorize(&SitePolicy::new(is_admin), SiteAction::UpdateTurnSettings)?;
        let after = TurnSettings {
            urls: turn_urls(&input.urls)?,
            allow_team_servers: input.allow_team_servers,
        };
        let before = settings(
            turn::Entity::find_by_id(true)
                .lock_exclusive()
                .one(&tx)
                .await?
                .ok_or(Error::NotFound)?,
        )?;
        turn::Entity::update_many()
            .col_expr(turn::Column::Urls, Expr::val(json!(after.urls)))
            .col_expr(
                turn::Column::AllowTeamServers,
                Expr::val(after.allow_team_servers),
            )
            .filter(turn::Column::Singleton.eq(true))
            .exec(&tx)
            .await?;
        audit::Entity::insert(audit::ActiveModel {
            actor_user_id: Set(Some(user_id.into())),
            source: Set("user".into()),
            action: Set("turn.settings.update".into()),
            before_value: Set(json!(before)),
            after_value: Set(json!(after)),
            occurred_at: Set(now_ms()),
            ..Default::default()
        })
        .exec_without_returning(&tx)
        .await?;
        tx.commit().await?;
        Ok(after)
    }
    /// Initialize a missing ICE snapshot and return the snapshot that won the write.
    /// Concurrent reconstruction must agree, and an issued empty list stays empty.
    pub async fn save_peer_ice_servers(
        &self,
        peer_id: &str,
        servers: &[IceServer],
    ) -> Result<Vec<IceServer>> {
        let row = peers::Entity::update_many()
            .col_expr(
                peers::Column::IceServers,
                Func::coalesce([
                    Expr::col(peers::Column::IceServers),
                    Expr::val(json!(servers)),
                ])
                .into(),
            )
            .filter(peers::Column::Id.eq(peer_id))
            .exec_with_returning(&self.db)
            .await?
            .into_iter()
            .next()
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_value(
            row.ice_servers
                .expect("COALESCE writes a non-null ICE snapshot"),
        )?)
    }
    /// Offer forwarding uses the issued snapshot even after TURN settings change.
    /// None identifies a legacy grant; Some([]) is an intentionally empty snapshot.
    pub async fn peer_ice_servers(&self, peer_id: &str) -> Result<Option<Vec<IceServer>>> {
        let row = peers::Entity::find_by_id(peer_id)
            .one(&self.db)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(row.ice_servers.map(serde_json::from_value).transpose()?)
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
