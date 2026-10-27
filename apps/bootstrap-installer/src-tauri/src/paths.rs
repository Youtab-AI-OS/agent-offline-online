//! Filesystem paths + logging setup.
//!
//! Mirrors `youtab_constants.get_youtab_home()` from the Python CLI:
//!   Windows: registered home, an existing legacy home, or a private
//!            %USERPROFILE%\Youtab for a first customer installation.
//!   macOS:   ~/.youtab-agent-runtime
//!   Linux:   ~/.youtab-agent-runtime  (override via $YOUTAB_AGENT_HOME)
//!
//! NOTE (macOS): Python's get_youtab_home(), scripts/install.sh, and the
//! Electron desktop's resolveYoutabHome() ALL use ~/.youtab-agent-runtime on macOS — there
//! is no ~/Library/Application Support branch anywhere else. An earlier
//! version of this file used Application Support, which drifted from every
//! other component: the installer wrote the install to one dir and the
//! desktop looked for it in another, so first launch never found the backend.
//!
//! IMPORTANT: this must match exactly. Drift here means install.ps1
//! writes to one place and the installer reads from another, breaking
//! the bootstrap-complete check.

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use tracing_appender::non_blocking::WorkerGuard;
use std::io::Write;

static LOG_DROPS: once_cell::sync::OnceCell<tracing_appender::non_blocking::ErrorCounter> = once_cell::sync::OnceCell::new();

// tracing formats one record through this writer. Buffer until Drop so secrets
// split across formatter writes are inspected together before entering the queue.
struct DiagnosticWriter {
    inner: tracing_appender::non_blocking::NonBlocking,
    record: Vec<u8>,
    oversized: bool,
}
impl Write for DiagnosticWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.oversized { return Ok(bytes.len()); }
        if self.record.len() + bytes.len() <= 64 * 1024 {
            self.record.extend_from_slice(bytes);
        } else {
            self.record.clear();
            self.record.extend_from_slice(b"[oversized diagnostic omitted]\n");
            self.oversized = true;
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
impl Drop for DiagnosticWriter {
    fn drop(&mut self) {
        // This is the last sink for *all* tracing records, including library
        // errors outside the install script. Heuristic redaction cannot find
        // unlabeled credentials, so never persist an arbitrary record body.
        let safe = private_trace_record(&self.record, self.oversized);
        let dropped_before = self.inner.error_counter().dropped_lines();
        if self.inner.write_all(safe.as_bytes()).is_err() {
            eprintln!("[youtab-setup] diagnostic log write failed");
        }
        if self.inner.error_counter().dropped_lines() > dropped_before {
            eprintln!("[youtab-setup] diagnostic queue full; a record was dropped");
        }
    }
}

fn private_trace_record(record: &[u8], oversized: bool) -> String {
    if oversized { return "[oversized diagnostic omitted]\n".into(); }
    let raw = String::from_utf8_lossy(record);
    let operation = raw.split_whitespace()
        .find_map(|field| field.strip_prefix("operation_id="))
        .and_then(crate::diagnostics::valid_operation_id);
    let stage = raw.split_whitespace()
        .find_map(|field| field.strip_prefix("stage=").or_else(|| field.strip_prefix("diagnostic_stage=")))
        .map(|value| value.trim_matches('"'))
        .filter(|value| !value.is_empty() && value.len() <= 64
            && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
    let code = raw.split_whitespace()
        .find_map(|field| field.strip_prefix("diagnostic_code="))
        .map(|value| value.trim_matches('"'))
        .filter(|value| matches!(*value, "SETUP_STARTED" | "SETUP_COMPLETE" | "SETUP_FAILED"
            | "SETUP_STAGE_FAILED" | "SETUP_STAGE_PROGRESS" | "SETUP_LOG"));
    let setup_channel_hint = raw.contains(crate::events::SETUP_CHANNEL_UNPUBLISHED);
    let hint = crate::events::actionable_process_hint(&raw).map(|message| {
        if message.starts_with("TLS certificate") { "tls-cert-trust" }
        else if message.starts_with("Network download") { "network-unavailable" }
        else { "disk-full" }
    });
    let mut summary = String::from("[youtab-setup] diagnostic record");
    if let Some(operation) = operation { summary.push_str(&format!(" operation_id={operation}")); }
    if let Some(code) = code { summary.push_str(&format!(" code={code}")); }
    if let Some(stage) = stage { summary.push_str(&format!(" stage={stage}")); }
    if let Some(hint) = hint { summary.push_str(&format!(" hint={hint}")); }
    else if setup_channel_hint { summary.push_str(" hint=setup-channel"); }
    summary.push_str(" details omitted\n");
    summary
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CustomerHome {
    Existing(PathBuf),
    Fresh(PathBuf),
}

#[cfg(windows)]
impl CustomerHome {
    pub(crate) fn path(&self) -> &Path {
        match self { Self::Existing(path) | Self::Fresh(path) => path }
    }
}

#[cfg(windows)]
fn read_registered_home() -> Result<Option<PathBuf>, &'static str> {
    use windows_sys::Win32::{Foundation::ERROR_FILE_NOT_FOUND, System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ}};
    let subkey: Vec<u16> = "Environment\0".encode_utf16().collect();
    let name: Vec<u16> = "YOUTAB_AGENT_HOME\0".encode_utf16().collect();
    let mut bytes = 0u32;
    let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut bytes) };
    if status == ERROR_FILE_NOT_FOUND { return Ok(None); }
    if status != 0 || bytes < 2 || bytes > 32768 || bytes % 2 != 0 { return Err("registered-home-unverifiable"); }
    let mut buffer = vec![0u16; bytes as usize / 2];
    let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, subkey.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut bytes) };
    if status != 0 || bytes < 2 || bytes as usize > buffer.len() * 2 || bytes % 2 != 0 { return Err("registered-home-unverifiable"); }
    buffer.truncate(bytes as usize / 2);
    if buffer.last() != Some(&0) { return Err("registered-home-unverifiable"); }
    buffer.pop();
    let text = String::from_utf16(&buffer).map_err(|_| "registered-home-unverifiable")?;
    if text.trim().is_empty() { return Ok(None); }
    let path = PathBuf::from(text);
    if !path.is_absolute() { return Err("registered-home-unverifiable"); }
    Ok(Some(path))
}

