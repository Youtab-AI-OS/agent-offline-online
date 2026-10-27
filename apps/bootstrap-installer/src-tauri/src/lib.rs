//! Youtab Setup — Tauri entrypoint.
//!
//! Spawns a single window pointed at the React frontend (apps/bootstrap-installer/src/).
//! All install-time work lives in `bootstrap.rs` and is invoked through the Tauri
//! commands registered at the bottom of `run()`.
//!
//! The Windows-subsystem strip lives on the binary crate (src/main.rs), not
//! here — a crate-level attribute on a lib doesn't propagate to the linker
//! flags of the executable that consumes it.

mod bootstrap;
mod diagnostics;
mod home_relocation;
mod events;
mod install_script;
mod powershell;
mod paths;
mod update;
mod update_coordination;
#[cfg(windows)]
mod webview_prereq;
pub use update_coordination::run_headless_if_requested;
pub use update_coordination::claim_stage_child_if_requested;

use std::sync::Arc;
use tokio::sync::Mutex;
#[cfg(windows)]
use std::{io::BufRead, process::{Command, Stdio}, time::Duration};

/// How the installer was invoked. Resolved once from the process args in
/// `run()` and exposed to the frontend via `get_mode` so it can route to the
/// install flow (first-run onboarding) or the update flow (driven by the
/// desktop app handing off via `Youtab-Setup.exe --update`).
///
/// Bare launch (double-click, first-run) => Install.
/// `--update` (spawned by the desktop's "Update" button) => Update.
/// `--repair`/`--reinstall` (native recovery handoff) => Repair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    Install,
    Update,
    Repair,
}

impl AppMode {
    /// Resolve the mode from an argument iterator. Repair takes precedence
    /// over Update so mixed flags cannot bypass repair validation. Kept arg-iterator
    /// generic (not reading `std::env` directly) so it's unit-testable.
    pub fn from_args<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut update = false;
        for a in args {
            if a.as_ref() == "--repair" || a.as_ref() == "--reinstall" {
                return AppMode::Repair;
            }
            if a.as_ref() == "--update" {
                update = true;
            }
        }
        if update { AppMode::Update } else { AppMode::Install }
    }
}

/// Returns true when the args request a forced installer UI (repair/reinstall)
/// via `--reinstall` or `--repair`, which overrides the macOS launcher
/// fast-path so a broken install can be repaired. Arg-iterator generic so it's
/// unit-testable, mirroring `AppMode::from_args`.
pub fn force_setup_from_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|a| a.as_ref() == "--reinstall" || a.as_ref() == "--repair" || a.as_ref() == "--migrate-legacy")
}

/// Process-wide install state, shared across Tauri commands.
///
/// The bootstrap is a one-shot, single-tenant process — we only need one
/// of these per window. `Arc<Mutex<...>>` lets command handlers grab it
/// without lifetime gymnastics.
pub struct AppState {
    pub bootstrap: Mutex<Option<bootstrap::BootstrapHandle>>,
    /// Protected by `bootstrap` when starting either install or location handoff.
    pub location_handoff: std::sync::atomic::AtomicBool,
    /// How this process was launched (install vs update). Immutable for the
    /// lifetime of the process; read by the `get_mode` command.
    pub mode: AppMode,
}

impl AppState {
    fn new(mode: AppMode) -> Self {
        Self {
            bootstrap: Mutex::new(None),
            location_handoff: std::sync::atomic::AtomicBool::new(false),
            mode,
        }
    }
}

/// Frontend → Rust: which flow should the UI render?
#[tauri::command]
fn get_mode(state: tauri::State<'_, Arc<AppState>>) -> AppMode {
    state.mode
}

