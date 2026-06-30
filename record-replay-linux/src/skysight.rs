use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

const STATUS_FILE_NAME: &str = "status.json";
const SEGMENTS_DIR_NAME: &str = "segments";
const EXCLUSIONS_FILE_NAME: &str = "exclusions.json";
const STOP_REQUEST_FILE_NAME: &str = "stop-requested";
const DEFAULT_INTERVAL_SECONDS: u64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkysightPaths {
    pub runtime_dir: PathBuf,
    pub segments_dir: PathBuf,
    pub resources_dir: PathBuf,
    pub exclusions_path: PathBuf,
    pub status_path: PathBuf,
    pub stop_request_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkysightStatus {
    pub ok: bool,
    pub schema_version: u32,
    pub state: String,
    pub is_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    pub runtime_dir: PathBuf,
    pub segments_dir: PathBuf,
    pub resources_dir: PathBuf,
    pub exclusions_path: PathBuf,
    pub status_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_segment_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_resources: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkysightExclusion {
    pub kind: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkysightExclusionUpdate {
    pub kind: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkysightStartOptions {
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ExclusionFile {
    schema_version: u32,
    rules: Vec<SkysightExclusion>,
}

impl Default for SkysightStartOptions {
    fn default() -> Self {
        Self {
            interval_seconds: DEFAULT_INTERVAL_SECONDS,
        }
    }
}

impl SkysightPaths {
    pub fn new(runtime_dir: PathBuf, resources_dir: PathBuf) -> Self {
        Self {
            segments_dir: runtime_dir.join(SEGMENTS_DIR_NAME),
            exclusions_path: runtime_dir.join(EXCLUSIONS_FILE_NAME),
            status_path: runtime_dir.join(STATUS_FILE_NAME),
            stop_request_path: runtime_dir.join(STOP_REQUEST_FILE_NAME),
            runtime_dir,
            resources_dir,
        }
    }

    pub fn from_env() -> Self {
        let runtime_dir = env::var_os("CODEX_SKYSIGHT_RUNTIME_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("XDG_RUNTIME_DIR").map(|dir| PathBuf::from(dir).join("skysight"))
            })
            .unwrap_or_else(|| env::temp_dir().join("skysight"));
        let code_home = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
            .unwrap_or_else(|| PathBuf::from(".codex"));
        let resources_dir = env::var_os("CODEX_SKYSIGHT_RESOURCES_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                code_home
                    .join("memories")
                    .join("extensions")
                    .join("skysight")
                    .join("resources")
            });
        let mut paths = Self::new(runtime_dir, resources_dir);
        if let Some(segments_dir) = env::var_os("CODEX_SKYSIGHT_SEGMENTS_DIR") {
            paths.segments_dir = PathBuf::from(segments_dir);
        }
        if let Some(exclusions_path) = env::var_os("CODEX_SKYSIGHT_EXCLUSIONS_PATH") {
            paths.exclusions_path = PathBuf::from(exclusions_path);
        } else if env::var_os("CODEX_SKYSIGHT_RUNTIME_DIR").is_none() {
            paths.exclusions_path = code_home.join("skysight").join(EXCLUSIONS_FILE_NAME);
        }
        paths.status_path = paths.runtime_dir.join(STATUS_FILE_NAME);
        paths.stop_request_path = paths.runtime_dir.join(STOP_REQUEST_FILE_NAME);
        paths
    }
}

pub fn start_skysight(
    paths: &SkysightPaths,
    options: SkysightStartOptions,
) -> Result<SkysightStatus> {
    ensure_layout(paths)?;
    if let Ok(status) = read_status(paths) {
        if status.is_running && status.pid.is_some_and(process_is_alive) {
            return Ok(status);
        }
    }
    let _ = fs::remove_file(&paths.stop_request_path);
    let exe =
        env::current_exe().context("failed to find current executable for Skysight daemon")?;
    let child = Command::new(exe)
        .arg("skysight")
        .arg("daemon")
        .arg("--interval-seconds")
        .arg(options.interval_seconds.to_string())
        .env("CODEX_SKYSIGHT_RUNTIME_DIR", &paths.runtime_dir)
        .env("CODEX_SKYSIGHT_SEGMENTS_DIR", &paths.segments_dir)
        .env("CODEX_SKYSIGHT_RESOURCES_DIR", &paths.resources_dir)
        .env("CODEX_SKYSIGHT_EXCLUSIONS_PATH", &paths.exclusions_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("failed to spawn Skysight daemon")?;
    let pid = child.id();
    drop(child);

    let status = status_value(
        paths,
        "running",
        true,
        Some(pid),
        Some(now_timestamp()),
        None,
        Some("Skysight daemon started".to_string()),
    )?;
    write_status(paths, &status)?;
    Ok(status)
}

pub fn run_skysight_daemon(paths: &SkysightPaths, interval_seconds: u64) -> Result<()> {
    ensure_layout(paths)?;
    let interval = Duration::from_secs(interval_seconds.max(1));
    loop {
        if paths.stop_request_path.exists() {
            let status = status_value(
                paths,
                "stopped",
                false,
                None,
                None,
                Some("stop-requested".to_string()),
                Some("Skysight daemon stopped".to_string()),
            )?;
            write_status(paths, &status)?;
            let _ = fs::remove_file(&paths.stop_request_path);
            return Ok(());
        }
        capture_skysight_snapshot(paths, Some("daemon"))?;
        thread::sleep(interval);
    }
}

pub fn capture_skysight_snapshot(
    paths: &SkysightPaths,
    source: Option<&str>,
) -> Result<SkysightStatus> {
    ensure_layout(paths)?;
    codex_computer_use_linux::diagnostics::hydrate_session_bus_env();
    let diagnostics = codex_computer_use_linux::diagnostics::doctor_report();
    let recorded_at = now_timestamp();
    let segment_path = paths
        .segments_dir
        .join(format!("{}-linux-event.jsonl", timestamp_slug()));
    let event = json!({
        "schema_version": 1,
        "recorded_at": recorded_at,
        "source": source.unwrap_or("snapshot"),
        "kind": "activity_snapshot",
        "diagnostics": diagnostics,
    });
    crate::secure_fs::write_private_file(&segment_path, format!("{}\n", event))?;

    let resource_path = paths
        .resources_dir
        .join(format!("{}-linux-10min-activity.md", timestamp_slug()));
    crate::secure_fs::write_private_file(
        &resource_path,
        format_memory_resource(&recorded_at, source.unwrap_or("snapshot"), &event),
    )?;

    let status = status_value(
        paths,
        "running",
        true,
        active_status_pid(paths),
        None,
        None,
        Some("Skysight snapshot captured".to_string()),
    )?;
    write_status(paths, &status)?;
    Ok(status)
}

pub fn skysight_status(paths: &SkysightPaths) -> Result<SkysightStatus> {
    ensure_parent_dirs(paths)?;
    match read_status(paths) {
        Ok(mut status) => {
            status.recent_resources = recent_resources(paths)?;
            if status.is_running && status.pid.is_some_and(|pid| !process_is_alive(pid)) {
                status.state = "stopped".to_string();
                status.is_running = false;
                status.ended_at = Some(now_timestamp());
                status.end_reason = Some("process-exited".to_string());
                write_status(paths, &status)?;
            }
            Ok(status)
        }
        Err(_) => status_value(
            paths,
            "stopped",
            false,
            None,
            None,
            Some("not-started".to_string()),
            Some("Skysight has not been started".to_string()),
        ),
    }
}

pub fn stop_skysight(paths: &SkysightPaths) -> Result<SkysightStatus> {
    ensure_layout(paths)?;
    if let Ok(status) = read_status(paths) {
        if let Some(pid) = status.pid {
            if process_is_alive(pid) {
                request_process_stop(pid);
            }
        }
    }
    crate::secure_fs::write_private_file(&paths.stop_request_path, "stop\n")?;
    let status = status_value(
        paths,
        "stopped",
        false,
        None,
        None,
        Some("recording_controls_stopped".to_string()),
        Some("Skysight stopped".to_string()),
    )?;
    write_status(paths, &status)?;
    Ok(status)
}

pub fn list_skysight_exclusions(paths: &SkysightPaths) -> Result<Vec<SkysightExclusion>> {
    if !paths.exclusions_path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&paths.exclusions_path)
        .with_context(|| format!("failed to read {}", paths.exclusions_path.display()))?;
    let file: ExclusionFile = serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse {}", paths.exclusions_path.display()))?;
    Ok(file.rules)
}

pub fn update_skysight_exclusion(
    paths: &SkysightPaths,
    update: SkysightExclusionUpdate,
) -> Result<Vec<SkysightExclusion>> {
    ensure_parent_dirs(paths)?;
    let kind = update.kind.trim();
    let value = update.value.trim();
    if kind.is_empty() || value.is_empty() {
        bail!("Skysight exclusion kind and value are required");
    }
    let mut rules = list_skysight_exclusions(paths)?;
    rules.retain(|rule| !(rule.kind == kind && rule.value == value));
    if !update.remove {
        rules.push(SkysightExclusion {
            kind: kind.to_string(),
            value: value.to_string(),
            reason: update.reason,
            updated_at: now_timestamp(),
        });
    }
    rules.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.value.cmp(&b.value)));
    let file = ExclusionFile {
        schema_version: 1,
        rules: rules.clone(),
    };
    crate::secure_fs::write_private_file(
        &paths.exclusions_path,
        format!("{}\n", serde_json::to_string_pretty(&file)?),
    )?;
    Ok(rules)
}

fn ensure_layout(paths: &SkysightPaths) -> Result<()> {
    crate::secure_fs::create_private_dir_all(&paths.runtime_dir)?;
    crate::secure_fs::create_private_dir_all(&paths.segments_dir)?;
    crate::secure_fs::create_private_dir_all(&paths.resources_dir)?;
    ensure_parent_dirs(paths)
}

fn ensure_parent_dirs(paths: &SkysightPaths) -> Result<()> {
    if let Some(parent) = paths.status_path.parent() {
        crate::secure_fs::create_private_dir_all(parent)?;
    }
    if let Some(parent) = paths.exclusions_path.parent() {
        crate::secure_fs::create_private_dir_all(parent)?;
    }
    if let Some(parent) = paths.stop_request_path.parent() {
        crate::secure_fs::create_private_dir_all(parent)?;
    }
    Ok(())
}

fn read_status(paths: &SkysightPaths) -> Result<SkysightStatus> {
    let raw = fs::read_to_string(&paths.status_path)
        .with_context(|| format!("failed to read {}", paths.status_path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse {}", paths.status_path.display()))
}

fn write_status(paths: &SkysightPaths, status: &SkysightStatus) -> Result<()> {
    crate::secure_fs::write_private_file(
        &paths.status_path,
        format!("{}\n", serde_json::to_string_pretty(status)?),
    )
}

fn status_value(
    paths: &SkysightPaths,
    state: &str,
    is_running: bool,
    pid: Option<u32>,
    started_at: Option<String>,
    end_reason: Option<String>,
    message: Option<String>,
) -> Result<SkysightStatus> {
    let existing = read_status(paths).ok();
    Ok(SkysightStatus {
        ok: true,
        schema_version: 1,
        state: state.to_string(),
        is_running,
        pid,
        started_at: started_at.or_else(|| {
            existing
                .as_ref()
                .and_then(|status| status.started_at.clone())
        }),
        updated_at: Some(now_timestamp()),
        ended_at: if is_running {
            None
        } else {
            Some(now_timestamp())
        },
        end_reason,
        runtime_dir: paths.runtime_dir.clone(),
        segments_dir: paths.segments_dir.clone(),
        resources_dir: paths.resources_dir.clone(),
        exclusions_path: paths.exclusions_path.clone(),
        status_path: paths.status_path.clone(),
        last_segment_path: latest_segment(paths)?,
        recent_resources: recent_resources(paths)?,
        message,
    })
}

fn latest_segment(paths: &SkysightPaths) -> Result<Option<PathBuf>> {
    if !paths.segments_dir.exists() {
        return Ok(None);
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(&paths.segments_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .collect();
    entries.sort();
    Ok(entries.pop())
}

fn recent_resources(paths: &SkysightPaths) -> Result<Vec<PathBuf>> {
    if !paths.resources_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(&paths.resources_dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
        .collect();
    entries.sort();
    entries.reverse();
    entries.truncate(12);
    Ok(entries)
}

fn format_memory_resource(recorded_at: &str, source: &str, event: &Value) -> String {
    let summary = event
        .get("diagnostics")
        .and_then(|diagnostics| diagnostics.get("summary"))
        .cloned()
        .unwrap_or(Value::Null);
    format!(
        "# Skysight Activity Summary\n\nRecorded at: `{recorded_at}`\n\nSource: `{source}`\n\nThis Linux Skysight resource was generated from the local Computer Use event stream and should be used as recent activity evidence. [skysight memory]\n\n```json\n{}\n```\n",
        serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "null".to_string())
    )
}

fn timestamp_slug() -> String {
    Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ").to_string()
}

fn now_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn active_status_pid(paths: &SkysightPaths) -> Option<u32> {
    read_status(paths)
        .ok()
        .and_then(|status| status.pid)
        .filter(|pid| process_is_alive(*pid))
}

fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        Path::new("/proc").join(pid.to_string()).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn request_process_stop(pid: u32) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
