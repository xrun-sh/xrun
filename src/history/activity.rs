//! Chronological views of the single authoritative job table.
use super::*;
use crate::attachments::{AttachmentMetadata, AttachmentPreview, Cache};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::types::Value;
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
/// One page of target-local jobs, newest accepted operation first.
pub struct ActivityPage {
    /// Database generation, shared by details and output reads.
    pub db_id: Option<String>,
    /// All business operations in one model.
    pub entries: Vec<Job>,
    /// Titles of the listed scripts whose bodies are still retained, by job ID.
    pub script_titles: BTreeMap<String, String>,
    /// Opaque cursor passed back unchanged.
    pub next_cursor: Option<String>,
}
#[derive(Debug, Serialize)]
/// The script a command ran, as retained on this device.
pub struct ActivityScript {
    /// The retained body, at most 64 KiB, or none once it expired with attachments of
    /// the same age.
    pub text: Option<String>,
    /// Whether the script was longer than its retained body.
    pub truncated: bool,
}
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
/// One search word; the desktop adds devices and kinds whose displayed names contain it.
pub struct SearchTerm {
    /// Matched case-insensitively (ASCII) against IDs, commands, retained scripts, paths
    /// and attachment names.
    pub text: String,
    /// Source devices whose names contain the word.
    #[serde(default)]
    pub devices: Vec<String>,
    /// Operations whose labels contain the word.
    #[serde(default)]
    pub kinds: Vec<JobKind>,
}
const MAX_SEARCH_TERMS: usize = 8;
const MAX_SEARCH_TEXT: usize = 256;
const MAX_SEARCH_DEVICES: usize = 512;
/// The text a search word may match: what the activity list shows, identifiers and
/// retained scripts.
const SEARCH_TEXT: &str = "lower(job_id||' '||source_device_id||' '||
    coalesce(json_extract(params_json,'$.program'),'')||' '||coalesce(json_extract(params_json,'$.args'),'')||' '||
    coalesce(json_extract(params_json,'$.cwd'),'')||' '||coalesce(json_extract(params_json,'$.shell'),'')||' '||
    coalesce(json_extract(params_json,'$.path'),'')||' '||coalesce(json_extract(result_json,'$.path'),'')||' '||
    coalesce('localhost:'||json_extract(params_json,'$.port'),'')||' '||
    coalesce((SELECT group_concat(name,' ') FROM job_attachments WHERE job_attachments.job_id=jobs.job_id),'')||' '||
    coalesce((SELECT body FROM job_scripts WHERE job_scripts.job_id=jobs.job_id),''))";
