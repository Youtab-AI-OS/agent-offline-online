//! Last-chance diagnostics: never persist credential-bearing records, bound disk use.
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const REDACTED: &str = "[redacted credential-bearing diagnostic]";
pub const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const BACKUPS: usize = 3;

/// Accept only a source location, so arbitrary panic payloads cannot reach logs.
pub fn panic_location(location: Option<&std::panic::Location<'_>>) -> String {
    location.map(|location| format!("{}:{}:{}", location.file(), location.line(), location.column()))
        .unwrap_or_else(|| "location unavailable".into())
}

/// Diagnostics are not a machine protocol. Drop the entire credential-bearing
/// record rather than guessing where a quoted, escaped or multiline value ends.
pub fn safe_diagnostic(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let sensitive_field = ["password", "passwd", "secret", "token", "api_key", "api-key", "apikey", "authorization", "cookie", "credential", "private_key", "signature", "sig", "key"]
        .iter().any(|key| lower.match_indices(key).any(|(offset, _)| {
            let tail = &lower[offset + key.len()..];
            tail.trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, '\"' | '\'' | '\\')).starts_with([':', '='])
        }));
    let opaque_secret = ["sk-", "sk_", "ghp_", "github_pat_", "bearer ", "-----begin ", "akia", "eyj"]
        .iter().any(|prefix| lower.contains(prefix));
    let url_credentials = lower.split("://").skip(1).any(|rest| {
        rest.split(['/', '?', '#', ' ', '\n', '\r', '\"', '\'']).next().is_some_and(|authority| authority.contains('@'))
    });
    if sensitive_field || opaque_secret || url_credentials { return REDACTED.into(); }
    value.chars().flat_map(|ch| match ch {
        '\n' | '\t' => ch.to_string().chars().collect::<Vec<_>>(),
        ch if ch.is_control() || ('\u{202a}'..='\u{202e}').contains(&ch) || ('\u{2066}'..='\u{2069}').contains(&ch) => ch.escape_unicode().collect(),
        ch => vec![ch],
    }).collect()
}

