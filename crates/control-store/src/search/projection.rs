use std::collections::HashMap;

use sea_orm::ConnectionTrait;
use serde_json::Value;

use super::{BLOCK_CHARS, OVERLAP_CHARS, blocks, write_document};
use crate::{Result, one, sql};

const PAGE_SIZE: i64 = 200;

fn terminal(state: Option<&str>) -> bool {
    matches!(
        state,
        Some("completed" | "cancelled" | "interrupted" | "failed")
    )
}

pub(crate) fn terminal_sequence(events: &[Value]) -> i64 {
    events
        .iter()
        .filter(|event| event["kind"] == "turn" && terminal(event["payload"]["state"].as_str()))
        .filter_map(|event| event["seq"].as_str()?.parse::<i64>().ok())
        .max()
        .unwrap_or(0)
}

/// The owning history transaction already locks the Session. Only a terminal
/// event inside its contiguous watermark, or a fully received idle snapshot,
/// makes assistant text searchable. Streaming batches never read old bodies.
pub(crate) async fn project_history(
    db: &impl ConnectionTrait,
    machine: i64,
    session: &str,
    snapshot: Option<&Value>,
    watermark: i64,
    terminal_seq: i64,
) -> Result<()> {
    db.execute_raw(sql(
        "INSERT INTO cp_search_progress(machine_id,session_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        vec![machine.into(),session.into()],
    )).await?;
    if let Some(snapshot) = snapshot {
        if let Some(title) = snapshot.pointer("/session/title").and_then(Value::as_str) {
            write_document(db, machine, "chat", session, "$title", 0, 0, title).await?;
        }
        let idle = snapshot["turns"].as_array().is_none_or(|turns| {
            turns.iter().rev().all(|turn| {
                !matches!(
                    turn["state"].as_str(),
                    Some("starting" | "running" | "cancelling")
                )
            })
        });
        let idle_seq = if idle {
            snapshot
                .pointer("/session/lastEventSeq")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
        } else {
            0
        };
        db.execute_raw(sql(
            "UPDATE cp_search_progress SET snapshot_idle_seq=$3 WHERE machine_id=$1 AND session_id=$2 AND snapshot_idle_seq<$3",
            vec![machine.into(),session.into(),idle_seq.into()],
        )).await?;
    }
    let row = one(db,
        "SELECT indexed_seq,stable_seq,snapshot_idle_seq,previous_key,previous_turn FROM cp_search_progress WHERE machine_id=$1 AND session_id=$2",
        vec![machine.into(),session.into()],
    ).await?;
    let mut cursor: i64 = row.try_get("", "indexed_seq")?;
    let idle_seq: i64 = row.try_get("", "snapshot_idle_seq")?;
    let stable = row
        .try_get::<i64>("", "stable_seq")?
        .max(terminal_seq)
        .max(if idle_seq <= watermark { idle_seq } else { 0 });
    if stable <= cursor {
        return Ok(());
    }
    let mut previous: Option<String> = row.try_get("", "previous_key")?;
    let mut previous_turn: Option<String> = row.try_get("", "previous_turn")?;
    while cursor < stable {
        let rows = db.query_all_raw(sql(
            "SELECT seq,record FROM cp_events WHERE machine_id=$1 AND session_id=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT $5",
            vec![machine.into(),session.into(),cursor.into(),stable.into(),PAGE_SIZE.into()],
        )).await?;
        if rows.is_empty() {
            break;
        }
        let mut page = Projector {
            db,
            machine,
            session,
            entries: HashMap::new(),
            previous,
            previous_turn,
        };
        for row in rows {
            cursor = row.try_get("", "seq")?;
            page.event(&row.try_get::<Value>("", "record")?, cursor)
                .await?;
        }
        page.flush().await?;
        previous = page.previous;
        previous_turn = page.previous_turn;
    }
    db.execute_raw(sql(
        "UPDATE cp_search_progress SET indexed_seq=$3,stable_seq=$4,previous_key=$5,previous_turn=$6 WHERE machine_id=$1 AND session_id=$2",
        vec![machine.into(),session.into(),cursor.into(),stable.into(),previous.into(),previous_turn.into()],
    )).await?;
    Ok(())
}

struct Entry {
    id: String,
    tail: String,
    next_block: i64,
    dirty: bool,
}

