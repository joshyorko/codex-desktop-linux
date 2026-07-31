use codex_record_replay_linux::mcp::{tool_names, McpMode};

#[test]
fn skysight_mode_exposes_only_activity_memory_tools() {
    let names = tool_names(McpMode::Skysight);

    assert!(names.contains(&"doctor".to_string()));
    assert!(names.contains(&"skysight_start".to_string()));
    assert!(names.contains(&"skysight_status".to_string()));
    assert!(names.contains(&"skysight_pause".to_string()));
    assert!(names.contains(&"skysight_resume".to_string()));
    assert!(names.contains(&"skysight_stop".to_string()));
    assert!(names.contains(&"skysight_snapshot".to_string()));
    assert!(names.contains(&"skysight_update_exclusion".to_string()));
    assert!(names.contains(&"skysight_list_exclusions".to_string()));
    assert!(!names.contains(&"event_stream_start".to_string()));
    assert!(!names.contains(&"start".to_string()));
    assert!(!names.contains(&"draft_skill_prompt".to_string()));
    assert!(!names.contains(&"import_skill".to_string()));
}

#[test]
fn event_stream_mode_retains_recording_and_activity_memory_tools() {
    let names = tool_names(McpMode::EventStream);

    assert!(names.contains(&"event_stream_start".to_string()));
    assert!(names.contains(&"draft_skill_prompt".to_string()));
    assert!(names.contains(&"skysight_start".to_string()));
}
