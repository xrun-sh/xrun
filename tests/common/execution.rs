//! Execution fixtures shared by command, concurrency, and wait tests.
use super::Lab;
use anyhow::Result;
use std::path::{Path, PathBuf};
use xrun::testing::config::{self, DaemonConfig};

pub async fn build_execution_fixture(root: &Path) -> Result<PathBuf> {
    let source = root.join("execution-fixture.rs");
    std::fs::write(
        &source,
        r#"
use std::{io::Write, time::{Duration, Instant}};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args[1] == "wait-for-release" {
        println!("ready");
        std::io::stdout().flush().unwrap();
        let deadline = Instant::now() + Duration::from_secs(25);
        while !std::path::Path::new(&args[2]).exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    } else {
        for n in 1..=3 {
            write!(std::io::stdout(), "out{n}\n").unwrap();
            std::io::stdout().flush().unwrap();
            write!(std::io::stderr(), "err{n}\n").unwrap();
            std::io::stderr().flush().unwrap();
        }
    }
}
"#,
    )?;
    let binary = root.join(if cfg!(windows) {
        "execution-fixture.exe"
    } else {
        "execution-fixture"
    });
    let result = tokio::process::Command::new("rustc")
        .arg(source)
        .arg("-o")
        .arg(&binary)
        .output()
        .await?;
    anyhow::ensure!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(binary)
}

pub fn update_target_config(lab: &Lab, change: impl FnOnce(&mut DaemonConfig)) -> Result<()> {
    let path = lab.target.join(".xrun/daemon.toml");
    let mut cfg: DaemonConfig = config::read(&path)?;
    change(&mut cfg);
    config::write(&path, &cfg)
}
