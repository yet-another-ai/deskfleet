//! Search read models derived from synchronized machine records.
mod projection;
mod schedules;

pub(crate) use projection::{backfill, project_history, terminal_sequence};

use crate::{ControlStore, Error, Result, policies::TeamAction, resource_id, sql};
use sea_orm::ConnectionTrait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(super) const BLOCK_CHARS: usize = 4096;
pub(super) const QUERY_CHARS: usize = 256;
const OVERLAP_CHARS: usize = QUERY_CHARS - 1;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    priority: i16,
    updated_at: String,
    kind: String,
    machine_id: i64,
    resource_id: String,
}

impl ControlStore {
    /// Search one Team's active conversations and synchronized schedules.
    ///
    /// # Errors
    /// Rejects nonmembers, invalid queries/cursors, and database failures.
    #[allow(clippy::too_many_arguments)]
    pub async fn search(
        &self,
        user_id: &str,
        team_id: &str,
        query: &str,
        kind: &str,
        cursor: Option<&str>,
        limit: u32,
    ) -> Result<Value> {
        self.authorize_team(user_id, team_id, TeamAction::Read)
            .await?;
        let query = query.trim();
        if query.is_empty() || query.contains('\0') || query.chars().count() > QUERY_CHARS {
            return Err(Error::Invalid(
                "search query must contain 1 to 256 characters",
            ));
        }
        if !matches!(kind, "all" | "chat" | "schedule") || !(1..=100).contains(&limit) {
            return Err(Error::Invalid("invalid search kind or limit"));
        }
        let cursor: Option<Cursor> = cursor
            .map(|value| {
                serde_json::from_str(value).map_err(|_| Error::Invalid("invalid search cursor"))
            })
            .transpose()?;
        let cursor = cursor.as_ref().map(serde_json::to_value).transpose()?;
        let pattern = format!("%{}%", escape_like(query));
        let mut rows = self
            .db
            .query_all_raw(sql(
                include_str!("query.sql"),
                vec![
                    resource_id(team_id)?.into(),
                    user_id.into(),
                    kind.into(),
                    pattern.into(),
                    cursor.into(),
                    i64::from(limit + 1).into(),
                    query.into(),
                ],
            ))
            .await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last()
                .map(|row| {
                    let cursor: Value = row.try_get("", "cursor")?;
                    Ok::<_, Error>(serde_json::to_string(&cursor)?)
                })
                .transpose()?
        } else {
            None
        };
        let results = rows
            .into_iter()
            .map(|row| row.try_get::<Value>("", "result"))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut response = json!({"results": results});
        if let Some(next) = next {
            response["nextCursor"] = next.into();
        }
        Ok(response)
    }
}

fn escape_like(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Bound both stored text and later updates, retaining enough overlap for every
/// accepted literal query to match across a block boundary.
pub(super) fn blocks(text: &str) -> Vec<String> {
    let chars: Vec<_> = text.chars().collect();
    let mut result = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + BLOCK_CHARS).min(chars.len());
        result.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start = end - OVERLAP_CHARS;
    }
    result
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn write_document(
    db: &impl ConnectionTrait,
    machine: i64,
    kind: &str,
    resource: &str,
    entry: &str,
    block: i64,
    priority: i16,
    content: &str,
) -> Result<()> {
    db.execute_raw(sql(
        "INSERT INTO cp_search_documents(machine_id,kind,resource_id,entry_id,block_no,priority,content)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(machine_id,kind,resource_id,entry_id,block_no) DO UPDATE
         SET content=excluded.content WHERE cp_search_documents.content IS DISTINCT FROM excluded.content",
        vec![machine.into(),kind.into(),resource.into(),entry.into(),block.into(),priority.into(),content.into()],
    )).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_like_metacharacters_are_escaped() {
        assert_eq!(escape_like(r"100%_a\b"), r"100\%\_a\\b");
    }

    #[test]
    fn unicode_blocks_preserve_every_maximum_length_boundary_match() {
        let text = format!(
            "{}{}{}",
            "中".repeat(4000),
            "文".repeat(256),
            "末".repeat(4000)
        );
        let chunks = blocks(&text);
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.chars().count() <= BLOCK_CHARS)
        );
        let query: String = text.chars().skip(4000).take(QUERY_CHARS).collect();
        assert!(chunks.iter().any(|chunk| chunk.contains(&query)));
        assert_eq!(blocks(""), Vec::<String>::new());
    }
}