/// Characters of a script read to find its title.
const TITLE_SCAN: usize = 1024;
/// Longest title shown; longer lines end with an ellipsis.
const TITLE_CHARS: usize = 160;
/// A script is recognized by its first line that is not blank or interpreter setup.
pub(super) fn script_title(head: &str) -> Option<String> {
    let line = head.lines().map(str::trim).find(|line| {
        let lower = line.to_ascii_lowercase();
        !line.is_empty()
            && !line.starts_with("#!")
            && ![
                "set -",
                "@echo off",
                "setlocal",
                "$erroractionpreference",
                "set-strictmode",
            ]
            .iter()
            .any(|setup| lower.starts_with(setup))
    })?;
    let mut title: String = line.chars().take(TITLE_CHARS).collect();
    if title.len() < line.len() {
        title.push('…');
    }
    Some(title)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    db_id: String,
    time: i64,
    job_id: String,
}
/// Read locally accepted jobs without contacting other devices. Every search
/// term must match, through its text, one of its devices or one of its kinds.
pub fn activity(before: Option<&str>, filter: &str, search: &[SearchTerm]) -> Result<ActivityPage> {
    activity_at(
        &config::device_dir()?.join("daemon.db"),
        before,
        filter,
        search,
    )
}
pub(super) fn activity_at(
    path: &Path,
    before: Option<&str>,
    filter: &str,
    search: &[SearchTerm],
) -> Result<ActivityPage> {
    let selected = match filter {
        "all" => "1",
        "running" => "state IN ('accepted','running','interrupted')",
        "failed" => "state IN ('failed','canceled','timed_out','lost')",
        _ => bail!(ErrorCode::InvalidFilter.error("expected all, running or failed")),
    };
    if search.len() > MAX_SEARCH_TERMS
        || search.iter().any(|term| {
            term.text.trim().is_empty()
                || term.text.len() > MAX_SEARCH_TEXT
                || term.devices.len() > MAX_SEARCH_DEVICES
        })
    {
        bail!(ErrorCode::InvalidFilter.error("search terms are empty or too long"));
    }
    let cursor = before
        .map(|value| -> Result<Cursor> {
            if value.len() > 2048 {
                bail!("cursor is too long");
            }
            let cursor: Cursor = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(value)?)?;
            if cursor.job_id.is_empty() || cursor.job_id.len() > 128 || cursor.time < 0 {
                bail!("invalid cursor position");
            }
            Ok(cursor)
        })
        .transpose()
        .map_err(|error| anyhow::anyhow!(ErrorCode::InvalidCursor.error(error.to_string())))?;
    let Some(mut db) = open(path)? else {
        if cursor.is_some() {
            bail!(ErrorCode::DbMissing.error("activity database is no longer available"));
        }
        return Ok(ActivityPage {
            db_id: None,
            entries: vec![],
            script_titles: BTreeMap::new(),
            next_cursor: None,
        });
    };
    let cache = Cache::for_database(path);
    cache.prune_if_due();
    let tx = db.transaction()?;
    let generation = db_id(&tx)?;
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.db_id != generation)
    {
        bail!(
            ErrorCode::DbReset
                .error("activity database has been replaced; return to the newest page")
        );
    }
    let mut values: Vec<Value> = vec![
        cursor.as_ref().map(|cursor| cursor.time).into(),
        cursor.as_ref().map(|cursor| cursor.job_id.clone()).into(),
        ((PAGE_SIZE + 1) as i64).into(),
    ];
    let mut matches = String::new();
    for term in search {
        let first = values.len() + 1;
        matches.push_str(&format!(
            " AND (instr({SEARCH_TEXT},?{first})>0 OR source_device_id IN (SELECT value FROM json_each(?{}))
            OR kind IN (SELECT value FROM json_each(?{})))",
            first + 1,
            first + 2
        ));
        let kinds: Vec<&str> = term.kinds.iter().map(|kind| kind.as_str()).collect();
        values.push(term.text.trim().to_ascii_lowercase().into());
        values.push(serde_json::to_string(&term.devices)?.into());
        values.push(serde_json::to_string(&kinds)?.into());
    }
    let sql = format!(
        "SELECT {},(SELECT substr(body,1,{TITLE_SCAN}) FROM job_scripts WHERE job_scripts.job_id=jobs.job_id)
        AS script_head FROM jobs WHERE {selected} AND (?1 IS NULL OR (created_at_ms,job_id)<(?1,?2)){matches}
        ORDER BY created_at_ms DESC,job_id DESC LIMIT ?3",
        crate::store::JOB_COLUMNS
    );
    let mut statement = tx.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(values))?;
    let mut entries = vec![];
    let mut script_titles = BTreeMap::new();
    let mut more = false;
    while let Some(row) = rows.next()? {
        if entries.len() == PAGE_SIZE {
            more = true;
            break;
        }
        let mut job = crate::store::read_job(row, 0)?;
        job.attachments = crate::attachments::for_job(&tx, &cache, &job.job_id)?;
        let head: Option<String> = row.get("script_head")?;
        if let Some(title) = head.as_deref().and_then(script_title) {
            script_titles.insert(job.job_id.clone(), title);
        }
        entries.push(job);
    }
    let next_cursor = if more {
        entries
            .last()
            .map(|job| {
                serde_json::to_vec(&Cursor {
                    db_id: generation.clone(),
                    time: job.created_at_ms,
                    job_id: job.job_id.clone(),
                })
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            })
            .transpose()?
    } else {
        None
    };
    Ok(ActivityPage {
        db_id: Some(generation),
        entries,
        script_titles,
        next_cursor,
    })
}
/// Read a job snapshot and its attachments within the expected database generation.
pub fn job(expected_db: &str, id: &str) -> Result<Job> {
    job_at(&config::device_dir()?.join("daemon.db"), expected_db, id)
}
pub(super) fn job_at(path: &Path, expected_db: &str, id: &str) -> Result<Job> {
    let Some(mut db) = open(path)? else {
        bail!(ErrorCode::DbMissing.error("activity database is no longer available"));
    };
    let tx = db.transaction()?;
    if db_id(&tx)? != expected_db {
        bail!(ErrorCode::DbReset.error("activity database has been replaced"));
    }
    let mut job = crate::store::jobs::job_at(&tx, id)?
        .context(ErrorCode::JobNotFound.error("unknown local job"))?;
    job.attachments = crate::attachments::for_job(&tx, &Cache::for_database(path), id)?;
    Ok(job)
}
/// Read the script a command ran within the expected database generation.
pub fn script(expected_db: &str, id: &str) -> Result<ActivityScript> {
    script_at(&config::device_dir()?.join("daemon.db"), expected_db, id)
}
pub(super) fn script_at(path: &Path, expected_db: &str, id: &str) -> Result<ActivityScript> {
    let Some(mut db) = open(path)? else {
        bail!(ErrorCode::DbMissing.error("activity database is no longer available"));
    };
    let tx = db.transaction()?;
    if db_id(&tx)? != expected_db {
        bail!(ErrorCode::DbReset.error("activity database has been replaced"));
    }
    let (text, truncated) = tx
        .query_row(
            "SELECT body,truncated FROM job_scripts WHERE job_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .context(ErrorCode::JobNotFound.error("no script for this local job"))?;
    Ok(ActivityScript { text, truncated })
}
pub(super) fn attachment_at(path: &Path, id: &str) -> Result<(Cache, AttachmentMetadata, String)> {
    let db = open(path)?
        .context(ErrorCode::DbMissing.error("activity database is no longer available"))?;
    let (metadata,status)=db.query_row("SELECT attachment_id,name,size_bytes,sha256,created_at_ms,status FROM job_attachments WHERE attachment_id=?1",
        [id],|row|Ok((crate::attachments::read_metadata(row,0)?,row.get::<_,String>(5)?))).optional()?
        .context(ErrorCode::FileNotFound.error("attachment is not recorded in local activity"))?;
    Ok((Cache::for_database(path), metadata, status))
}
/// Preview a recorded copy without reading its original source path.
pub fn attachment(id: &str) -> Result<AttachmentPreview> {
    let (cache, metadata, status) = attachment_at(&config::device_dir()?.join("daemon.db"), id)?;
    let preview = if status == "available" {
        cache.preview(metadata)?
    } else {
        let mut attachment = cache.describe(metadata, cache.retention_days()?, now_ms())?;
        attachment.status = status;
        AttachmentPreview {
            attachment,
            image: None,
            text: None,
        }
    };
    Ok(preview)
}
/// Export a recorded, currently available copy to a chosen destination.
pub fn save_attachment(id: &str, destination: &Path) -> Result<std::path::PathBuf> {
    let (cache, metadata, status) = attachment_at(&config::device_dir()?.join("daemon.db"), id)?;
    if status != "available" {
        bail!(ErrorCode::FileNotFound.error(format!("attachment is {status}")));
    }
    cache.export(metadata, destination)
}
