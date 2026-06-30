use anyhow::{Context, Result};
use std::{process::Command, thread};

pub(crate) fn spawn_reaped(command: &mut Command, context: &str) -> Result<u32> {
    let mut child = command.spawn().with_context(|| context.to_string())?;
    let pid = child.id();
    thread::Builder::new()
        .name(format!("codex-record-replay-reaper-{pid}"))
        .spawn(move || {
            let _ = child.wait();
        })
        .with_context(|| format!("failed to spawn reaper thread for child process {pid}"))?;
    Ok(pid)
}
