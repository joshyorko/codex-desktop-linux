use codex_record_replay_linux::{
    capture_skysight_snapshot, list_skysight_exclusions, skysight_status, stop_skysight,
    update_skysight_exclusion, SkysightExclusionUpdate, SkysightPaths,
};

#[test]
fn skysight_snapshot_creates_status_segment_and_memory_resource() {
    let temp = tempfile::tempdir().unwrap();
    let paths = SkysightPaths::new(temp.path().join("runtime"), temp.path().join("resources"));

    let status = capture_skysight_snapshot(&paths, Some("test")).unwrap();

    assert!(status.ok);
    assert_eq!(status.state, "running");
    assert!(status.status_path.is_file());
    assert!(status
        .last_segment_path
        .as_ref()
        .is_some_and(|path| path.is_file()));
    assert_eq!(status.recent_resources.len(), 1);
    let resource_path = &status.recent_resources[0];
    let resource = std::fs::read_to_string(resource_path).unwrap();
    assert!(resource.contains("# Skysight Activity Summary"));
    assert!(resource.contains("[skysight memory]"));

    let current = skysight_status(&paths).unwrap();
    assert_eq!(current.state, "running");
    assert_eq!(current.recent_resources, status.recent_resources);

    let stopped = stop_skysight(&paths).unwrap();
    assert_eq!(stopped.state, "stopped");
    assert!(!stopped.is_running);
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
}