/// Runs on the existing tracing worker, so filesystem latency stays off the UI.
pub struct BoundedLog { path: PathBuf, file: Option<File>, size: u64, limit: u64 }
impl BoundedLog {
    pub fn new(path: &Path, limit: u64) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok(Self { path: path.into(), file: Some(file), size, limit })
    }
    fn rotate(&mut self) -> io::Result<()> {
        if let Some(file) = &mut self.file { file.flush()?; }
        drop(self.file.take());
        let result = self.rotate_files();
        // Windows requires closing the old handle before rename. Even a
        // partially failed rotation must leave a usable active-file handle.
        self.ensure_open()?;
        result
    }
    fn ensure_open(&mut self) -> io::Result<()> {
        if self.file.is_none() {
            let file = OpenOptions::new().create(true).append(true).open(&self.path)?;
            self.size = file.metadata()?.len();
            self.file = Some(file);
        }
        Ok(())
    }
    fn rotate_files(&self) -> io::Result<()> {
        let backup = |index| self.path.with_extension(format!("log.{index}"));
        match std::fs::remove_file(backup(BACKUPS)) {
            Ok(()) => {}, Err(err) if err.kind() == io::ErrorKind::NotFound => {}, Err(err) => return Err(err),
        }
        for index in (1..BACKUPS).rev() {
            match std::fs::rename(backup(index), backup(index + 1)) {
                Ok(()) => {}, Err(err) if err.kind() == io::ErrorKind::NotFound => {}, Err(err) => return Err(io::Error::new(err.kind(), format!("log backup rotation failed: {err}"))),
            }
        }
        std::fs::rename(&self.path, backup(1)).map_err(|err| io::Error::new(err.kind(), format!("active log rotation failed: {err}")))?;
        Ok(())
    }
    fn write_record(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.ensure_open()?;
        if self.size + bytes.len() as u64 > self.limit { self.rotate()?; }
        let bytes_to_write = if bytes.len() as u64 > self.limit { b"[oversized diagnostic omitted]\n".as_slice() } else { bytes };
        self.file.as_mut().ok_or_else(|| io::Error::other("installer log unavailable after rotation failure"))?.write_all(bytes_to_write)?;
        self.size += bytes_to_write.len() as u64;
        Ok(bytes.len())
    }
}
impl Write for BoundedLog {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let result = self.write_record(bytes);
        if result.is_err() {
            // tracing-appender does not report worker IO failures. Report a
            // fixed failure code: even a redacted record may contain an
            // unlabelled company secret.
            eprintln!("[youtab-setup] diagnostic file write failed");
        }
        result
    }
    fn flush(&mut self) -> io::Result<()> {
        self.ensure_open()?;
        self.file.as_mut().ok_or_else(|| io::Error::other("installer log unavailable"))?.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_are_never_in_diagnostics() {
        // Build the synthetic header at runtime; do not store a complete key
        // header in source, where the unchanged secret gate correctly flags it.
        let synthetic_pem = ["-----", "BEGIN ", "PRIVATE KEY", "-----\nsynthetic"].concat();
        for value in ["password = \"synthetic words\"", "{\"access_token\":\"synthetic\"}", r#"{\"access_token\":\"synthetic\"}"#, "Cookie: synthetic", "https://user:synthetic@host/path", "https://host/?token=synthetic", "https://host/?sig=synthetic", "Bearer synthetic", "failed sk-synthetic", synthetic_pem.as_str()] {
            assert_eq!(safe_diagnostic(value), REDACTED, "{value}");
        }
        assert_eq!(safe_diagnostic("download failed: HTTP 503; retry"), "download failed: HTTP 503; retry");
        assert_eq!(safe_diagnostic("bad\u{202e}log\r"), "bad\\u{202e}log\\u{d}");
    }
    #[test]
    fn credential_field_delimiters_can_follow_multiline_whitespace() {
        for value in ["password\n = SYNTHETIC_MULTILINE", "password\r\n\t: SYNTHETIC_MULTILINE", "token\u{2003}=SYNTHETIC_MULTILINE", "Proxy-Authorization\n: Digest SYNTHETIC_MULTILINE"] {
            assert_eq!(safe_diagnostic(value), REDACTED);
        }
        assert_eq!(safe_diagnostic("download failed\n    at installer.rs:42"), "download failed\n    at installer.rs:42");
    }
    #[test]
    fn panic_hook_omits_arbitrary_payload_in_a_real_child_process() {
        const CHILD: &str = "YOUTAB_SETUP_SYNTHETIC_PANIC_CHILD";
        if std::env::var_os(CHILD).is_some() {
            std::panic::set_hook(Box::new(|info| eprintln!("installer panic: {}", panic_location(info.location()))));
            panic!("opaque synthetic credential with no recognizable key");
        }
        let test_name = concat!(module_path!(), "::panic_hook_omits_arbitrary_payload_in_a_real_child_process")
            .split_once("::").unwrap().1;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(!output.status.success());
        let diagnostic = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(diagnostic.contains("installer panic:"));
        assert!(diagnostic.contains("diagnostics.rs:"));
        assert!(!diagnostic.contains("opaque synthetic credential"));
    }
    #[test]
    fn retention_is_bounded_and_keeps_recent_records() {
        let dir = std::env::temp_dir().join(format!("youtab-log-test-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("bootstrap-installer.log");
        let mut writer = BoundedLog::new(&path, 64).unwrap();
        for _ in 0..20 { writer.write_all(b"recent diagnostic record\n").unwrap(); }
        writer.flush().unwrap(); drop(writer);
        let files = std::fs::read_dir(&dir).unwrap().map(Result::unwrap).collect::<Vec<_>>();
        assert_eq!(files.len(), 4);
        assert!(files.iter().all(|file| file.metadata().unwrap().len() <= 64));
        assert!(std::fs::read_to_string(path).unwrap().contains("recent diagnostic record"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_rotation_preserves_active_log_and_recovers() {
        let dir = std::env::temp_dir().join(format!("youtab-log-failure-test-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("bootstrap-installer.log");
        let blocker = path.with_extension("log.3");
        let mut writer = BoundedLog::new(&path, 32).unwrap();
        writer.write_all(b"before failure\n").unwrap();
        std::fs::create_dir(&blocker).unwrap();
        assert!(writer.write_all(b"another long diagnostic record\n").is_err());
        assert!(writer.file.is_some());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "before failure\n");
        std::fs::remove_dir(blocker).unwrap();
        writer.write_all(b"recovered diagnostic record\n").unwrap();
        writer.flush().unwrap(); drop(writer);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "recovered diagnostic record\n");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn missing_handle_retries_open_after_filesystem_recovers() {
        let dir = std::env::temp_dir().join(format!("youtab-log-reopen-test-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("bootstrap-installer.log");
        let mut writer = BoundedLog::new(&path, 64).unwrap();
        drop(writer.file.take());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(writer.write_all(b"while path is blocked\n").is_err());
        assert!(writer.flush().is_err());
        std::fs::remove_dir(&path).unwrap();
        writer.write_all(b"filesystem recovered\n").unwrap();
        writer.flush().unwrap(); drop(writer);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "filesystem recovered\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_write_stderr_never_echoes_an_opaque_record() {
        const CHILD: &str = "YOUTAB_SETUP_OPAQUE_WRITE_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("bootstrap-installer.log");
            let mut writer = BoundedLog::new(&path, 64).unwrap();
            drop(writer.file.take());
            std::fs::remove_file(&path).unwrap();
            std::fs::create_dir(&path).unwrap();
            assert!(writer.write_all(b"opaque company secret with no known prefix\n").is_err());
            return;
        }
        let test_name = concat!(module_path!(), "::failed_write_stderr_never_echoes_an_opaque_record")
            .split_once("::").unwrap().1;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test_name, "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("[youtab-setup] diagnostic file write failed"));
        assert!(!stderr.contains("opaque company secret"));
    }
}


pub const OPERATION_ENV: &str = "YOUTAB_AGENT_DIAGNOSTIC_OPERATION_ID";

/// Parse only canonical UUIDv4 metadata. This conveys no execution authority.
pub fn valid_operation_id(value: &str) -> Option<String> {
    let uuid = uuid::Uuid::parse_str(value).ok()?;
    if uuid.get_version_num() == 4 && uuid.get_variant() == uuid::Variant::RFC4122
        && uuid.hyphenated().to_string() == value {
        Some(value.to_owned())
    } else { None }
}

/// One correlation label for this installation/update process chain, including
/// a manual retry in the same Setup invocation. Never stored in user registry.
pub fn operation_id() -> &'static str {
    static OPERATION: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| {
        std::env::var(OPERATION_ENV).ok().and_then(|value| valid_operation_id(&value))
            .unwrap_or_else(|| uuid::Uuid::new_v4().hyphenated().to_string())
    });
    OPERATION.as_str()
}

#[derive(serde::Serialize)]
pub struct OperationDiagnostic {
    pub schema_version: &'static str,
    pub code: &'static str,
    pub component: &'static str,
    pub stage: String,
    /// Advisory only: false authorizes no NEW retry; existing bounded retries and user buttons are unchanged.
    pub retryable: bool,
    pub safe_message: String,
    pub operation_id: &'static str,
}

pub fn operation_diagnostic(code: &'static str, stage: &str, message: &str) -> OperationDiagnostic {
    OperationDiagnostic {
        schema_version: "youtab.diagnostic.v1", code, component: "setup",
        stage: if !stage.is_empty() && stage.len() <= 64
            && stage.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') {
            stage.to_string()
        } else { "unknown".to_string() },
        retryable: false, safe_message: safe_diagnostic(message), operation_id: operation_id(),
    }
}


pub fn panic_diagnostic(location: Option<&std::panic::Location<'_>>, operation: &str) -> String {
    let context = valid_operation_id(operation).unwrap_or_else(|| "unavailable".to_owned());
    format!("[youtab-setup] panic [operation={context}]: {}", panic_location(location))
}

#[cfg(test)]
mod panic_operation_tests {
    #[test]
    fn panic_record_keeps_valid_context_and_never_echoes_invalid_context() {
        let id = "123e4567-e89b-42d3-a456-426614174000";
        assert!(super::panic_diagnostic(None, id).contains(id));
        let invalid = super::panic_diagnostic(None, "password=SYNTHETIC_PANIC_CREDENTIAL");
        assert!(invalid.contains("operation=unavailable"));
        assert!(!invalid.contains("SYNTHETIC_PANIC_CREDENTIAL"));
    }
}
