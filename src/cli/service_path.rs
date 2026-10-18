//! Explicit PATH capture and diagnostics using the running service's environment.
use crate::{config, error::ErrorCode};
use anyhow::{Context, Result};
use std::time::Duration;

pub(super) fn configure(from_shell: bool) -> Result<()> {
    if from_shell {
        let path = std::env::var("PATH")
            .context(ErrorCode::InvalidConfig.error("shell PATH is not valid UTF-8"))?;
        config::update_daemon_config(&config::device_dir()?, |cfg| {
            cfg.env.insert("PATH".into(), path);
            Ok(())
        })?;
    }
    Ok(())
}

pub(super) async fn install(json: bool) -> Result<()> {
    crate::service::install("daemon").await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let dir = config::device_dir()?;
    let result = tokio::time::timeout_at(deadline, async {
        loop {
            if let Ok(path) = crate::ipc::execution_path(&dir).await {
                return path;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    let service_path = match result {
        Ok(path) => path,
        Err(_) => {
            let hint = "The service was registered but its PATH could not be read yet. Check xrun <DEVICE> info --json before running toolchains.";
            if json {
                eprintln!(
                    "{}",
                    serde_json::json!({"type":"warning","code":"SERVICE_PATH_UNAVAILABLE","hint":hint})
                );
            } else {
                eprintln!("[xrun] {hint}");
            }
            return Ok(());
        }
    };
    let shell_path = std::env::var("PATH").unwrap_or_default();
    let missing = missing_directories(&shell_path, &service_path);
    if missing.is_empty() {
        return Ok(());
    }
    let suggested_config = toml::to_string(&std::collections::BTreeMap::from([(
        "env",
        std::collections::BTreeMap::from([("PATH", shell_path)]),
    )]))?;
    let config_path = config::network_dir_at(&dir)?.join("daemon.toml");
    let hint = format!(
        concat!(
            "The service does not load your interactive shell PATH. Add the suggested [env].PATH to ",
            "{}, or explicitly run xrun daemon install --path-from-shell.",
        ),
        config_path.display()
    );
    if json {
        eprintln!(
            "{}",
            serde_json::json!({
                "type": "warning",
                "code": "SERVICE_PATH_INCOMPLETE",
                "service_path": service_path,
                "missing_directories": missing,
                "config_path": config_path,
                "suggested_config": suggested_config,
                "hint": hint,
            })
        );
    } else {
        eprintln!(
            "[xrun] {hint}\nMissing directories: {}\n{suggested_config}",
            missing.join(", ")
        );
    }
    Ok(())
}

fn missing_directories(shell: &str, service: &str) -> Vec<String> {
    let normalized = |path: &std::path::Path| {
        let path = path.to_string_lossy().into_owned();
        if cfg!(windows) {
            path.to_ascii_lowercase()
        } else {
            path
        }
    };
    let known = std::env::split_paths(service)
        .map(|path| normalized(&path))
        .collect::<std::collections::HashSet<_>>();
    let mut seen = std::collections::HashSet::new();
    std::env::split_paths(shell)
        .filter(|path| {
            path.is_absolute()
                && path.is_dir()
                && !known.contains(&normalized(path))
                && seen.insert(normalized(path))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}