#[tauri::command]
fn get_release_channel() -> Result<String, String> {
    update::release_channel_for_install(&probed_home()?.join("youtab-agent-runtime"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_installation_kind() -> Result<String, String> {
    #[cfg(windows)]
    if option_env!("RELEASE_BASE_URL").is_some() {
        if let Some(intent) = home_relocation::startup_intent()
            .map_err(|_| "Installation relocation needs review".to_owned())?
        {
            return selected_relocation_kind(&intent);
        }
    }
    let root = probed_home()?.join("youtab-agent-runtime");
    installation_kind(&root, option_env!("RELEASE_BASE_URL").is_some() && cfg!(target_os = "windows"))
}

#[cfg(windows)]
fn selected_relocation_kind(intent: &home_relocation::StartupIntent) -> Result<String, String> {
    let parent = intent.target.parent().ok_or("Installation relocation needs review")?;
    let selected = home_relocation::selected_location_target(&intent.source, parent)
        .map_err(|_| "Installation relocation needs review".to_owned())?;
    if !paths::same_windows_path(&selected, &intent.target) {
        return Err("Installation relocation needs review".into());
    }
    // A matching journal may contain a partially built runtime or even its
    // completion marker. It must finish the preserving relocation transaction,
    // never enter the unrelated artifact-update route.
    Ok("relocation".into())
}

fn probed_home() -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    if option_env!("RELEASE_BASE_URL").is_some() {
        return paths::customer_home().map(|selected| selected.path().to_owned())
            .map_err(|reason| format!("customer home selection refused: {reason}"));
    }
    Ok(paths::youtab_home())
}

fn installation_kind(root: &std::path::Path, legacy_allowed: bool) -> Result<String, String> {
    if root.is_symlink() {return Err("Installation needs review before replacement".to_owned());}
    if !root.exists() {return Ok("fresh".to_owned());}
    let marker_path = root.join(".youtab-agent-runtime-bootstrap-complete");
    if marker_path.is_symlink() {return Err("Installation needs review before replacement".to_owned());}
    if std::fs::metadata(&marker_path).map_err(|_| "Installation needs review before replacement")?.len() > 65536 {
        return Err("Installation metadata is too large".to_owned());
    }
    let bytes = std::fs::read(marker_path).map_err(|_| "Installation needs review before replacement".to_owned())?;
    let marker: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "Installation metadata is unreadable".to_owned())?;
    if marker.get("releaseSequence").is_some_and(|v| !v.is_null()) {
        let valid_hex = |key: &str, length: usize| marker.get(key).and_then(serde_json::Value::as_str)
            .is_some_and(|value| value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        if marker.get("releaseSequence").and_then(serde_json::Value::as_u64).unwrap_or(0) == 0
            || !valid_hex("pinnedCommit", 40) || !valid_hex("artifactSha256", 64)
            || marker.get("releaseBaseUrl").and_then(serde_json::Value::as_str).is_none() {
            return Err("Installation metadata needs review".to_owned());
        }
        return Ok("artifact".to_owned());
    }
    if marker.get("releaseBaseUrl").is_some_and(|v| !v.is_null()) || marker.get("artifactSha256").is_some_and(|v| !v.is_null()) {
        return Err("Installation metadata needs review".to_owned());
    }
    if legacy_allowed && !root.join(".git").is_symlink() && root.join(".git").is_dir() {
        return Ok("legacy".to_owned());
    }
    Err("This existing installation cannot be replaced automatically".to_owned())
}

// A bare Setup owns the default home for diagnostics. Choosing another
// location must restart with a pre-logging relocation intent, then copy and
// publish the previous home through the existing journaled transaction.
#[cfg(windows)]
#[tauri::command]
async fn change_install_location(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    parent: String,
    channel: String,
) -> Result<String, String> {
    if state.mode != AppMode::Install || option_env!("RELEASE_BASE_URL").is_none() {
        return Err("Location changes require the common Windows Setup install screen".into());
    }
    if home_relocation::startup_intent()
        .map_err(|_| "Finish the current location change before choosing another".to_owned())?
        .is_some()
    {
        return Err("Finish the current location change before choosing another".into());
    }
    crate::update::release_channel_from_args(["--channel", channel.as_str()])
        .map_err(|_| "Choose a valid update channel".to_owned())?;
    let source = paths::customer_home()
        .map_err(|_| "The current installation location needs review".to_owned())?;
    // The logging path creates a marked first-run home. Refuse a colliding
    // pre-existing directory instead of laundering its data as our source.
    paths::prepare_fresh_customer_home(&source)
        .map_err(|_| "The current installation location needs review".to_owned())?;
    let source = source.path().to_path_buf();
    let parent = std::path::PathBuf::from(parent);
    // Reject a broadly writable drive or parent before launching a second
    // process. Admission is read-only and applies the same native ACL policy
    // used later for the actual installation namespace.
    crate::update_coordination::admit_private_code_namespace(&parent)
        .map_err(|_| "This folder has unsafe permissions. Choose a private folder under your Windows profile.".to_owned())?;
    let target = home_relocation::selected_location_target(&source, &parent)
        .map_err(|_| "This location is unavailable or contains another installation. Choose an empty private folder.".to_owned())?;
    if paths::same_windows_path(&source, &target) { return Ok("unchanged".into()); }
    {
        let guard = state.bootstrap.lock().await;
        if guard.as_ref().is_some_and(|h| h.status.running)
            || state.location_handoff.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Wait for the current installation or location change to finish".into());
        }
        // start_bootstrap checks this flag while holding the same mutex.
        state.location_handoff.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let app_for_exit = app.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let executable = std::env::current_exe()
            .map_err(|_| "Setup could not locate its own executable".to_owned())?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut child = Command::new(executable)
            .arg("--relocate-home-v1").arg("--source-home").arg(&source)
            .arg("--target-home").arg(&target)
            .arg("--channel").arg(&channel)
            .arg("--location-ready-v1").arg(&token)
            .stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|_| "Setup could not restart at the selected location".to_owned())?;
        let stdout = child.stdout.take().ok_or("Setup readiness could not be checked")?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let read = std::io::BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(if read.is_ok() { line } else { String::new() });
        });
        let expected = format!("YOUTAB_LOCATION_READY={token}\n");
        if !matches!(rx.recv_timeout(Duration::from_secs(30)), Ok(line) if line == expected) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Setup could not open the selected location. The original Setup remains open.".into());
        }
        app_for_exit.exit(0);
        Ok("relaunching".to_owned())
    }).await;
    let result = joined.map_err(|_| "Setup location handoff was interrupted".to_owned());
    let result = result.and_then(|value| value);
    if result.is_err() {
        state.location_handoff.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    result
}

