use codex_record_replay_linux::{
    capture_skysight_snapshot, list_skysight_exclusions, pause_skysight, resume_skysight,
    skysight_status, stop_skysight, update_skysight_exclusion, SkysightExclusionUpdate,
    SkysightPaths,
};
use std::{
    env,
    sync::{Mutex, OnceLock},
};

fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn restore_env(key: &str, value: Option<std::ffi::OsString>) {
    match value {
        Some(value) => env::set_var(key, value),
        None => env::remove_var(key),
    }
}

#[test]
fn skysight_paths_default_to_chronicle_resources_dir() {
    let _guard = env_guard();
    let old_code_home = env::var_os("CODEX_HOME");
    let old_runtime_dir = env::var_os("CODEX_SKYSIGHT_RUNTIME_DIR");
    let old_resources_dir = env::var_os("CODEX_SKYSIGHT_RESOURCES_DIR");

    let temp = tempfile::tempdir().unwrap();
    let code_home = temp.path().join("codex-home");
    let runtime_dir = temp.path().join("runtime");
    env::set_var("CODEX_HOME", &code_home);
    env::set_var("CODEX_SKYSIGHT_RUNTIME_DIR", &runtime_dir);
    env::remove_var("CODEX_SKYSIGHT_RESOURCES_DIR");

    let paths = SkysightPaths::from_env();

    assert_eq!(
        paths.resources_dir,
        code_home
            .join("memories_extensions")
            .join("chronicle")
            .join("resources")
    );
    assert_eq!(paths.runtime_dir, runtime_dir);

    restore_env("CODEX_HOME", old_code_home);
    restore_env("CODEX_SKYSIGHT_RUNTIME_DIR", old_runtime_dir);
    restore_env("CODEX_SKYSIGHT_RESOURCES_DIR", old_resources_dir);
}

#[test]
fn skysight_snapshot_creates_segment_directory_and_rollup_resources() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    let status = capture_skysight_snapshot(&paths, Some("test")).unwrap();

    assert!(status.ok);
    assert_eq!(status.state, "running");
    assert!(status.status_path.is_file());
    assert!(status.memory_extension_dir.ends_with("resources"));
    let segment_dir = status
        .current_segment_events_path
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap();
    assert!(segment_dir.is_dir());
    assert!(segment_dir.join("events.jsonl").is_file());
    assert!(segment_dir.join("metadata.json").is_file());
    assert!(status
        .current_segment_metadata_path
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(status
        .last_10min_resource
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(status
        .last_6h_resource
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert!(status
        .last_10min_resource
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains("-10min-")));
    assert!(status
        .last_6h_resource
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains("-6h-")));
    assert_eq!(status.exclusions_count, 0);
    assert!(!status.capture_capability_notes.is_empty());
    assert!(!status.summarizer_capability_notes.is_empty());

    let resource = std::fs::read_to_string(status.last_10min_resource.as_ref().unwrap()).unwrap();
    assert!(resource.contains("# Skysight Activity Summary"));
    assert!(resource.contains("[skysight memory]"));
    assert!(resource.contains("segment count"));
    assert!(resource.contains("Diagnostics summary"));
    assert!(resource.contains("Capture capabilities"));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("windowing")));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("screenshot")));
    assert!(status
        .capture_capability_notes
        .iter()
        .any(|note| note.contains("at-spi")));

    let rollup = std::fs::read_to_string(status.last_6h_resource.as_ref().unwrap()).unwrap();
    assert!(rollup.contains("# Skysight Chronicle Rollup"));
    assert!(rollup.contains("[skysight memory]"));

    let current = skysight_status(&paths).unwrap();
    assert_eq!(current.state, "running");
    assert_eq!(current.last_10min_resource, status.last_10min_resource);
    assert_eq!(current.last_6h_resource, status.last_6h_resource);

    let stopped = stop_skysight(&paths).unwrap();
    assert_eq!(stopped.state, "stopped");
    assert!(!stopped.is_running);
}

#[test]
fn skysight_pause_and_resume_gate_snapshot_capture() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    let paused = pause_skysight(&paths, Some("focus on review".to_string())).unwrap();
    assert_eq!(paused.state, "paused");
    assert!(paused.paused);
    assert_eq!(paused.pause_reason.as_deref(), Some("focus on review"));

    let snapshot_while_paused = capture_skysight_snapshot(&paths, Some("paused")).unwrap();
    assert_eq!(snapshot_while_paused.state, "paused");
    assert!(snapshot_while_paused.current_segment_events_path.is_none());
    assert!(snapshot_while_paused.last_10min_resource.is_none());
    assert!(snapshot_while_paused.last_6h_resource.is_none());

    let resumed = resume_skysight(&paths).unwrap();
    assert_eq!(resumed.state, "running");
    assert!(!resumed.paused);
    assert!(resumed.pause_reason.is_none());

    let snapshot = capture_skysight_snapshot(&paths, Some("resume")).unwrap();
    assert_eq!(snapshot.state, "running");
    assert!(snapshot
        .current_segment_events_path
        .as_ref()
        .is_some_and(|path| path.is_file()));
}

#[test]
fn skysight_exclusions_roundtrip_without_starting_service() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    update_skysight_exclusion(
        &paths,
        SkysightExclusionUpdate {
            kind: "app".to_string(),
            value: "Secrets".to_string(),
            reason: Some("private workflow".to_string()),
            remove: false,
        },
    )
    .unwrap();
    update_skysight_exclusion(
        &paths,
        SkysightExclusionUpdate {
            kind: "domain".to_string(),
            value: "bank.example".to_string(),
            reason: None,
            remove: false,
        },
    )
    .unwrap();

    let exclusions = list_skysight_exclusions(&paths).unwrap();
    assert_eq!(exclusions.len(), 2);
    assert!(exclusions
        .iter()
        .any(|rule| rule.kind == "app" && rule.value == "Secrets"));
    assert!(exclusions
        .iter()
        .any(|rule| rule.kind == "domain" && rule.value == "bank.example"));

    update_skysight_exclusion(
        &paths,
        SkysightExclusionUpdate {
            kind: "app".to_string(),
            value: "Secrets".to_string(),
            reason: None,
            remove: true,
        },
    )
    .unwrap();

    let exclusions = list_skysight_exclusions(&paths).unwrap();
    assert_eq!(exclusions.len(), 1);
    assert_eq!(exclusions[0].value, "bank.example");

    let status = skysight_status(&paths).unwrap();
    assert_eq!(status.exclusions_count, 1);
}