struct Projector<'a, C> {
    db: &'a C,
    machine: i64,
    session: &'a str,
    entries: HashMap<String, Entry>,
    previous: Option<String>,
    previous_turn: Option<String>,
}

impl<C: ConnectionTrait> Projector<'_, C> {
    async fn entry(&mut self, key: &str, id: &str) -> Result<bool> {
        if self.entries.contains_key(key) {
            return Ok(false);
        }
        let row = self.db.query_one_raw(sql(
            "SELECT entry_id,tail,next_block FROM cp_search_entries WHERE machine_id=$1 AND session_id=$2 AND entry_key=$3",
            vec![self.machine.into(),self.session.into(),key.into()],
        )).await?;
        let created = row.is_none();
        let entry = if let Some(row) = row {
            Entry {
                id: row.try_get("", "entry_id")?,
                tail: row.try_get("", "tail")?,
                next_block: row.try_get("", "next_block")?,
                dirty: false,
            }
        } else {
            Entry {
                id: id.to_owned(),
                tail: String::new(),
                next_block: 0,
                dirty: true,
            }
        };
        self.entries.insert(key.to_owned(), entry);
        Ok(created)
    }

    async fn marker(&mut self, key: &str, id: &str) -> Result<()> {
        if self.entry(key, id).await? {
            self.previous = None;
            self.previous_turn = None;
        }
        Ok(())
    }

    async fn append(&mut self, key: &str, text: &str) -> Result<()> {
        let entry = self.entries.get_mut(key).expect("entry was loaded");
        let chars: Vec<_> = entry.tail.chars().chain(text.chars()).collect();
        let mut start = 0;
        while chars.len() - start >= BLOCK_CHARS {
            let end = start + BLOCK_CHARS;
            let content: String = chars[start..end].iter().collect();
            write_document(
                self.db,
                self.machine,
                "chat",
                self.session,
                &entry.id,
                entry.next_block,
                1,
                &content,
            )
            .await?;
            entry.next_block += 1;
            start = end - OVERLAP_CHARS;
        }
        entry.tail = chars[start..].iter().collect();
        entry.dirty = true;
        Ok(())
    }

    async fn event(&mut self, event: &Value, seq: i64) -> Result<()> {
        let payload = &event["payload"];
        match event["kind"].as_str() {
            Some("input") => {
                let Some(id) = payload["id"].as_str() else {
                    return Ok(());
                };
                if !matches!(payload["state"].as_str(), Some("dispatching" | "delivered")) {
                    return Ok(());
                }
                let key = format!("input-{id}");
                self.marker(&key, &key).await?;
                if payload["state"] == "delivered" && self.entries[&key].next_block == 0 {
                    let content = text_content(&payload["content"]);
                    let chunks = blocks(&content);
                    for (block, content) in chunks.iter().enumerate() {
                        write_document(
                            self.db,
                            self.machine,
                            "chat",
                            self.session,
                            &key,
                            block as i64,
                            1,
                            content,
                        )
                        .await?;
                    }
                    let entry = self.entries.get_mut(&key).expect("input marker was loaded");
                    entry.next_block = chunks.len() as i64;
                    entry.dirty = true;
                }
            }
            Some("turn") if terminal(payload["state"].as_str()) => {
                self.previous = None;
                self.previous_turn = None;
            }
            Some("elicitation") => {
                if let Some(id) = payload["id"].as_str() {
                    let key = format!("elicitation-{id}");
                    self.marker(&key, &key).await?;
                }
            }
            Some("permission") => {
                if let Some(id) = payload
                    .pointer("/request/toolCall/toolCallId")
                    .and_then(Value::as_str)
                {
                    let key = format!("tool-{}:{id}", payload["runGeneration"]);
                    self.marker(&key, &key).await?;
                }
            }
            Some("acp") => self.update(event, seq).await?,
            _ => {}
        }
        Ok(())
    }

    async fn update(&mut self, event: &Value, seq: i64) -> Result<()> {
        let update = &event["payload"]["update"];
        let generation = event["runGeneration"].as_i64().unwrap_or(0);
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk" | "agent_thought_chunk") => {
                if !update["content"]["type"].is_string() {
                    return Ok(());
                }
                let thought = update["sessionUpdate"] == "agent_thought_chunk";
                let role = if thought { "thought" } else { "assistant" };
                let explicit = update["messageId"]
                    .as_str()
                    .or_else(|| {
                        update
                            .pointer("/_meta/deskfleet/messageId")
                            .and_then(Value::as_str)
                    })
                    .filter(|id| !id.is_empty());
                if thought && explicit.is_none() {
                    self.previous = None;
                    self.previous_turn = None;
                    return Ok(());
                }
                let turn = event["turnId"].as_str().map(str::to_owned);
                let key = explicit
                    .map(|id| format!("named:{generation}:{role}:{id}"))
                    .or_else(|| {
                        (!thought && self.previous_turn == turn)
                            .then(|| self.previous.clone())
                            .flatten()
                    })
                    .unwrap_or_else(|| format!("{role}-{seq}"));
                let id = format!("message-{seq}");
                if self.entry(&key, &id).await? {
                    self.previous = (!thought).then(|| key.clone());
                    self.previous_turn = turn;
                }
                if !thought {
                    let text = if update["content"]["type"] == "text" {
                        update["content"]["text"].as_str().unwrap_or("")
                    } else {
                        "\n"
                    };
                    self.append(&key, text).await?;
                }
            }
            Some("tool_call" | "tool_call_update") => {
                if let Some(id) = update["toolCallId"].as_str() {
                    let key = format!("tool-{generation}:{id}");
                    self.marker(&key, &key).await?;
                }
            }
            Some("plan") if update["entries"].is_array() => {
                let key = format!(
                    "plan-{}",
                    event["turnId"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("run-{generation}"))
                );
                self.marker(&key, &key).await?;
            }
            _ => {}
        }
        Ok(())
    }

    async fn flush(&self) -> Result<()> {
        for (key, entry) in &self.entries {
            if !entry.dirty {
                continue;
            }
            if !entry.tail.is_empty() {
                write_document(
                    self.db,
                    self.machine,
                    "chat",
                    self.session,
                    &entry.id,
                    entry.next_block,
                    1,
                    &entry.tail,
                )
                .await?;
            }
            self.db.execute_raw(sql(
                "INSERT INTO cp_search_entries(machine_id,session_id,entry_key,entry_id,tail,next_block) VALUES($1,$2,$3,$4,$5,$6)
                 ON CONFLICT(machine_id,session_id,entry_key) DO UPDATE SET tail=excluded.tail,next_block=excluded.next_block",
                vec![self.machine.into(),self.session.into(),key.as_str().into(),entry.id.as_str().into(),entry.tail.as_str().into(),entry.next_block.into()],
            )).await?;
        }
        Ok(())
    }
}