#[cfg(windows)]
fn location_ready_token() -> Option<String> {
    parse_location_ready_token(std::env::args().skip(1))
}

/// The original window stays open until the child has loaded and initialized
/// its frontend. Native window creation alone cannot prove that the UI works.
#[cfg(windows)]
#[tauri::command]
fn confirm_location_ready() -> Result<(), String> {
    let Some(token) = location_ready_token() else { return Ok(()); };
    let intent = home_relocation::startup_intent()
        .map_err(|_| "Setup location handoff could not be verified".to_owned())?
        .ok_or_else(|| "Setup location handoff could not be verified".to_owned())?;
    let ready = get_installation_kind().is_ok() && get_release_channel().is_ok()
        && probed_home().is_ok_and(|home| paths::same_windows_path(&home, &intent.target));
    if !ready { return Err("Setup location handoff could not be verified".into()); }
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "YOUTAB_LOCATION_READY={token}")
        .and_then(|_| stdout.flush())
        .map_err(|_| "Setup location handoff could not be confirmed".to_owned())
}

#[cfg(windows)]
fn parse_location_ready_token(args: impl IntoIterator<Item = String>) -> Option<String> {
    let args: Vec<_> = args.into_iter().collect();
    let index = args.iter().position(|arg| arg == "--location-ready-v1")?;
    if args.iter().filter(|arg| *arg == "--location-ready-v1").count() != 1 ||
        !args.iter().any(|arg| arg == "--relocate-home-v1") { return None; }
    let value = args.get(index + 1)?;
    uuid::Uuid::parse_str(value).ok().map(|_| value.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let operation = diagnostics::operation_id();
    std::panic::set_hook(Box::new(move |info| {
        // Panic payloads can be arbitrary secrets with no recognizable key.
        // Preserve the source location, never stringify the payload.
        let diagnostic = diagnostics::panic_diagnostic(info.location(), operation);
        // Release builds abort after this hook; stderr is a synchronous sink.
        eprintln!("{diagnostic}");
        tracing::error!(operation_id = %operation, "{diagnostic}");
    }));
    // Tracing → bootstrap-installer.log under YOUTAB_AGENT_HOME/logs/ so install
    // failures leave a trail for support. Console output also goes here in
    // debug builds.
    let relocation_intent = match home_relocation::startup_intent() {
        Ok(value) => value,
        Err(_) => { eprintln!("[youtab-setup] relocation intent refused"); return; }
    };
    let _relocation_namespace = if let Some(intent) = &relocation_intent {
        if !cfg!(windows) || option_env!("RELEASE_BASE_URL").is_none() {
            eprintln!("home relocation requires the common Windows customer Setup"); return;
        }
        match intent.prepare_before_logging() {
            Ok(namespace) => {
                std::env::set_var("YOUTAB_AGENT_HOME", &intent.target);
                std::env::set_var("YOUTAB_AGENT_RELOCATION_SOURCE", &intent.source);
                Some(namespace)
            }
            Err(_) => { eprintln!("[youtab-setup] relocation refused before logging"); return; }
        }
    } else { None };
    let _guard = paths::init_logging();
    if _guard.is_none() {
        #[cfg(windows)]
        if option_env!("RELEASE_BASE_URL").is_some() {
            webview_prereq::show_error(
                "Youtab Setup could not create its diagnostic log in the selected home. Check the folder permissions and available disk space, then try again. No installation was started.",
            );
            std::process::exit(2);
        }
        if relocation_intent.is_some() {
            eprintln!("[youtab-setup] relocation logging unavailable; handoff refused");
            return;
        }
    }

    let mode = AppMode::from_args(std::env::args().skip(1));
    // Escape hatch: `--reinstall`/`--repair` forces the installer UI even when
    // Youtab is already installed, so users can re-run setup to repair a broken
    // install instead of the launcher fast path silently relaunching the app.
    let force_setup = force_setup_from_args(std::env::args().skip(1));
    tracing::info!(?mode, force_setup, "Youtab installer starting");

    // The single-file Windows Setup must also launch on a clean PC without
    // WebView2.  A Tauri window cannot explain a missing webview prerequisite.
    #[cfg(windows)]
    if !webview_prereq::ensure_before_tauri() {
        // process::exit skips destructors; flush the async diagnostic writer
        // so the native prerequisite error is retained for support.
        drop(_guard);
        std::process::exit(2);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::new(AppState::new(mode)))
        .setup(move |app| {
            use tauri::Manager;
            // Launcher fast path (macOS only): a bare ("Install") launch when
            // Youtab is already installed should NOT show the installer or
            // rebuild — it should just open the app, so the /Applications
            // "Youtab" doubles as a normal launcher (first run installs, every
            // later run launches instantly). The window is kept hidden until
            // here via `"visible": false` so this path never flashes a window.
            //
            // Gated to macOS deliberately: on Windows/Linux the installer keeps
            // its existing behavior (Windows users relaunch via the Start
            // Menu/Desktop "Youtab" shortcuts that install.ps1 creates, and a
            // reliable detached relaunch there needs the DETACHED_PROCESS +
            // startup-grace handling used by launch_youtab_desktop — out of
            // scope here). So this is a pure no-op on non-macOS.
            //
            // `--reinstall`/`--repair` opts out so a broken install can be
            // repaired by re-running setup instead of launching the bad app.
            if cfg!(target_os = "macos") && mode == AppMode::Install && !force_setup {
                let install_root = paths::youtab_home().join("youtab-agent-runtime");
                if bootstrap::youtab_is_installed(&install_root) {
                    match bootstrap::spawn_installed_desktop(&install_root) {
                        Ok(()) => {
                            // Brief grace so the spawned app is registered
                            // before we exit (mirrors launch_youtab_desktop).
                            std::thread::sleep(std::time::Duration::from_millis(200));
                            tracing::info!(
                                "youtab already installed — relaunched desktop; exiting installer"
                            );
                            app.handle().exit(0);
                            return Ok(());
                        }
                        Err(err) => {
                            tracing::warn!(
                                ?err,
                                "relaunch of installed desktop failed; showing installer UI"
                            );
                        }
                    }
                }
            }
            // First run / repair install, or Update mode: reveal the UI.
            match app.get_webview_window("main") {
                Some(win) => {
                    if let Err(err) = win.show() {
                        tracing::error!(?err, "failed to show main installer window");
                    }
                }
                None => {
                    tracing::error!("main installer window not found; installer UI will not appear");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Mode (install vs update)
            get_mode,
            get_installation_kind,
            get_release_channel,
            #[cfg(windows)]
            change_install_location,
            #[cfg(windows)]
            confirm_location_ready,
            // Bootstrap lifecycle
            bootstrap::start_bootstrap,
            bootstrap::cancel_bootstrap,
            bootstrap::get_bootstrap_status,
            // Update lifecycle
            update::start_update,
            // Hand-off
            bootstrap::launch_youtab_desktop,
            // Diagnostics
            paths::get_log_path,
            paths::report_frontend_failure,
            paths::get_dropped_log_count,
            paths::get_youtab_home,
            paths::open_log_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Youtab Setup");
}

#[cfg(test)]
mod tests {
    use super::{force_setup_from_args, AppMode};

    #[cfg(windows)]
    #[test]
    fn location_ready_requires_exact_relocation_intent_and_one_uuid() {
        let token = "123e4567-e89b-42d3-a456-426614174000";
        let valid = vec!["--relocate-home-v1", "--location-ready-v1", token];
        assert_eq!(super::parse_location_ready_token(valid.into_iter().map(str::to_owned)), Some(token.into()));
        for invalid in [
            vec!["--location-ready-v1", token],
            vec!["--relocate-home-v1", "--location-ready-v1", "not-a-uuid"],
            vec!["--relocate-home-v1", "--location-ready-v1", token, "--location-ready-v1", token],
        ] {
            assert!(super::parse_location_ready_token(invalid.into_iter().map(str::to_owned)).is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn pending_selected_location_stays_install_even_with_partial_or_completed_runtime() {
        let fixture = crate::update_coordination::relocation_test_fixture();
        let source = fixture.path().join("old");
        let parent = fixture.path().join("chosen");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&parent).unwrap();
        let target = parent.join("Youtab");
        let intent = crate::home_relocation::StartupIntent { source, target: target.clone() };
        let namespace = intent.prepare_before_logging().unwrap();
        crate::home_relocation::Relocation::begin(&intent.source, &target, &namespace).unwrap();
        let runtime = target.join("youtab-agent-runtime");
        std::fs::create_dir(&runtime).unwrap();
        assert_eq!(super::selected_relocation_kind(&intent).unwrap(), "relocation");
        std::fs::write(runtime.join(".youtab-agent-runtime-bootstrap-complete"), b"{}").unwrap();
        assert_eq!(super::selected_relocation_kind(&intent).unwrap(), "relocation");
        std::fs::remove_file(target.join(".youtab-home-relocation-v1.json")).unwrap();
        assert!(super::selected_relocation_kind(&intent).is_err());
    }

    #[test]
    fn installation_preview_preserves_unknown_or_partial_installs() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("runtime");
        assert_eq!(super::installation_kind(&root, true).unwrap(), "fresh");
        std::fs::create_dir(&root).unwrap();
        assert!(super::installation_kind(&root, true).is_err());
        let marker = root.join(".youtab-agent-runtime-bootstrap-complete");
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(&marker, b"{}").unwrap();
        assert_eq!(super::installation_kind(&root, true).unwrap(), "legacy");
        assert!(super::installation_kind(&root, false).is_err());
        for bad in [serde_json::json!({"releaseSequence": true}), serde_json::json!({"releaseSequence": 0}), serde_json::json!({"artifactSha256": "partial"})] {
            std::fs::write(&marker, bad.to_string()).unwrap();
            assert!(super::installation_kind(&root, true).is_err());
        }
        std::fs::write(&marker, serde_json::json!({"releaseSequence": 3, "pinnedCommit": "a".repeat(40), "artifactSha256": "b".repeat(64), "releaseBaseUrl": "https://api.youtab.io/pilot-runtime-example/releases"}).to_string()).unwrap();
        assert_eq!(super::installation_kind(&root, true).unwrap(), "artifact");
    }

    #[test]
    fn bare_args_are_install() {
        assert_eq!(AppMode::from_args(Vec::<String>::new()), AppMode::Install);
        assert_eq!(AppMode::from_args(["--foo", "bar"]), AppMode::Install);
    }

    #[test]
    fn update_flag_selects_update() {
        assert_eq!(AppMode::from_args(["--update"]), AppMode::Update);
        assert_eq!(
            AppMode::from_args(["--something", "--update", "--else"]),
            AppMode::Update
        );
    }

    #[test]
    fn reinstall_and_repair_flags_force_setup() {
        assert!(force_setup_from_args(["--reinstall"]));
        assert!(force_setup_from_args(["--repair"]));
        assert!(force_setup_from_args(["--migrate-legacy"]));
        assert!(force_setup_from_args(["--foo", "--repair", "--bar"]));
    }

    #[test]
    fn bare_or_unrelated_args_do_not_force_setup() {
        assert!(!force_setup_from_args(Vec::<String>::new()));
        assert!(!force_setup_from_args(["--foo", "bar"]));
        // --update must not be mistaken for a force-setup flag.
        assert!(!force_setup_from_args(["--update"]));
    }

    #[test]
    fn repair_flags_select_repair_even_with_update_flag() {
        assert_eq!(AppMode::from_args(["--repair"]), AppMode::Repair);
        assert_eq!(AppMode::from_args(["--reinstall"]), AppMode::Repair);
        assert_eq!(
            AppMode::from_args(["--update", "--reinstall"]),
            AppMode::Repair
        );
    }
}
