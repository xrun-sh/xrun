//! Target-side output capture and request identity.
mod common;
use anyhow::Result;
use common::{execution::build_execution_fixture, *};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn merge_stderr_preserves_interleaved_writes_in_ordinary_execution() -> Result<()> {
    let lab = Lab::new().await?;
    let binary = build_execution_fixture(lab.root.path()).await?;
    let program = binary.to_str().unwrap();
    let separate = cli(
        &lab.source,
        &["target1", "--", program, "interleaved-output"],
    )
    .await;
    assert!(separate.status.success());
    assert_eq!(separate.stdout, b"out1\nout2\nout3\n");
    assert_eq!(separate.stderr, b"err1\nerr2\nerr3\n");
    let merged = cli(
        &lab.source,
        &[
            "target1",
            "--merge-stderr",
            "--",
            program,
            "interleaved-output",
        ],
    )
    .await;
    assert!(
        merged.status.success(),
        "{}",
        String::from_utf8_lossy(&merged.stderr)
    );
    assert_eq!(merged.stdout, b"out1\nerr1\nout2\nerr2\nout3\nerr3\n");
    assert!(merged.stderr.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn merge_stderr_preserves_interleaved_writes_in_streaming_execution() -> Result<()> {
    let lab = Lab::new().await?;
    let binary = build_execution_fixture(lab.root.path()).await?;
    let merged = cli(
        &lab.source,
        &[
            "target1",
            "-i",
            "--merge-stderr",
            "--",
            binary.to_str().unwrap(),
            "interleaved-output",
        ],
    )
    .await;
    assert!(
        merged.status.success(),
        "{}",
        String::from_utf8_lossy(&merged.stderr)
    );
    assert_eq!(merged.stdout, b"out1\nerr1\nout2\nerr2\nout3\nerr3\n");
    assert!(merged.stderr.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn changing_merge_stderr_conflicts_with_the_same_request_id() -> Result<()> {
    let lab = Lab::new().await?;
    let binary = build_execution_fixture(lab.root.path()).await?;
    let program = binary.to_str().unwrap();
    let accepted = json(
        cli(
            &lab.source,
            &[
                "target1",
                "start",
                "--json",
                "--merge-stderr",
                "--request-id",
                "merged-request",
                "--",
                program,
                "interleaved-output",
            ],
        )
        .await,
    );
    assert_eq!(accepted["params"]["merge_stderr"], true);
    let conflict = cli(
        &lab.source,
        &[
            "target1",
            "start",
            "--json",
            "--request-id",
            "merged-request",
            "--",
            program,
            "interleaved-output",
        ],
    )
    .await;
    assert_eq!(conflict.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&conflict.stderr).contains("REQUEST_CONFLICT"));
    Ok(())
}