#[cfg(windows)]
pub(crate) fn same_windows_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().trim_end_matches(['\\', '/']).replace('/', "\\")
        .eq_ignore_ascii_case(&b.to_string_lossy().trim_end_matches(['\\', '/']).replace('/', "\\"))
}

#[cfg(windows)]
fn choose_customer_home(process: Option<PathBuf>, registered: Option<PathBuf>, local: &Path, profile: &Path) -> Result<CustomerHome, &'static str> {
    if let Some(path) = process {
        if !path.is_absolute() { return Err("process-home-unverifiable"); }
        if let Some(ref registered) = registered {
            if !same_windows_path(&path, registered) { return Err("home-binding-conflict"); }
        }
        return Ok(CustomerHome::Existing(path));
    }
    if let Some(path) = registered { return Ok(CustomerHome::Existing(path)); }
    let legacy = profile.join(".youtab-agent-runtime");
    let present = |path: &Path| match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("prior-home-unverifiable"),
    };
    if present(local)? { return Ok(CustomerHome::Existing(local.to_owned())); }
    if present(&legacy)? { return Ok(CustomerHome::Existing(legacy)); }
    Ok(CustomerHome::Fresh(profile.join("Youtab")))
}

#[cfg(windows)]
pub(crate) fn customer_home() -> Result<CustomerHome, &'static str> {
    let profile = dirs::home_dir().ok_or("profile-unverifiable")?;
    let local = dirs::data_local_dir().ok_or("local-home-unverifiable")?.join("youtab");
    let process = std::env::var_os("YOUTAB_AGENT_HOME")
        .filter(|v| !v.is_empty()).map(PathBuf::from);
    // The explicit relocation transaction pins the target in this process
    // while the old registered home remains authoritative until publication.
    let registered = if std::env::args().any(|arg| arg == "--relocate-home-v1") {
        None
    } else { read_registered_home()? };
    choose_customer_home(process, registered, &local, &profile)
}

