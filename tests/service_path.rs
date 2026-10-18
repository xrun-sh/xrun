//! Explicit service PATH configuration and remote PATH discovery.
mod common;
use anyhow::Result;
use common::{execution::update_target_config, *};
use xrun::testing::config::{self, DaemonConfig};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn info_reports_the_configured_target_execution_path() -> Result<()> {
    let lab = Lab::new().await?;
    let expected = lab
        .root
        .path()
        .join("toolchain")
        .to_string_lossy()
        .into_owned();
    update_target_config(&lab, |cfg| {
        cfg.env.insert("PATH".into(), expected.clone());
    })?;
    let info = json(cli(&lab.source, &["target1", "info", "--json"]).await);
    assert_eq!(info["execution_path"], expected);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn join_copies_shell_path_only_with_explicit_opt_in() -> Result<()> {
    let lab = Lab::new().await?;
    let toolchain = lab.root.path().join("toolchain with spaces");
    std::fs::create_dir(&toolchain)?;
    let expected = std::env::join_paths([&toolchain])?
        .to_string_lossy()
        .into_owned();
    for (name, capture) in [("pathdefault", false), ("pathcopy", true)] {
        let home = lab.root.path().join(name);
        std::fs::create_dir(&home)?;
        let invitation = json(cli(&lab.source, &["invite", "--allow", "--json"]).await);
        let mut args = vec![
            "join",
            invitation["link"].as_str().unwrap(),
            "--name",
            name,
            "--no-daemon",
            "--allow-manager",
        ];
        if capture {
            args.push("--path-from-shell");
        }
        ok(command(&home, &args)
            .env("PATH", &expected)
            .output()
            .await?);
        let cfg: DaemonConfig = config::read(&home.join(".xrun/daemon.toml"))?;
        if capture {
            assert_eq!(cfg.env["PATH"], expected);
        } else {
            assert!(!cfg.env.contains_key("PATH"));
        }
    }
    Ok(())
}