fn text_content(content: &Value) -> String {
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    (block["type"] == "text")
                        .then(|| block["text"].as_str())
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// One migration pass, paged by the existing Session and event primary keys.
/// No query-time backfill and no complete transcript materialization.
pub(crate) async fn backfill(db: &impl ConnectionTrait) -> Result<()> {
    let mut machine = 0_i64;
    let mut session = String::new();
    loop {
        let rows = db.query_all_raw(sql(
            "SELECT machine_id,session_id FROM cp_sessions WHERE (machine_id,session_id)>($1,$2) ORDER BY machine_id,session_id LIMIT 100",
            vec![machine.into(),session.as_str().into()],
        )).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            machine = row.try_get("", "machine_id")?;
            session = row.try_get("", "session_id")?;
            let row = one(db,
                "SELECT snapshot,event_seq FROM cp_sessions WHERE machine_id=$1 AND session_id=$2 FOR UPDATE",
                vec![machine.into(),session.as_str().into()],
            ).await?;
            let snapshot: Value = row.try_get("", "snapshot")?;
            let watermark: i64 = row.try_get("", "event_seq")?;
            let terminal_seq: i64 = one(db,
                "SELECT COALESCE(max(seq),0) AS seq FROM cp_events WHERE machine_id=$1 AND session_id=$2 AND seq<=$3 AND record->>'kind'='turn' AND record#>>'{payload,state}' IN ('completed','cancelled','interrupted','failed')",
                vec![machine.into(),session.as_str().into(),watermark.into()],
            ).await?.try_get("","seq")?;
            project_history(
                db,
                machine,
                &session,
                Some(&snapshot),
                watermark,
                terminal_seq,
            )
            .await?;
        }
    }
    Ok(())
}
