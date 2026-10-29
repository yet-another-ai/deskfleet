use super::{period_at, profile, summary_value};
use crate::{ControlStore, Error, Result, now_ms, one, resource_id, sql};
use sea_orm::ConnectionTrait;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBillingPage {
    pub teams: Vec<Value>,
    pub next_cursor: Option<String>,
}

impl ControlStore {
    /// Return one Team page with a fixed number of SQL round trips.
    pub async fn admin_billing_teams(
        &self,
        user_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<AdminBillingPage> {
        if !self.is_site_admin(user_id).await? {
            return Err(Error::Forbidden);
        }
        let after = cursor.map(resource_id).transpose()?.unwrap_or(0);
        let limit = limit.clamp(1, 100);
        let mut ids = self
            .db
            .query_all_raw(sql(
                "SELECT id FROM cp_teams WHERE id>$1 ORDER BY id LIMIT $2",
                vec![after.into(), ((limit + 1) as i64).into()],
            ))
            .await?
            .into_iter()
            .map(|row| row.try_get::<i64>("", "id"))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = ids.len() > limit;
        ids.truncate(limit);
        let next_cursor = has_more.then(|| ids[limit - 1].to_string());
        if ids.is_empty() {
            return Ok(AdminBillingPage {
                teams: Vec::new(),
                next_cursor,
            });
        }
        let now = now_ms();
        let selected = json!(ids);
        self.db.execute_raw(sql(
            "INSERT INTO cp_billing_profiles(team_id,period_anchor) SELECT t.id,$2 FROM jsonb_array_elements_text($1) p JOIN cp_teams t ON t.id=p.value::bigint ON CONFLICT(team_id) DO NOTHING",
            vec![selected.clone().into(),now.into()],
        )).await?;
        let profiles = self.db.query_all_raw(sql(
            "SELECT b.* FROM jsonb_array_elements_text($1) p JOIN cp_billing_profiles b ON b.team_id=p.value::bigint ORDER BY b.team_id",
            vec![selected.into()],
        )).await?.into_iter().map(profile).collect::<Result<Vec<_>>>()?;
        let periods: Vec<Value> = profiles
            .iter()
            .map(|p| {
                let (start, end) = period_at(p.period_anchor, now);
                json!({"team_id":p.team_id,"start_at":start,"end_at":end})
            })
            .collect();
        let usage = self.db.query_all_raw(sql(
            "SELECT p.team_id,t.name,jsonb_build_object('id',u.id,'name',u.name,'email',u.email) AS owner,(SELECT COUNT(*) FROM cp_session_admissions a JOIN cp_machines m ON m.id=a.machine_id WHERE a.team_id=p.team_id AND a.status<>'released' AND NOT m.revoked) AS sessions,(SELECT COUNT(*) FROM cp_members WHERE team_id=p.team_id) AS members,cp_turn_sent_bytes(p.team_id,p.start_at,p.end_at)::text AS bytes FROM jsonb_to_recordset($1) AS p(team_id bigint,start_at bigint,end_at bigint) JOIN cp_teams t ON t.id=p.team_id JOIN cp_members o ON o.team_id=t.id AND o.role='owner' JOIN cp_users u ON u.id=o.user_id ORDER BY p.team_id",
            vec![json!(periods).into()],
        )).await?;
        let meter = one(
            &self.db,
            "SELECT last_seen_at,gap_since FROM cp_turn_collector WHERE singleton",
            vec![],
        )
        .await?;
        let mut by_id = profiles
            .into_iter()
            .map(|p| (p.team_id.clone(), p))
            .collect::<std::collections::HashMap<_, _>>();
        let mut teams = Vec::with_capacity(usage.len());
        for row in usage {
            let id = row.try_get::<i64>("", "team_id")?.to_string();
            if let Some(p) = by_id.remove(&id) {
                teams.push(json!({"id":id,"name":row.try_get::<String>("", "name")?,"owner":row.try_get::<Value>("", "owner")?,"billing":summary_value(p,&row,&meter,self.hosted,now)?}));
            }
        }
        Ok(AdminBillingPage { teams, next_cursor })
    }
}