#[cfg(windows)]
pub(crate) fn prepare_fresh_customer_home(selected: &CustomerHome) -> Result<(), &'static str> {
    let CustomerHome::Fresh(home) = selected else { return Ok(()); };
    let marker = home.join(".youtab-fresh-home-v1");
    let validate = || {
        let namespace = crate::update_coordination::admit_private_code_namespace(home)?;
        let meta = std::fs::symlink_metadata(&marker).map_err(|_| "fresh-home-unverifiable")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != b"youtab-fresh-home-v1\n".len() as u64
            || std::fs::read(&marker).map_err(|_| "fresh-home-unverifiable")? != b"youtab-fresh-home-v1\n" {
            return Err("fresh-home-collision");
        }
        namespace.revalidate()?;
        Ok(())
    };
    match std::fs::symlink_metadata(home) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => return validate(),
        Ok(_) => return Err("fresh-home-collision"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("fresh-home-unverifiable"),
    }
    // Prepare the marker inside an unpredictable sibling, then publish the
    // complete home with one same-directory rename. A crash before rename
    // leaves the intended home absent, so the next attempt can safely retry.
    // Never adopt a pre-existing unmarked Youtab directory.
    let parent = home.parent().ok_or("fresh-home-unverifiable")?;
    let prepared = parent.join(format!(".Youtab-stage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&prepared).map_err(|_| "fresh-home-unavailable")?;
    let prepared_namespace = crate::update_coordination::admit_private_code_namespace(&prepared)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(prepared.join(".youtab-fresh-home-v1"))
        .map_err(|_| "fresh-home-unavailable")?;
    file.write_all(b"youtab-fresh-home-v1\n").and_then(|_| file.sync_all())
        .map_err(|_| "fresh-home-unavailable")?;
    drop(file);
    prepared_namespace.revalidate()?;
    // Namespace handles do not grant FILE_SHARE_DELETE on Windows. Release
    // them before the same-directory rename, then re-admit the final leaf.
    drop(prepared_namespace);
    match std::fs::symlink_metadata(home) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Ok(_) => return Err("fresh-home-collision"),
        Err(_) => return Err("fresh-home-unverifiable"),
    }
    std::fs::rename(&prepared, home).map_err(|_| "fresh-home-unavailable")?;
    validate()
}

/// Returns the Youtab home used by this Setup process.
pub fn youtab_home() -> PathBuf {
    #[cfg(windows)]
    if option_env!("RELEASE_BASE_URL").is_some() {
        if let Ok(home) = customer_home() { return home.path().to_owned(); }
        // Bootstrap refuses the ambiguous binding before installing. Keeping
        // the previous default here only gives the GUI/log path a location.
    }
    if let Ok(override_path) = std::env::var("YOUTAB_AGENT_HOME") {
        if !override_path.trim().is_empty() {
            return PathBuf::from(override_path);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // %LOCALAPPDATA%\youtab — matches scripts/install.ps1's $YoutabHome.
        if let Some(local_app_data) = dirs::data_local_dir() {
            return local_app_data.join("youtab");
        }
    }

    // macOS + Linux + fallback: ~/.youtab-agent-runtime (matches Python get_youtab_home(),
    // install.sh, and the Electron desktop's resolveYoutabHome()).
    if let Some(home) = dirs::home_dir() {
        return home.join(".youtab-agent-runtime");
    }

    // Last resort — current dir, almost certainly wrong but at least
    // doesn't panic.
    PathBuf::from(".youtab-agent-runtime")
}

pub fn log_dir() -> PathBuf {
    crate::home_relocation::log_directory(&youtab_home(),
        std::env::args().any(|arg| arg == "--relocate-home-v1"))
}

pub fn log_path() -> PathBuf {
    log_dir().join("bootstrap-installer.log")
}

pub fn bootstrap_cache_dir() -> PathBuf {
    youtab_home().join("bootstrap-cache")
}

/// Stable location the installer copies itself to after a successful install.
/// The desktop app re-invokes this with `--update`, and the start-menu /
/// desktop shortcuts can point users back to it. Lives directly under
/// YOUTAB_AGENT_HOME so it survives repo checkout deletion (unlike anything under
/// youtab-agent-runtime/).
///
/// On Windows this is under the selected/registered home (profile-direct for
/// a fresh customer); on other platforms the extension differs.
pub fn installer_dest() -> PathBuf {
    installer_dest_in(&youtab_home())
}

pub(crate) fn installer_dest_in(home: &Path) -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "youtab-setup.exe"
    } else {
        "youtab-setup"
    };
    home.join(name)
}

/// Fingerprint a regular, non-empty Setup. The customer transaction compares
/// against the currently running executable, not an untrusted downloaded file.
pub(crate) fn installer_sha256(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    use sha2::{Digest, Sha256};
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Setup must be a non-empty regular file"));
    }
    let mut input = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn verify_installer(path: &Path, expected_sha256: &str) -> std::io::Result<()> {
    if installer_sha256(path)? != expected_sha256 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Setup copy verification failed"));
    }
    Ok(())
}

