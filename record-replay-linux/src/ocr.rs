use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_TESSERACT: &str = "tesseract";
const DEFAULT_LANGUAGE: &str = "eng";
const DEFAULT_PSM: &str = "11";
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_OCR_OBSERVATIONS: usize = 200;
const MAX_OCR_NORMALIZED_TEXT_BYTES: usize = 32 * 1024;
const MAX_OCR_CANDIDATE_TEXT_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OcrMode {
    Auto,
    Enabled,
    Required,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OcrPolicy {
    pub(crate) mode: OcrMode,
    executable: PathBuf,
    pub(crate) language: String,
    pub(crate) page_segmentation_mode: String,
    pub(crate) timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OcrReadiness {
    pub(crate) enabled: bool,
    pub(crate) available: bool,
    pub(crate) backend: String,
    pub(crate) status: String,
    pub(crate) language: String,
    pub(crate) version: Option<String>,
    pub(crate) dependency_hint: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct OcrFrameResult {
    #[serde(skip)]
    pub(crate) runs_ocr: bool,
    #[serde(skip)]
    pub(crate) status: String,
    #[serde(skip)]
    pub(crate) backend: String,
    #[serde(skip)]
    pub(crate) language: String,
    #[serde(skip)]
    pub(crate) backend_version: Option<String>,
    #[serde(skip)]
    pub(crate) normalized_text: String,
    #[serde(skip)]
    pub(crate) dependency_hint: Option<String>,
    #[serde(skip)]
    pub(crate) error: Option<String>,
    #[serde(skip)]
    pub(crate) duration_ms: u128,
    #[serde(skip)]
    pub(crate) truncated: bool,
    #[serde(skip)]
    pub(crate) suppressed_text_observation_count: usize,
    #[serde(skip)]
    pub(crate) observations: Vec<OcrObservation>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct OcrObservation {
    #[serde(rename = "boundingBox")]
    pub(crate) bounding_box: NormalizedBoundingBox,
    #[serde(rename = "pixelBoundingBox")]
    pub(crate) pixel_bounding_box: PixelBoundingBox,
    #[serde(rename = "topCandidates")]
    pub(crate) top_candidates: Vec<OcrCandidate>,
    pub(crate) normalized_text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct NormalizedBoundingBox {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) coordinate_space: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct PixelBoundingBox {
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) coordinate_space: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct OcrCandidate {
    pub(crate) text: String,
    pub(crate) confidence: f64,
}

#[derive(Debug, Clone)]
struct TsvWord {
    page: String,
    block: String,
    paragraph: String,
    line: String,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    confidence: f64,
    text: String,
}

impl OcrPolicy {
    pub(crate) fn from_env() -> Self {
        let mode = env_value("CODEX_SKYSIGHT_OCR")
            .or_else(|| env_value("CODEX_CHRONICLE_OCR"))
            .map(|value| match value.trim().to_ascii_lowercase().as_str() {
                "disabled" | "off" | "false" | "0" => OcrMode::Disabled,
                "enabled" | "on" | "true" | "1" => OcrMode::Enabled,
                "required" | "require" => OcrMode::Required,
                _ => OcrMode::Auto,
            })
            .unwrap_or(OcrMode::Auto);
        let executable = env_value("CODEX_SKYSIGHT_TESSERACT_PATH")
            .or_else(|| env_value("CODEX_CHRONICLE_TESSERACT_PATH"))
            .unwrap_or_else(|| DEFAULT_TESSERACT.to_string());
        let language =
            env_value("CODEX_SKYSIGHT_OCR_LANG").unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
        let page_segmentation_mode =
            env_value("CODEX_SKYSIGHT_OCR_PSM").unwrap_or_else(|| DEFAULT_PSM.to_string());
        let timeout_ms = env_value("CODEX_SKYSIGHT_OCR_TIMEOUT_MS")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS);

        Self {
            mode,
            executable: PathBuf::from(executable),
            language,
            page_segmentation_mode,
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    pub(crate) fn backend_name(&self) -> &'static str {
        "tesseract-cli"
    }

    pub(crate) fn mode_name(&self) -> &'static str {
        match self.mode {
            OcrMode::Auto => "auto",
            OcrMode::Enabled => "enabled",
            OcrMode::Required => "required",
            OcrMode::Disabled => "disabled",
        }
    }

    pub(crate) fn readiness(&self) -> OcrReadiness {
        if self.mode == OcrMode::Disabled {
            return OcrReadiness {
                enabled: false,
                available: false,
                backend: self.backend_name().to_string(),
                status: "disabled".to_string(),
                language: self.language.clone(),
                version: None,
                dependency_hint: None,
                error: None,
            };
        }

        match Command::new(&self.executable).arg("--version").output() {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let version = stdout.lines().next().map(str::trim).map(str::to_string);
                OcrReadiness {
                    enabled: true,
                    available: true,
                    backend: self.backend_name().to_string(),
                    status: "available".to_string(),
                    language: self.language.clone(),
                    version,
                    dependency_hint: None,
                    error: None,
                }
            }
            Ok(output) => OcrReadiness {
                enabled: true,
                available: false,
                backend: self.backend_name().to_string(),
                status: "backend_unavailable".to_string(),
                language: self.language.clone(),
                version: None,
                dependency_hint: Some(dependency_hint(&self.language)),
                error: Some(format!("tesseract --version exited with {}", output.status)),
            },
            Err(error) => OcrReadiness {
                enabled: true,
                available: false,
                backend: self.backend_name().to_string(),
                status: "backend_unavailable".to_string(),
                language: self.language.clone(),
                version: None,
                dependency_hint: Some(dependency_hint(&self.language)),
                error: Some(error.to_string()),
            },
        }
    }
}

impl OcrFrameResult {
    fn skipped(policy: &OcrPolicy, readiness: &OcrReadiness) -> Self {
        Self {
            runs_ocr: false,
            status: readiness.status.clone(),
            backend: policy.backend_name().to_string(),
            language: policy.language.clone(),
            backend_version: readiness.version.clone(),
            normalized_text: String::new(),
            dependency_hint: readiness.dependency_hint.clone(),
            error: readiness.error.clone(),
            duration_ms: 0,
            truncated: false,
            suppressed_text_observation_count: 0,
            observations: Vec::new(),
        }
    }

    fn failure(policy: &OcrPolicy, status: &str, duration_ms: u128, error: String) -> Self {
        Self {
            runs_ocr: true,
            status: status.to_string(),
            backend: policy.backend_name().to_string(),
            language: policy.language.clone(),
            backend_version: policy.readiness().version,
            normalized_text: String::new(),
            dependency_hint: None,
            error: Some(error),
            duration_ms,
            truncated: false,
            suppressed_text_observation_count: 0,
            observations: Vec::new(),
        }
    }

    fn required_unavailable(policy: &OcrPolicy, readiness: &OcrReadiness) -> Self {
        Self {
            runs_ocr: false,
            status: "required_backend_unavailable".to_string(),
            backend: policy.backend_name().to_string(),
            language: policy.language.clone(),
            backend_version: readiness.version.clone(),
            normalized_text: String::new(),
            dependency_hint: readiness.dependency_hint.clone(),
            error: Some(
                readiness
                    .error
                    .clone()
                    .unwrap_or_else(|| "required OCR backend is unavailable".to_string()),
            ),
            duration_ms: 0,
            truncated: false,
            suppressed_text_observation_count: 0,
            observations: Vec::new(),
        }
    }

    pub(crate) fn apply_text_exclusions(&mut self, exclusion_values: &[String]) {
        if self.normalized_text.trim().is_empty() {
            return;
        }
        if !exclusion_values
            .iter()
            .filter(|value| !value.trim().is_empty())
            .any(|value| contains_case_insensitive(&self.normalized_text, value))
        {
            return;
        }

        self.status = "suppressed_by_exclusion_text".to_string();
        self.suppressed_text_observation_count = self.observations.len();
        self.normalized_text.clear();
        self.observations.clear();
    }

    fn apply_persistence_limits(&mut self) {
        if self.observations.len() > MAX_OCR_OBSERVATIONS {
            self.observations.truncate(MAX_OCR_OBSERVATIONS);
            self.truncated = true;
        }

        let mut truncated_text = false;
        for observation in &mut self.observations {
            truncated_text |= truncate_string_to_bytes(
                &mut observation.normalized_text,
                MAX_OCR_CANDIDATE_TEXT_BYTES,
            );
            for candidate in &mut observation.top_candidates {
                truncated_text |=
                    truncate_string_to_bytes(&mut candidate.text, MAX_OCR_CANDIDATE_TEXT_BYTES);
            }
        }
        if truncated_text {
            self.truncated = true;
        }

        if !self.observations.is_empty() {
            self.normalized_text = self
                .observations
                .iter()
                .map(|observation| observation.normalized_text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
        }
        if truncate_string_to_bytes(&mut self.normalized_text, MAX_OCR_NORMALIZED_TEXT_BYTES) {
            self.truncated = true;
        }
    }

    pub(crate) fn to_json_line(
        &self,
        captured_at: &str,
        frame_index: u64,
        persisted_frame_path: &Path,
        latest_frame_path: &Path,
        display_id: &str,
    ) -> Value {
        let mut value = json!({
            "schema_version": 1,
            "captured_at": captured_at,
            "frame_index": frame_index,
            "persisted_frame_path": persisted_frame_path,
            "latest_frame_path": latest_frame_path,
            "display_id": display_id,
            "normalized_text": self.normalized_text,
            "normalized_text_bytes": self.normalized_text.len(),
            "runs_ocr": self.runs_ocr,
            "ocr_status": self.status,
            "ocr_backend": self.backend,
            "language": self.language,
            "duration_ms": self.duration_ms,
            "truncated": self.truncated,
            "observations": self.observations,
        });
        if let Some(version) = &self.backend_version {
            value["ocr_backend_version"] = json!(version);
        }
        if let Some(hint) = &self.dependency_hint {
            value["dependency_hint"] = json!(hint);
        }
        if let Some(error) = &self.error {
            value["error"] = json!(error);
        }
        if self.suppressed_text_observation_count > 0 {
            value["suppressed_text_observation_count"] =
                json!(self.suppressed_text_observation_count);
        }
        value
    }

    #[cfg(test)]
    fn completed_for_test(text: &str) -> Self {
        Self {
            runs_ocr: true,
            status: "completed".to_string(),
            backend: "tesseract-cli".to_string(),
            language: "eng".to_string(),
            backend_version: None,
            normalized_text: text.to_string(),
            dependency_hint: None,
            error: None,
            duration_ms: 1,
            truncated: false,
            suppressed_text_observation_count: 0,
            observations: vec![OcrObservation {
                bounding_box: NormalizedBoundingBox {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                    coordinate_space: "vision-normalized-bottom-left",
                },
                pixel_bounding_box: PixelBoundingBox {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    coordinate_space: "pixel-top-left",
                },
                top_candidates: vec![OcrCandidate {
                    text: text.to_string(),
                    confidence: 1.0,
                }],
                normalized_text: text.to_string(),
            }],
        }
    }
}

pub(crate) fn recognize_frame(
    policy: &OcrPolicy,
    frame_path: &Path,
    image_width: u32,
    image_height: u32,
    exclusion_values: &[String],
) -> OcrFrameResult {
    let readiness = policy.readiness();
    if policy.mode == OcrMode::Disabled {
        return OcrFrameResult::skipped(policy, &readiness);
    }
    if !readiness.available {
        return if policy.mode == OcrMode::Required {
            OcrFrameResult::required_unavailable(policy, &readiness)
        } else {
            OcrFrameResult::skipped(policy, &readiness)
        };
    }

    let started = Instant::now();
    match recognize_frame_inner(policy, frame_path, image_width, image_height) {
        Ok(mut result) => {
            result.backend_version = readiness.version;
            result.apply_text_exclusions(exclusion_values);
            result.apply_persistence_limits();
            result
        }
        Err(error) => OcrFrameResult::failure(
            policy,
            if started.elapsed() >= policy.timeout {
                "timeout"
            } else {
                "error"
            },
            started.elapsed().as_millis(),
            error.to_string(),
        ),
    }
}

fn recognize_frame_inner(
    policy: &OcrPolicy,
    frame_path: &Path,
    image_width: u32,
    image_height: u32,
) -> Result<OcrFrameResult> {
    let started = Instant::now();
    let temp_dir = frame_path
        .parent()
        .unwrap_or_else(|| Path::new("/tmp"))
        .join(format!(".ocr-{}-{}", std::process::id(), unique_nanos()));
    crate::secure_fs::create_private_dir_all(&temp_dir)?;
    let output_base = temp_dir.join("frame");
    let mut child = Command::new(&policy.executable)
        .arg(frame_path)
        .arg(&output_base)
        .arg("-l")
        .arg(&policy.language)
        .arg("--psm")
        .arg(&policy.page_segmentation_mode)
        .arg("tsv")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to start {}", policy.executable.display()))?;

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= policy.timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_dir_all(&temp_dir);
            anyhow::bail!(
                "tesseract timed out after {} ms",
                policy.timeout.as_millis()
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    if !status.success() {
        let _ = fs::remove_dir_all(&temp_dir);
        anyhow::bail!("tesseract exited with {status}");
    }

    let tsv_path = output_base.with_extension("tsv");
    let tsv = fs::read_to_string(&tsv_path)
        .with_context(|| format!("failed to read {}", tsv_path.display()))?;
    let observations = observations_from_tsv(&tsv, image_width, image_height)?;
    let normalized_text = observations
        .iter()
        .map(|observation| observation.normalized_text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let _ = fs::remove_dir_all(&temp_dir);

    Ok(OcrFrameResult {
        runs_ocr: true,
        status: "completed".to_string(),
        backend: policy.backend_name().to_string(),
        language: policy.language.clone(),
        backend_version: None,
        normalized_text,
        dependency_hint: None,
        error: None,
        duration_ms: started.elapsed().as_millis(),
        truncated: false,
        suppressed_text_observation_count: 0,
        observations,
    })
}

fn observations_from_tsv(
    tsv: &str,
    image_width: u32,
    image_height: u32,
) -> Result<Vec<OcrObservation>> {
    let mut lines = tsv.lines();
    let Some(header) = lines.next() else {
        return Ok(Vec::new());
    };
    let columns = header.split('\t').collect::<Vec<_>>();
    let index = |name: &str| {
        columns
            .iter()
            .position(|column| *column == name)
            .with_context(|| format!("missing TSV column {name}"))
    };
    let level_idx = index("level")?;
    let page_idx = index("page_num")?;
    let block_idx = index("block_num")?;
    let paragraph_idx = index("par_num")?;
    let line_idx = index("line_num")?;
    let left_idx = index("left")?;
    let top_idx = index("top")?;
    let width_idx = index("width")?;
    let height_idx = index("height")?;
    let confidence_idx = index("conf")?;
    let text_idx = index("text")?;

    let mut words = Vec::new();
    for line in lines {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() <= text_idx || fields.get(level_idx) != Some(&"5") {
            continue;
        }
        let text = fields[text_idx].trim();
        if text.is_empty() {
            continue;
        }
        words.push(TsvWord {
            page: fields[page_idx].to_string(),
            block: fields[block_idx].to_string(),
            paragraph: fields[paragraph_idx].to_string(),
            line: fields[line_idx].to_string(),
            left: parse_u32(fields[left_idx]),
            top: parse_u32(fields[top_idx]),
            width: parse_u32(fields[width_idx]),
            height: parse_u32(fields[height_idx]),
            confidence: parse_confidence(fields[confidence_idx]),
            text: text.to_string(),
        });
    }

    let mut observations = Vec::new();
    let mut current_key: Option<(String, String, String, String)> = None;
    let mut current_words: Vec<TsvWord> = Vec::new();
    for word in words {
        let key = (
            word.page.clone(),
            word.block.clone(),
            word.paragraph.clone(),
            word.line.clone(),
        );
        if current_key
            .as_ref()
            .is_some_and(|existing| *existing != key)
        {
            observations.push(observation_from_words(
                &current_words,
                image_width,
                image_height,
            ));
            current_words.clear();
        }
        current_key = Some(key);
        current_words.push(word);
    }
    if !current_words.is_empty() {
        observations.push(observation_from_words(
            &current_words,
            image_width,
            image_height,
        ));
    }

    Ok(observations)
}

fn observation_from_words(
    words: &[TsvWord],
    image_width: u32,
    image_height: u32,
) -> OcrObservation {
    let x1 = words.iter().map(|word| word.left).min().unwrap_or(0);
    let y1 = words.iter().map(|word| word.top).min().unwrap_or(0);
    let x2 = words
        .iter()
        .map(|word| word.left.saturating_add(word.width))
        .max()
        .unwrap_or(x1);
    let y2 = words
        .iter()
        .map(|word| word.top.saturating_add(word.height))
        .max()
        .unwrap_or(y1);
    let width = x2.saturating_sub(x1);
    let height = y2.saturating_sub(y1);
    let text = words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let confidence = if words.is_empty() {
        0.0
    } else {
        words.iter().map(|word| word.confidence).sum::<f64>() / words.len() as f64
    };

    OcrObservation {
        bounding_box: NormalizedBoundingBox {
            x: if image_width == 0 {
                0.0
            } else {
                x1 as f64 / image_width as f64
            },
            y: if image_height == 0 {
                0.0
            } else {
                1.0 - (y2 as f64 / image_height as f64)
            },
            width: if image_width == 0 {
                0.0
            } else {
                width as f64 / image_width as f64
            },
            height: if image_height == 0 {
                0.0
            } else {
                height as f64 / image_height as f64
            },
            coordinate_space: "vision-normalized-bottom-left",
        },
        pixel_bounding_box: PixelBoundingBox {
            x: x1,
            y: y1,
            width,
            height,
            coordinate_space: "pixel-top-left",
        },
        top_candidates: vec![OcrCandidate {
            text: text.clone(),
            confidence,
        }],
        normalized_text: text,
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn dependency_hint(language: &str) -> String {
    format!("Install tesseract and traineddata for language `{language}`")
}

fn contains_case_insensitive(haystack: &str, needle: &str) -> bool {
    haystack
        .to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn truncate_string_to_bytes(value: &mut String, max_bytes: usize) -> bool {
    if value.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    true
}

fn parse_u32(value: &str) -> u32 {
    value
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .unwrap_or(0) as u32
}

fn parse_confidence(value: &str) -> f64 {
    value
        .parse::<f64>()
        .ok()
        .filter(|value| *value >= 0.0)
        .map(|value| (value / 100.0).min(1.0))
        .unwrap_or(0.0)
}

fn unique_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn policy_defaults_to_local_tesseract_auto() {
        let _guard = env_lock();
        clear_ocr_env();

        let policy = OcrPolicy::from_env();

        assert_eq!(policy.mode, OcrMode::Auto);
        assert_eq!(policy.backend_name(), "tesseract-cli");
        assert_eq!(policy.language, "eng");
        assert_eq!(policy.page_segmentation_mode, "11");
        assert_eq!(policy.timeout.as_secs(), 10);
    }

    #[test]
    fn missing_backend_reports_unavailable_without_requiring_host_dependency() {
        let _guard = env_lock();
        clear_ocr_env();
        std::env::set_var("CODEX_SKYSIGHT_OCR", "enabled");
        std::env::set_var(
            "CODEX_SKYSIGHT_TESSERACT_PATH",
            "/definitely/missing/tesseract",
        );

        let policy = OcrPolicy::from_env();
        let readiness = policy.readiness();

        assert!(readiness.enabled);
        assert!(!readiness.available);
        assert_eq!(readiness.status, "backend_unavailable");
        assert!(readiness.dependency_hint.is_some());
    }

    #[test]
    fn required_mode_marks_missing_backend_as_required_failure() {
        let _guard = env_lock();
        clear_ocr_env();
        std::env::set_var("CODEX_SKYSIGHT_OCR", "required");
        std::env::set_var(
            "CODEX_SKYSIGHT_TESSERACT_PATH",
            "/definitely/missing/tesseract",
        );

        let policy = OcrPolicy::from_env();
        let result = recognize_frame(&policy, Path::new("/tmp/missing-frame.jpg"), 100, 50, &[]);

        assert!(!result.runs_ocr);
        assert_eq!(result.status, "required_backend_unavailable");
        assert!(result.error.is_some());
        assert!(result.dependency_hint.is_some());
    }

    #[test]
    fn fake_tesseract_tsv_groups_words_into_observations() {
        let _guard = env_lock();
        clear_ocr_env();
        let temp = tempfile::tempdir().unwrap();
        let fake_tesseract = temp.path().join("fake-tesseract");
        fs::write(
            &fake_tesseract,
            r#"#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo "tesseract 5.3.4"
  exit 0
fi
out="${2}.tsv"
cat > "$out" <<'TSV'
level	page_num	block_num	par_num	line_num	word_num	left	top	width	height	conf	text
5	1	1	1	1	1	10	20	40	12	95	Codex
5	1	1	1	1	2	55	20	30	12	91	OCR
5	1	1	1	2	1	10	50	35	12	80	Local
TSV
"#,
        )
        .unwrap();
        let mut permissions = fs::metadata(&fake_tesseract).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_tesseract, permissions).unwrap();
        let image = temp.path().join("frame.jpg");
        fs::write(&image, b"not-a-real-image-but-fake-backend-does-not-care").unwrap();
        std::env::set_var("CODEX_SKYSIGHT_OCR", "enabled");
        std::env::set_var("CODEX_SKYSIGHT_TESSERACT_PATH", &fake_tesseract);

        let policy = OcrPolicy::from_env();
        let result = recognize_frame(&policy, &image, 200, 100, &[]);

        assert_eq!(result.status, "completed");
        assert!(result.runs_ocr);
        assert_eq!(result.normalized_text, "Codex OCR\nLocal");
        assert_eq!(result.observations.len(), 2);
        assert_eq!(result.observations[0].normalized_text, "Codex OCR");
        assert_eq!(result.observations[0].pixel_bounding_box.x, 10);
        assert_eq!(result.observations[0].pixel_bounding_box.width, 75);
        assert!(result.observations[0].top_candidates[0].confidence > 0.9);
    }

    #[test]
    fn text_matching_exclusion_suppresses_output() {
        let _guard = env_lock();
        clear_ocr_env();
        let mut result = OcrFrameResult::completed_for_test("bank.example account");

        result.apply_text_exclusions(&["bank.example".to_string()]);

        assert_eq!(result.status, "suppressed_by_exclusion_text");
        assert_eq!(result.normalized_text, "");
        assert!(result.observations.is_empty());
        assert_eq!(result.suppressed_text_observation_count, 1);
    }

    #[test]
    fn persistence_limits_bound_ocr_text_and_observations() {
        let _guard = env_lock();
        clear_ocr_env();
        let mut result = OcrFrameResult {
            runs_ocr: true,
            status: "completed".to_string(),
            backend: "tesseract-cli".to_string(),
            language: "eng".to_string(),
            backend_version: None,
            normalized_text: String::new(),
            dependency_hint: None,
            error: None,
            duration_ms: 1,
            truncated: false,
            suppressed_text_observation_count: 0,
            observations: (0..(MAX_OCR_OBSERVATIONS + 5))
                .map(|index| OcrObservation {
                    bounding_box: NormalizedBoundingBox {
                        x: 0.0,
                        y: 0.0,
                        width: 1.0,
                        height: 1.0,
                        coordinate_space: "vision-normalized-bottom-left",
                    },
                    pixel_bounding_box: PixelBoundingBox {
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        coordinate_space: "pixel-top-left",
                    },
                    top_candidates: vec![OcrCandidate {
                        text: format!("{index}-{}", "x".repeat(MAX_OCR_CANDIDATE_TEXT_BYTES + 20)),
                        confidence: 0.9,
                    }],
                    normalized_text: format!(
                        "{index}-{}",
                        "y".repeat(MAX_OCR_CANDIDATE_TEXT_BYTES + 20)
                    ),
                })
                .collect(),
        };

        result.apply_persistence_limits();

        assert!(result.truncated);
        assert_eq!(result.observations.len(), MAX_OCR_OBSERVATIONS);
        assert!(result.normalized_text.len() <= MAX_OCR_NORMALIZED_TEXT_BYTES);
        assert!(result
            .observations
            .iter()
            .all(|observation| observation.normalized_text.len() <= MAX_OCR_CANDIDATE_TEXT_BYTES));
        assert!(result.observations.iter().all(|observation| observation
            .top_candidates
            .iter()
            .all(|candidate| candidate.text.len() <= MAX_OCR_CANDIDATE_TEXT_BYTES)));
    }

    fn clear_ocr_env() {
        for key in [
            "CODEX_SKYSIGHT_OCR",
            "CODEX_CHRONICLE_OCR",
            "CODEX_SKYSIGHT_TESSERACT_PATH",
            "CODEX_CHRONICLE_TESSERACT_PATH",
            "CODEX_SKYSIGHT_OCR_LANG",
            "CODEX_SKYSIGHT_OCR_PSM",
            "CODEX_SKYSIGHT_OCR_TIMEOUT_MS",
        ] {
            std::env::remove_var(key);
        }
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap()
    }
}
