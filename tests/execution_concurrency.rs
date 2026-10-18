//! Command admission limits and queries while capacity is full.
mod common;
use anyhow::Result;
use common::{
    execution::{build_execution_fixture, update_target_config},
    *,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_command_capacity_reports_owned_jobs_and_allows_queries() -> Result<()> {
    let lab = Lab::new().await?;
    let binary = build_execution_fixture(lab.root.path()).await?;
    let release = lab.root.path().join("release");
    update_target_config(&lab, |cfg| cfg.max_concurrent_jobs = 1)?;
    let args = [
        "target1",
        "start",
        "--json",
        "--",
        binary.to_str().unwrap(),
        "wait-for-release",
        release.to_str().unwrap(),
    ];
    let first = json(cli(&lab.source, &args).await);
    let busy = cli(&lab.source, &args).await;
    assert_eq!(busy.status.code(), Some(125));
    let error: serde_json::Value = serde_json::from_slice(&busy.stderr)?;
    assert_eq!(error["code"], "DEVICE_BUSY");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains(first["job_id"].as_str().unwrap())
    );
    assert!(error["hint"].as_str().unwrap().contains("0"));
    assert!(
        cli(&lab.source, &["target1", "jobs", "--running", "--json"])
            .await
            .status
            .success()
    );
    assert!(
        cli(
            &lab.source,
            &[
                "target1",
                "logs",
                first["job_id"].as_str().unwrap(),
                "--json"
            ]
        )
        .await
        .status
        .success()
    );
    std::fs::write(release, b"done")?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn zero_limit_admits_additional_commands_after_configuration_reload() -> Result<()> {
    let lab = Lab::new().await?;
    let binary = build_execution_fixture(lab.root.path()).await?;
    let release = lab.root.path().join("release");
    update_target_config(&lab, |cfg| cfg.max_concurrent_jobs = 1)?;
    let args = [
        "target1",
        "start",
        "--json",
        "--",
        binary.to_str().unwrap(),
        "wait-for-release",
        release.to_str().unwrap(),
    ];
    json(cli(&lab.source, &args).await);
    update_target_config(&lab, |cfg| cfg.max_concurrent_jobs = 0)?;
    for _ in 0..6 {
        json(cli(&lab.source, &args).await);
    }
    let jobs = json(cli(&lab.source, &["target1", "jobs", "--running", "--json"]).await);
    assert_eq!(jobs.as_array().unwrap().len(), 7);
    std::fs::write(release, b"done")?;
    Ok(())
}
