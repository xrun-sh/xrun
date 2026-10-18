//! Deadline-bounded waits with truthful snapshots and best-effort output.
use super::{logs::*, support::*};
use crate::{config::Identity, error::ErrorCode, protocol::*};
use anyhow::{Result, bail};
use serde::Serialize;
use std::time::Duration;
use tokio::time::Instant;

const SNAPSHOT_GRACE: Duration = Duration::from_secs(2);

#[derive(Serialize)]
struct WaitResult {
    job: Option<Job>,
    logs: Vec<LogEvent>,
    logs_error: Option<String>,
    wait_timed_out: bool,
    elapsed_ms: Option<u64>,
    snapshot_error: Option<Data>,
}

async fn read_tail(
    id: &Identity,
    target: &str,
    job: &Job,
    tail: usize,
    deadline: Option<Instant>,
) -> (Vec<LogEvent>, Option<String>) {
    if tail == 0 || job.kind() != JobKind::Exec {
        return (vec![], None);
    }
    let read = collect_logs(id, target, &job.job_id, 0, tail);
    let result = if let Some(deadline) = deadline {
        match tokio::time::timeout_at(deadline, read).await {
            Ok(result) => result,
            Err(_) => Err(ErrorCode::WaitTimeout
                .error("reading task output timed out")
                .into()),
        }
    } else {
        read.await
    };
    match result {
        Ok((events, state)) => (events, log_error(&state)),
        Err(error) => (vec![], Some(error.to_string())),
    }
}

async fn snapshot(id: &Identity, target: &str, job: &str) -> Result<Job> {
    match request(
        id,
        target,
        Request::Jobs {
            id: Some(job.into()),
            running: false,
            request_id: None,
            limit: 1,
            offset: 0,
        },
    )
    .await?
    {
        Data::Job { job } => Ok(job),
        _ => bail!(ErrorCode::InvalidMessage.error("expected task snapshot")),
    }
}

pub(super) async fn run(
    id: &Identity,
    target: &str,
    job: &str,
    timeout: u64,
    tail: usize,
    json: bool,
) -> Result<i32> {
    let deadline = (timeout != 0).then(|| Instant::now() + Duration::from_secs(timeout));
    let (result, timed_out) = if let Some(deadline) = deadline {
        match tokio::time::timeout_at(deadline, wait(id, target, job)).await {
            Ok(result) => (result, false),
            Err(_) => {
                let grace = Instant::now() + SNAPSHOT_GRACE;
                let result = tokio::time::timeout_at(grace, snapshot(id, target, job))
                    .await
                    .unwrap_or_else(|_| {
                        Err(ErrorCode::WaitTimeout
                            .error("task snapshot unavailable within two seconds")
                            .into())
                    });
                return finish(id, target, result, true, tail, Some(grace), json).await;
            }
        }
    } else {
        (wait(id, target, job).await, false)
    };
    finish(id, target, result, timed_out, tail, deadline, json).await
}

async fn finish(
    id: &Identity,
    target: &str,
    result: Result<Job>,
    timed_out: bool,
    tail: usize,
    deadline: Option<Instant>,
    json: bool,
) -> Result<i32> {
    let job = match result {
        Ok(job) => job,
        Err(error) => {
            if timed_out {
                let value = WaitResult {
                    job: None,
                    logs: vec![],
                    logs_error: None,
                    wait_timed_out: true,
                    elapsed_ms: None,
                    snapshot_error: Some(Data::error(&error)),
                };
                if json {
                    println!("{}", serde_json::to_string(&value)?);
                }
                diagnostic(
                    json,
                    &ErrorCode::WaitTimeout
                        .error("wait expired; the current task state could not be confirmed")
                        .into(),
                );
                return Ok(75);
            }
            diagnostic(json, &error);
            return Ok(
                if crate::net::explicit(&error)
                    && !crate::error::is(&error, ErrorCode::DeviceOffline)
                {
                    125
                } else {
                    75
                },
            );
        }
    };
    let (logs, logs_error) = read_tail(id, target, &job, tail, deadline).await;
    let elapsed = job
        .finished_at_ms
        .unwrap_or_else(now_ms)
        .saturating_sub(job.started_at_ms.unwrap_or(job.created_at_ms))
        .max(0) as u64;
    let code = if job.state.terminal() {
        job_code(&job)
    } else {
        75
    };
    let value = WaitResult {
        job: Some(job.clone()),
        logs,
        logs_error,
        wait_timed_out: timed_out,
        elapsed_ms: Some(elapsed),
        snapshot_error: None,
    };
    if json {
        println!("{}", serde_json::to_string(&value)?);
    } else {
        output(&value.logs)?;
        if let Some(error) = &value.logs_error {
            eprintln!("[xrun] {error}");
        }
        if timed_out {
            eprintln!(
                "[xrun] task {}: {:?}, {}m{}s elapsed",
                job.job_id,
                job.state,
                elapsed / 60_000,
                (elapsed / 1000) % 60
            );
        }
    }
    job_diagnostic(json, &job);
    if !job.state.terminal() {
        diagnostic(
            json,
            &ErrorCode::WaitTimeout
                .error("wait expired; the returned snapshot is not a terminal result")
                .into(),
        );
    }
    Ok(code)
}
