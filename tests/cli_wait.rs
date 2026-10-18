//! CLI wait deadlines, task snapshots, and output tails.
mod common;
use anyhow::Result;
use common::{execution::build_execution_fixture, *};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeout_returns_running_snapshot_and_log_tail() -> Result<()> {
    let lab = Lab::new().await?;
    let binary = build_execution_fixture(lab.root.path()).await?;
    let release = lab.root.path().join("release");
    let accepted = json(
        cli(
            &lab.source,
            &[
                "target1",
                "start",
                "--json",
                "--",
                binary.to_str().unwrap(),
                "wait-for-release",
                release.to_str().unwrap(),
            ],
        )
        .await,
    );
    let id = accepted["job_id"].as_str().unwrap();
    let output = cli(
        &lab.source,
        &["target1", "wait", id, "--timeout", "1", "--json"],
    )
    .await;
    assert_eq!(output.status.code(), Some(75));
    let snapshot: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(snapshot["job"]["job_id"], id);
    assert_eq!(snapshot["job"]["state"], "running");
    assert_eq!(snapshot["wait_timed_out"], true);
    assert!(snapshot["elapsed_ms"].as_u64().unwrap() >= 500);
    assert!(snapshot["snapshot_error"].is_null());
    assert!(!snapshot["logs"].as_array().unwrap().is_empty());
    let error: serde_json::Value = serde_json::from_slice(&output.stderr)?;
    assert_eq!(error["code"], "WAIT_TIMEOUT");
    assert!(error["hint"].is_string());
    std::fs::write(release, b"done")?;
    let finished = json(cli(&lab.source, &["target1", "wait", id, "--json"]).await);
    assert_eq!(finished["job"]["state"], "succeeded");
    assert_eq!(finished["wait_timed_out"], false);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unresponsive_snapshot_returns_unconfirmed_state_within_a_deadline() -> Result<()> {
    use xrun::testing::{crypto, membership::RosterCache, net, protocol::*, secure};
    let mut lab = Lab::new().await?;
    stop_daemon(&lab.source, &mut lab.source_daemon).await?;
    stop_daemon(&lab.target, &mut lab.daemon).await?;
    let id = lab.target_identity.clone();
    let network = id.network.network_id.clone();
    let cache = std::sync::Arc::new(RosterCache::open(&lab.target.join(".xrun/roster.db"))?);
    let roster = cache.load(&network)?;
    let address = roster.roster.relay_addresses[0].clone();
    let tls = crypto::relay_tls_config(&roster.roster.relay_ca_pem)?;
    let mut control =
        relay_socket(Some(&id), &roster, &format!("/networks/{network}/control")).await?;
    let RelayMessage::HelloAck { generation } = control_message(&mut control).await? else {
        anyhow::bail!("expected fixture control generation");
    };
    let (seen, mut observed) = tokio::sync::mpsc::channel(4);
    let server = tokio::spawn(async move {
        let mut handlers = tokio::task::JoinSet::new();
        loop {
            let RelayMessage::Incoming { session_id } = control_message(&mut control).await? else {
                continue;
            };
            let (id, cache, address, tls, network, generation) = (
                id.clone(),
                cache.clone(),
                address.clone(),
                tls.clone(),
                network.clone(),
                generation.clone(),
            );
            let seen = seen.clone();
            handlers.spawn(async move {
                let path = format!(
                    "/networks/{network}/attach/{}/{generation}/{session_id}",
                    id.device_id
                );
                let mut outer = net::websocket_at(&address, &path, tls).await?;
                anyhow::ensure!(matches!(
                    net::receive(&mut outer).await?,
                    RelayMessage::Connected { .. }
                ));
                let (mut ws, cert) = secure::server(outer, &id).await?;
                let cert = cert.ok_or_else(|| anyhow::anyhow!("missing fixture certificate"))?;
                let (_, _, _, purpose) =
                    secure::exchange_server(&mut ws, &cache, &network, &cert).await?;
                let mut ws = secure::operation_socket(ws, &cache, &network, purpose, &id).await?;
                net::send(
                    &mut ws,
                    &Data::Ready {
                        version: VERSION.into(),
                        protocol: ProtocolRange::CURRENT,
                        selected_protocol: PROTOCOL,
                        device_id: id.device_id,
                        db_id: "snapshot-test".into(),
                        default_cwd: "/".into(),
                    },
                )
                .await?;
                let Data::Request { request } = net::receive(&mut ws).await? else {
                    anyhow::bail!("expected fixture request");
                };
                let kind = match request {
                    Request::Wait { .. } => "wait",
                    Request::Jobs { .. } => "snapshot",
                    _ => anyhow::bail!("unexpected fixture operation"),
                };
                seen.send(kind).await?;
                // Keep the authenticated connection open but never answer either query.
                let _ = net::receive::<Data>(&mut ws).await;
                Ok::<_, anyhow::Error>(())
            });
        }
        #[allow(unreachable_code)]
        Ok::<_, anyhow::Error>(())
    });
    let started = std::time::Instant::now();
    let output = cli(
        &lab.source,
        &["target1", "wait", "ABC123", "--timeout", "1", "--json"],
    )
    .await;
    server.abort();
    let _ = server.await;
    assert_eq!(observed.try_recv()?, "wait");
    assert_eq!(observed.try_recv()?, "snapshot");
    assert!(started.elapsed() < std::time::Duration::from_secs(8));
    assert_eq!(output.status.code(), Some(75));
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(result["wait_timed_out"], true);
    assert!(result["job"].is_null());
    assert!(result["elapsed_ms"].is_null());
    assert!(result["snapshot_error"].is_object());
    Ok(())
}