/// Write a private sibling staging file. Never truncate the installed Setup.
/// Partial staging files are owned/recovered by the existing install journal.
pub(crate) fn stage_installer(source: &Path, staged: &Path, expected_sha256: &str) -> std::io::Result<()> {
    let mut input = std::fs::File::open(source)?;
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(staged)?;
    std::io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    drop(output);
    verify_installer(staged, expected_sha256)
}

/// Marker the updater writes for the duration of an in-app update and removes
/// when it finishes (see update.rs `UpdateMarkerGuard`). A freshly-launched
/// desktop checks this before spawning its own local backend: spawning one
/// mid-update re-locks the venv shim and triggers `force_kill_other_youtab`,
/// which then kills that legitimate backend in a respawn loop (#50238).
///
/// Lives directly under YOUTAB_AGENT_HOME (same rationale as `installer_dest`) so the
/// Electron desktop — which resolves YOUTAB_AGENT_HOME identically and pins it into
/// the updater's env — agrees on the exact path.
pub fn update_in_progress_marker() -> PathBuf {
    youtab_home().join(".youtab-agent-runtime-update-in-progress")
}

/// Copy the currently-running installer binary to `installer_dest()` so it's
/// available for future `--update` runs and shortcut launches.
///
/// No-ops (returns Ok) when the running exe is ALREADY the destination — which
/// is exactly the case during an `--update` run (the desktop launched us FROM
/// that path), where copying onto ourselves would be a Windows sharing
/// violation. Best-effort: a failure here must not fail the install, so the
/// caller logs and continues.
pub fn copy_self_to_youtab_home() -> std::io::Result<()> {
    let src = std::env::current_exe()?;
    let dest = installer_dest();

    // Skip if we're already running from the destination (update re-invocation
    // or a prior copy). canonicalize both so symlinks / 8.3 short paths / case
    // differences don't trick us into a self-copy.
    let same = match (src.canonicalize(), dest.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => src == dest,
    };
    if same {
        tracing::info!(?dest, "installer already at destination; skipping self-copy");
        return Ok(());
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(&src, &dest)?;
    repair_macos_installer_helper(&dest);
    tracing::info!(?src, ?dest, "copied installer to YOUTAB_AGENT_HOME");
    Ok(())
}

#[cfg(target_os = "macos")]
fn repair_macos_installer_helper(path: &Path) {
    // The staged helper may inherit quarantine from the downloaded installer.
    // Desktop later launches this exact file for in-app updates, so make it
    // executable before the update handoff reaches LaunchServices/Gatekeeper.
    let _ = Command::new("/usr/bin/xattr")
        .args(["-cr"])
        .arg(path)
        .status();

    let verify = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg(path)
        .status();

    if !matches!(verify, Ok(status) if status.success()) {
        let _ = Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(path)
            .status();
    }
}

#[cfg(not(target_os = "macos"))]
fn repair_macos_installer_helper(_path: &Path) {}

/// Where the bootstrap-complete marker lives (existence-only for the Rust
/// installer fast path; JSON schema-checked by the Electron app). Per main.ts:
///   const BOOTSTRAP_COMPLETE_MARKER = path.join(ACTIVE_YOUTAB_AGENT_ROOT, '.youtab-agent-runtime-bootstrap-complete')
/// We don't always know ACTIVE_YOUTAB_AGENT_ROOT until install.ps1 reports it, so
/// this is a probe helper, not a definitive path.
pub fn likely_bootstrap_marker(install_root: &Path) -> PathBuf {
    install_root.join(".youtab-agent-runtime-bootstrap-complete")
}

/// Initializes tracing to bootstrap-installer.log under YOUTAB_AGENT_HOME/logs/.
/// Returns a guard that flushes the appender on drop — keep it alive for
/// the lifetime of the process.
pub fn init_logging() -> Option<WorkerGuard> {
    #[cfg(windows)]
    if option_env!("RELEASE_BASE_URL").is_some() {
        match customer_home().and_then(|home| prepare_fresh_customer_home(&home)) {
            Ok(()) => {},
            Err(_) => { eprintln!("[youtab-setup] home selection refused"); return None; }
        }
    }
    let dir = log_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        // No log dir → log to stderr only. Don't panic; the installer
        // should still be usable on an exotic filesystem.
        eprintln!("[youtab-setup] could not create diagnostic log directory");
        return None;
    }

    let file_appender = match crate::diagnostics::BoundedLog::new(&log_path(), crate::diagnostics::MAX_LOG_BYTES) {
        Ok(writer) => writer,
        Err(_) => { eprintln!("[youtab-setup] could not open diagnostic log"); return None; }
    };
    let (non_blocking, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(256).lossy(true).finish(file_appender);
    let _ = LOG_DROPS.set(non_blocking.error_counter());

    let env_filter = tracing_subscriber::EnvFilter::try_from_env("YOUTAB_AGENT_BOOTSTRAP_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(move || DiagnosticWriter { inner: non_blocking.clone(), record: Vec::new(), oversized: false })
        .with_ansi(false)
        .with_target(true)
        .init();

    Some(guard)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_log_path() -> String {
    log_path().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn report_frontend_failure(kind: String) -> Result<(), String> {
    match kind.as_str() {
        "render" | "async" | "initialize" => {
            tracing::error!(component = "setup-ui", code = %kind, "installer interface failed; backend work may still be running");
            Ok(())
        }
        _ => Err("unsupported diagnostic code".into()),
    }
}

#[tauri::command]
pub fn get_dropped_log_count() -> usize {
    LOG_DROPS.get().map(|counter| counter.dropped_lines()).unwrap_or(0)
}

#[tauri::command]
pub fn get_youtab_home() -> String {
    youtab_home().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = log_dir();
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn trace_record_retains_only_validated_operation_and_code() {
        let raw = b"operation_id=123e4567-e89b-42d3-a456-426614174000 diagnostic_code=\"SETUP_STAGE_FAILED\" stage=\"verify\" syntheticOpaqueCompanyCanary9971";
        let summary = private_trace_record(raw, false);
        assert!(summary.contains("operation_id=123e4567-e89b-42d3-a456-426614174000"));
        assert!(summary.contains("code=SETUP_STAGE_FAILED"));
        assert!(summary.contains("stage=verify"));
        assert!(!summary.contains("syntheticOpaqueCompanyCanary9971"));
    }

    #[test]
    fn setup_channel_hint_never_persists_private_detail() {
        let summary = private_trace_record(format!("diagnostic_stage=\"setup-channel\" {} syntheticOpaqueCompanyCanary9971", crate::events::SETUP_CHANNEL_UNPUBLISHED).as_bytes(), false);
        assert!(summary.contains("stage=setup-channel"));
        assert!(summary.contains("hint=setup-channel"));
        assert!(!summary.contains("syntheticOpaqueCompanyCanary9971"));
    }

    #[test]
    fn tracing_sink_redacts_split_fields_and_flushes_safe_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bootstrap-installer.log");
        let writer = crate::diagnostics::BoundedLog::new(&path, 1024).unwrap();
        let (queue, guard) = tracing_appender::non_blocking(writer);
        let subscriber = tracing_subscriber::fmt().with_ansi(false)
            .with_writer(move || DiagnosticWriter { inner: queue.clone(), record: Vec::new(), oversized: false })
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(password = "synthetic credential", "download failed");
            tracing::info!(stage = "verify", "safe stage completed");
            tracing::warn!(target: "bootstrap.log", stage = "repository", "syntheticOpaqueCompanyCanary9971");
            tracing::warn!(target: "bootstrap.log", stage = "desktop", "SELF_SIGNED_CERT_IN_CHAIN syntheticOpaqueCompanyCanary9971");
        });
        drop(guard);
        let log = std::fs::read_to_string(path).unwrap();
        assert!(!log.contains("synthetic credential"));
        assert!(!log.contains("syntheticOpaqueCompanyCanary9971"));
        assert!(log.contains("stage=verify"));
        assert!(log.contains("stage=repository"));
        assert!(log.contains("hint=tls-cert-trust"));
        assert!(log.contains("details omitted"));
    }

    #[test]
    fn oversized_record_cannot_leak_a_later_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bootstrap-installer.log");
        let writer = crate::diagnostics::BoundedLog::new(&path, 1024).unwrap();
        let (queue, guard) = tracing_appender::non_blocking(writer);
        let mut record = DiagnosticWriter { inner: queue, record: Vec::new(), oversized: false };
        record.write_all(&vec![b'a'; 65537]).unwrap();
        record.write_all(b"arbitrary synthetic private value").unwrap();
        drop(record); drop(guard);
        assert_eq!(std::fs::read_to_string(path).unwrap(), "[oversized diagnostic omitted]\n");
    }

    #[test]
    fn full_log_queue_does_not_block_the_producer_and_counts_drops() {
        use std::sync::mpsc;
        use std::time::Duration;
        struct SlowWriter { entered: mpsc::Sender<()>, release: mpsc::Receiver<()> }
        impl Write for SlowWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                let _ = self.entered.send(());
                let _ = self.release.recv();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (mut queue, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
            .buffered_lines_limit(1).lossy(true)
            .finish(SlowWriter { entered: entered_tx, release: release_rx });
        queue.write_all(b"first\n").unwrap();
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        queue.write_all(b"fills queue\n").unwrap();
        let counter = queue.error_counter();
        let (done_tx, done_rx) = mpsc::channel();
        let producer = std::thread::spawn(move || {
            let record = DiagnosticWriter { inner: queue, record: b"safe dropped record\n".to_vec(), oversized: false };
            drop(record);
            let _ = done_tx.send(());
        });
        let returned_without_draining = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        // Always release before asserting so a regression cannot strand a worker.
        drop(release_tx);
        producer.join().unwrap(); drop(guard);
        assert!(returned_without_draining, "UI producer blocked on a full diagnostic queue");
        assert_eq!(counter.dropped_lines(), 1);
    }
}

#[cfg(all(test, windows))]
mod customer_home_tests {
    use super::*;

    #[test]
    fn only_a_truly_fresh_user_gets_the_profile_direct_home() {
        let fixture = tempfile::tempdir().unwrap();
        let profile = fixture.path().join("profile");
        let local = fixture.path().join("appdata").join("youtab");
        std::fs::create_dir_all(&profile).unwrap();
        assert_eq!(choose_customer_home(None, None, &local, &profile).unwrap(),
            CustomerHome::Fresh(profile.join("Youtab")));
        std::fs::create_dir_all(&local).unwrap();
        assert_eq!(choose_customer_home(None, None, &local, &profile).unwrap(), CustomerHome::Existing(local.clone()));
        std::fs::remove_dir(&local).unwrap();
        let legacy = profile.join(".youtab-agent-runtime");
        std::fs::create_dir(&legacy).unwrap();
        assert_eq!(choose_customer_home(None, None, &local, &profile).unwrap(), CustomerHome::Existing(legacy));
    }

    #[test]
    fn registered_home_wins_and_conflicting_process_home_is_refused() {
        let fixture = tempfile::tempdir().unwrap();
        let profile = fixture.path();
        let local = profile.join("AppData/youtab");
        let registered = profile.join("selected");
        std::fs::create_dir_all(&local).unwrap();
        assert_eq!(choose_customer_home(None, Some(registered.clone()), &local, profile).unwrap(),
            CustomerHome::Existing(registered.clone()));
        assert_eq!(choose_customer_home(Some(registered.clone()), Some(registered.clone()), &local, profile).unwrap(),
            CustomerHome::Existing(registered));
        assert_eq!(choose_customer_home(Some(profile.join("stale")), Some(profile.join("selected")), &local, profile),
            Err("home-binding-conflict"));
    }

    #[test]
    fn unrelated_fresh_target_is_never_adopted() {
        let fixture = tempfile::tempdir().unwrap();
        let leaf = fixture.path().join("Youtab");
        std::fs::create_dir(&leaf).unwrap();
        let result = prepare_fresh_customer_home(&CustomerHome::Fresh(leaf.clone()));
        assert!(result.is_err());
        assert!(!leaf.join(".youtab-fresh-home-v1").exists());
    }

    #[test]
    fn interrupted_preparation_retries_without_adopting_orphan() {
        let qa_root = std::env::var_os("YOUTAB_NATIVE_PRIVATE_QA_ROOT")
            .map(PathBuf::from).expect("explicit qualified disposable QA parent required");
        let fixture = tempfile::Builder::new().prefix("fresh-home-")
            .tempdir_in(qa_root).unwrap();
        let leaf = fixture.path().join("Youtab");
        let orphan = fixture.path().join(".Youtab-stage-interrupted");
        std::fs::create_dir(&orphan).unwrap();
        std::fs::write(orphan.join(".youtab-fresh-home-v1"), b"youtab-fresh-home-v1\n").unwrap();
        prepare_fresh_customer_home(&CustomerHome::Fresh(leaf.clone())).unwrap();
        assert_eq!(std::fs::read(leaf.join(".youtab-fresh-home-v1")).unwrap(),
            b"youtab-fresh-home-v1\n");
        assert!(orphan.exists());
        prepare_fresh_customer_home(&CustomerHome::Fresh(leaf)).unwrap();
    }
}
