//! Bootstrap orchestration.
//!
//! Direct port of `runBootstrap` from `apps/desktop/electron/bootstrap-runner.ts`.
//! Drives install.ps1 / install.sh stage-by-stage, emits progress events
//! over the Tauri `bootstrap` channel, writes a forensic log to
//! YOUTAB_AGENT_HOME/logs/bootstrap-<timestamp>.log.
//!
//! Lifecycle:
//!   1. `start_bootstrap` (Tauri command) â†’ spawns the worker task.
//!   2. Worker resolves install script (dev/cache/download).
//!   3. Worker calls `install.ps1 -Manifest` â†’ emits `manifest` event.
//!   4. Worker iterates stages, calling `install.ps1 -Stage NAME -NonInteractive -Json`.
//!   5. On success â†’ `complete`. On any stage failure â†’ `failed`. On cancel â†’ `failed`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};

use crate::events::{BootstrapEvent, LogStream, Manifest, StageState};
use crate::install_script::{self, Pin, ScriptKind, ScriptSource};
use crate::powershell::{self, StreamSink};
use crate::AppState;

/// The existing Setup process is outside the install tree, so it can own the
/// whole-tree swap while each PowerShell provisioning stage runs at the final
/// path. Dropping an uncommitted swap restores the prior install on errors,
/// cancellation, and early returns.
struct InstallSwap {
    current: PathBuf,
    committed: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallJournal {
    schema: u32,
    had_old: bool,
    setup: Option<SetupJournal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_head_sha: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupJournal {
    replace: bool,
    previous_sha256: Option<String>,
    required_sha256: String,
}

impl InstallSwap {
    fn backup_path(current: &Path) -> Result<PathBuf> {
        let parent = current.parent().context("install root has no parent")?;
        Ok(parent.join(format!("{}.old-backup", current.file_name().unwrap().to_string_lossy())))
    }

    fn legacy_archive_path(current: &Path) -> Result<PathBuf> {
        let parent = current.parent().context("install root has no parent")?;
        Ok(parent.join(format!("{}.legacy-preserved-v1", current.file_name().unwrap().to_string_lossy())))
    }

    fn marker_path(current: &Path, suffix: &str) -> Result<PathBuf> {
        let parent = current.parent().context("install root has no parent")?;
        Ok(parent.join(format!(".youtab-runtime-install-{suffix}")))
    }

    #[cfg(test)]
    fn write_pending(current: &Path, had_old: bool) -> Result<()> {
        Self::write_journal(current, &InstallJournal { schema: 2, had_old, setup: None, legacy_head_sha: None })
    }

    fn write_journal(current: &Path, journal: &InstallJournal) -> Result<()> {
        use std::io::Write;
        let path = Self::marker_path(current, "pending")?;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .with_context(|| format!("creating transaction marker {}", path.display()))?;
        file.write_all(&serde_json::to_vec(journal)?)?;
        file.sync_all()?;
        Ok(())
    }

    fn read_journal(current: &Path) -> Result<InstallJournal> {
        let bytes = std::fs::read(Self::marker_path(current, "pending")?)?;
        // Replay transactions left by the previous Runtime-only implementation.
        let journal = match bytes.as_slice() {
            b"old\n" | b"old" => InstallJournal { schema: 2, had_old: true, setup: None, legacy_head_sha: None },
            b"fresh\n" | b"fresh" => InstallJournal { schema: 2, had_old: false, setup: None, legacy_head_sha: None },
            _ => serde_json::from_slice::<InstallJournal>(&bytes)?,
        };
        let hash_valid = |hash: &str| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
        let legacy_valid = match &journal.legacy_head_sha {
            Some(sha) => journal.schema == 3 && journal.had_old && sha.len() == 40
                && sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            None => journal.schema == 2,
        };
        if !legacy_valid || journal.setup.as_ref().is_some_and(|setup|
            !hash_valid(&setup.required_sha256) ||
            setup.previous_sha256.as_ref().is_some_and(|hash| !hash_valid(hash)) ||
            (!setup.replace && setup.previous_sha256.as_ref() != Some(&setup.required_sha256))) {
            return Err(anyhow!("invalid Runtime/Setup transaction journal"));
        }
        Ok(journal)
    }

    fn setup_paths(current: &Path) -> Result<(PathBuf, PathBuf, PathBuf)> {
        let target = crate::paths::installer_dest_in(current.parent().context("install root has no parent")?);
        let name = target.file_name().unwrap().to_string_lossy();
        Ok((target.clone(), target.with_file_name(format!("{name}.new-staged")),
            target.with_file_name(format!("{name}.old-backup"))))
    }

    fn refuse_foreign_recovery_paths(current: &Path) -> Result<()> {
        let (setup_target, _, _) = Self::setup_paths(current)?;
        for active in [current, setup_target.as_path()] {
            let failed = active.with_file_name(format!("{}.failed-recovery",
                active.file_name().context("active install path has no name")?.to_string_lossy()));
            match std::fs::symlink_metadata(&failed) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Ok(_) => return Err(anyhow!("pre-existing failed recovery path requires review")),
                Err(error) => return Err(error).context("failed recovery path could not be inspected"),
            }
        }
        Ok(())
    }

    fn remove_setup_file(path: &Path) -> Result<()> {
        if path.exists() {
            if !std::fs::symlink_metadata(path)?.is_file() {
                return Err(anyhow!("Setup transaction path is not a regular file"));
            }
            std::fs::remove_file(path)?;
        }
        Ok(())
    }

    fn restore_path(current: &Path, backup: &Path, had_old: bool, directory: bool) -> Result<()> {
        let failed = current.with_file_name(format!("{}.failed-recovery", current.file_name().unwrap().to_string_lossy()));
        if backup.exists() || !had_old {
            if failed.exists() && current.exists() {
                return Err(anyhow!("ambiguous failed recovery directory/file; backup retained"));
            }
            if current.exists() {
                std::fs::rename(current, &failed).with_context(|| "moving failed install out of active path")?;
            }
            if backup.exists() {
                // A failed rename leaves backup + journal + failed path intact;
                // the next recovery retries instead of deleting the old install.
                std::fs::rename(backup, current).with_context(|| "restoring previous install")?;
            }
        } else if !current.exists() {
            return Err(anyhow!("previous install and its backup are both absent"));
        }
        // Also retry cleanup when restoring the backup succeeded but deleting
        // the failed replacement was interrupted on the previous recovery.
        if failed.exists() {
            if directory { std::fs::remove_dir_all(failed)?; }
            else { Self::remove_setup_file(&failed)?; }
        }
        Ok(())
    }

    fn restore_setup(current: &Path, setup: &SetupJournal) -> Result<()> {
        let (target, staged, backup) = Self::setup_paths(current)?;
        if !setup.replace {
            crate::paths::verify_installer(&target, &setup.required_sha256)?;
            return Ok(());
        }
        if let Some(previous) = &setup.previous_sha256 {
            crate::paths::verify_installer(if backup.exists() { &backup } else { &target }, previous)
                .context("previous Setup identity could not be verified; backups retained")?;
        }
        Self::restore_path(&target, &backup, setup.previous_sha256.is_some(), false)?;
        if let Some(previous) = &setup.previous_sha256 {
            crate::paths::verify_installer(&target, previous)?;
        }
        Self::remove_setup_file(&staged)?;
        Ok(())
    }

    /// Replay an interrupted Setup transaction before starting a new one.
    /// A committed marker means verification finished and only backup cleanup
    /// was interrupted; a pending marker restores the previous install.
    fn recover(current: &Path) -> Result<()> {
        // Recovery can otherwise mistake an unrelated pre-existing
        // `.failed-recovery` object for its own quarantine and delete it.
        // The old journal does not bind that path to an identity, so preserve
        // the object and require manual review instead of guessing ownership.
        Self::refuse_foreign_recovery_paths(current)?;
        let pending = Self::marker_path(current, "pending")?;
        let committed = Self::marker_path(current, "committed")?;
        let backup = Self::backup_path(current)?;
        let (_, setup_staged, setup_backup) = Self::setup_paths(current)?;
        if !pending.exists() {
            if backup.exists() || setup_staged.exists() || setup_backup.exists() {
                return Err(anyhow!("orphaned Runtime transaction state requires review"));
            }
            // Journal removal is the last cleanup step before deleting this
            // latch. A crash between them must not strand a verified install.
            Self::remove_setup_file(&committed)?;
            return Ok(());
        }
        let journal = Self::read_journal(current)?;
        if committed.exists() {
            if std::fs::read(&committed)? != b"verified\n" || !current.is_dir() {
                return Err(anyhow!("invalid committed transaction; backups retained"));
            }
            if let Some(setup) = &journal.setup {
                let (target, _, _) = Self::setup_paths(current)?;
                crate::paths::verify_installer(&target, &setup.required_sha256)
                    .context("committed Setup verification failed; backups retained")?;
            }
            if let Some(expected) = &journal.legacy_head_sha {
                // The initial Git-to-artifact transition retains the ENTIRE old
                // tree, including .git, carried commits and untracked files.
                // This path is never reused as an update cleanup directory.
                let archive = Self::legacy_archive_path(current)?;
                if backup.exists() {
                    if archive.exists() || archive.is_symlink() {
                        return Err(anyhow!("legacy archive already exists; both installs retained"));
                    }
                    if legacy_git_head(&backup)? != *expected {
                        return Err(anyhow!("legacy backup identity changed; backup retained"));
                    }
                    std::fs::rename(&backup, &archive).context("preserving legacy Runtime")?;
                }
                if legacy_git_head(&archive)? != *expected {
                    return Err(anyhow!("preserved legacy Runtime could not be verified"));
                }
            } else if backup.exists() {
                std::fs::remove_dir_all(&backup).with_context(|| "cleaning verified old Runtime")?;
            }
            Self::remove_setup_file(&setup_backup)?;
            Self::remove_setup_file(&setup_staged)?;
            std::fs::remove_file(pending)?;
            std::fs::remove_file(committed)?;
            return Ok(());
        }
        if let Some(setup) = &journal.setup {
            Self::restore_setup(current, setup)?;
        }
        Self::restore_path(current, &backup, journal.had_old, true)?;
        std::fs::remove_file(pending)?;
        Ok(())
    }

    #[cfg(test)]
    fn promote(current: &Path, staged: &Path) -> Result<Self> {
        Self::promote_with_setup(current, staged, None)
    }

    #[cfg(test)]
    fn promote_with_setup(current: &Path, staged: &Path, setup_source: Option<&Path>) -> Result<Self> {
        Self::promote_with_policy(current, staged, setup_source, None)
    }

    fn promote_with_policy(current: &Path, staged: &Path, setup_source: Option<&Path>, legacy_head_sha: Option<String>) -> Result<Self> {
        Self::refuse_foreign_recovery_paths(current)?;
        if let Some(expected) = &legacy_head_sha {
            if validate_legacy_migration(current)? != *expected {
                return Err(anyhow!("legacy install changed before promotion"));
            }
        }
        let parent = current.parent().context("install root has no parent")?;
        let staged_parent = staged.parent().context("staging root has no parent")?;
        let prefix = format!("{}.new-", current.file_name().unwrap().to_string_lossy());
        let name = staged.file_name().context("staging root has no name")?.to_string_lossy();
        if staged_parent != parent || !name.starts_with(&prefix) || staged.is_symlink() || !staged.is_dir() {
            return Err(anyhow!("invalid staged Runtime directory"));
        }
        let backup_path = Self::backup_path(current)?;
        let (setup_target, setup_staged, setup_backup) = Self::setup_paths(current)?;
        if backup_path.exists() || Self::marker_path(current, "pending")?.exists()
            || Self::marker_path(current, "committed")?.exists() || setup_staged.exists() || setup_backup.exists() {
            return Err(anyhow!("previous Runtime transaction requires recovery"));
        }
        let had_old = current.exists();
        let setup = setup_source.map(|source| -> Result<SetupJournal> {
            let required_sha256 = crate::paths::installer_sha256(source)?;
            let previous_sha256 = if setup_target.exists() {
                Some(crate::paths::installer_sha256(&setup_target)?)
            } else { None };
            let same = match (source.canonicalize(), setup_target.canonicalize()) {
                (Ok(a), Ok(b)) => a == b,
                _ => source == setup_target,
            };
            Ok(SetupJournal { replace: !same, previous_sha256, required_sha256 })
        }).transpose()?;
        Self::write_journal(current, &InstallJournal { schema: if legacy_head_sha.is_some() { 3 } else { 2 }, had_old, setup, legacy_head_sha })?;
        // Own rollback BEFORE any copy or active-path mutation. The same
        // journal covers partial staging, Runtime promotion, and Setup rename.
        let swap = Self { current: current.to_path_buf(), committed: false };
        let journal = Self::read_journal(current)?;
        if let Some(setup) = &journal.setup {
            if setup.replace {
                crate::paths::stage_installer(setup_source.unwrap(), &setup_staged, &setup.required_sha256)?;
            } else {
                crate::paths::verify_installer(&setup_target, &setup.required_sha256)?;
            }
        }
        if had_old {
            let backup = backup_path;
            std::fs::rename(current, &backup).with_context(|| "backing up current Runtime install")?;
        }
        std::fs::rename(staged, current).with_context(|| "promoting staged Runtime")?;
        Ok(swap)
    }

    fn install_setup(&mut self) -> Result<()> {
        let journal = Self::read_journal(&self.current)?;
        if let Some(setup) = &journal.setup {
            let (target, staged, backup) = Self::setup_paths(&self.current)?;
            if setup.replace {
                crate::paths::verify_installer(&staged, &setup.required_sha256)?;
                if let Some(previous) = &setup.previous_sha256 {
                    crate::paths::verify_installer(&target, previous)?;
                    std::fs::rename(&target, &backup).context("backing up previous Setup")?;
                }
                std::fs::rename(staged, &target).context("promoting verified Setup")?;
            }
            crate::paths::verify_installer(&target, &setup.required_sha256)?;
        }
        Ok(())
    }

    fn rollback(&mut self) -> Result<()> {
        if self.committed { return Ok(()); }
        Self::recover(&self.current)?;
        self.committed = true;
        Ok(())
    }

    fn commit(&mut self) -> Result<()> {
        let journal = Self::read_journal(&self.current)?;
        if let Some(setup) = &journal.setup {
            let (target, _, _) = Self::setup_paths(&self.current)?;
            crate::paths::verify_installer(&target, &setup.required_sha256)
                .context("required Setup missing or invalid; install cannot complete")?;
        }
        let marker = Self::marker_path(&self.current, "committed")?;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&marker)?;
        use std::io::Write;
        file.write_all(b"verified\n")?;
        file.sync_all()?;
        drop(file);
        self.committed = true;
        Self::recover(&self.current)?;
        Ok(())
    }
}

pub(crate) fn recover_artifact_transaction(root: &Path) -> Result<()> {
    InstallSwap::recover(root)
}

/// Repair only the installed common Setup for an unchanged Runtime release.
/// The caller holds the normal per-home install lock and has already bound the
/// running executable hash to the immutable release manifest. Reuse the same
/// durable Setup backup/rollback journal as a full Runtime transaction.
pub(crate) fn replace_setup_only(root: &Path, running: &Path, expected_sha256: &str) -> Result<()> {
    if !root.is_dir() || root.is_symlink() {
        return Err(anyhow!("Setup-only repair requires an installed Runtime"));
    }
    crate::paths::verify_installer(running, expected_sha256)?;
    InstallSwap::refuse_foreign_recovery_paths(root)?;
    InstallSwap::recover(root)?;
    let (target, staged, backup) = InstallSwap::setup_paths(root)?;
    if backup.exists() || staged.exists() {
        return Err(anyhow!("previous Setup transaction requires recovery"));
    }
    if crate::paths::verify_installer(&target, expected_sha256).is_ok() {
        return Ok(());
    }
    let previous_sha256 = if target.exists() {
        Some(crate::paths::installer_sha256(&target)?)
    } else { None };
    let setup = SetupJournal {
        replace: true, previous_sha256, required_sha256: expected_sha256.to_owned(),
    };
    InstallSwap::write_journal(root, &InstallJournal {
        schema: 2, had_old: true, setup: Some(setup), legacy_head_sha: None,
    })?;
    let mut swap = InstallSwap { current: root.to_owned(), committed: false };
    crate::paths::stage_installer(running, &staged, expected_sha256)?;
    swap.install_setup()?;
    swap.commit()?;
    crate::paths::verify_installer(&target, expected_sha256)?;
    Ok(())
}

impl Drop for InstallSwap {
    fn drop(&mut self) {
        if !self.committed {
            if self.rollback().is_err() {
                tracing::error!("CRITICAL: Runtime rollback failed; old backup retained");
            }
        }
    }
}

#[derive(Debug, Clone)]
struct ArtifactInstallInfo {
    staged: PathBuf,
    source_sha: String,
    artifact_sha256: String,
    version: String,
    release_sequence: u64,
    release_base_url: String,
    release_channel: String,
    setup_sha256: String,
    setup_size: u64,
}

impl ArtifactInstallInfo {
    fn from_stage_data(data: &serde_json::Value, pin: &Pin, base: &str) -> Result<Self> {
        let string = |key: &str| -> Result<String> {
            Ok(data.get(key).and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty()).ok_or_else(|| anyhow!("repository stage missing {key}"))?.to_string())
        };
        let source_sha = string("source_sha")?;
        if pin.commit.as_deref() != Some(source_sha.as_str()) {
            return Err(anyhow!("repository stage source SHA differs from Setup pin"));
        }
        let artifact_sha256 = string("artifact_sha256")?;
        if artifact_sha256.len() != 64 || !artifact_sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(anyhow!("repository stage artifact SHA256 is invalid"));
        }
        let release_base_url = string("release_base_url")?;
        if release_base_url != base {
            return Err(anyhow!("repository stage release base differs from Setup build"));
        }
        let release_sequence = data.get("release_sequence")
            .and_then(serde_json::Value::as_u64).filter(|n| *n > 0)
            .ok_or_else(|| anyhow!("repository stage release sequence is invalid"))?;
        let setup_sha256 = string("setup_sha256")?;
        let setup_size = data.get("setup_size").and_then(serde_json::Value::as_u64)
            .filter(|n| *n > 0 && *n <= 256 * 1024 * 1024)
            .ok_or_else(|| anyhow!("repository stage Setup size is invalid"))?;
        if string("setup_source_sha")? != source_sha
            || data.get("update_coordination_protocol").and_then(serde_json::Value::as_u64) != Some(1)
            || setup_sha256.len() != 64
            || !setup_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(anyhow!("repository stage common Setup identity is invalid"));
        }
        Ok(Self {
            setup_sha256, setup_size,
            staged: PathBuf::from(string("staged_install_dir")?),
            source_sha,
            artifact_sha256,
            version: string("version")?,
            release_sequence,
            release_base_url,
            release_channel: "stable".to_owned(),
        })
    }
}

fn legacy_git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut command = std::process::Command::new("git");
    command.arg("--no-optional-locks").arg("-C").arg(root).args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command.output().context("reading legacy Git identity")
}

/// Read only: no fetch, reset, checkout, hooks or credential access.
fn legacy_git_head(root: &Path) -> Result<String> {
    let git = root.join(".git");
    if root.is_symlink() || !root.is_dir() || git.is_symlink() || !git.is_dir() {
        return Err(anyhow!("legacy migration requires a standalone Git install"));
    }
    let output = legacy_git(root, &["rev-parse", "--verify", "HEAD"])?;
    let sha = String::from_utf8(output.stdout)?.trim().to_string();
    if !output.status.success() || sha.len() != 40
        || !sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(anyhow!("legacy Git identity is invalid"));
    }
    Ok(sha)
}

fn validate_legacy_migration(root: &Path) -> Result<String> {
    let marker_path = root.join(".youtab-agent-runtime-bootstrap-complete");
    if marker_path.is_symlink() || !marker_path.is_file() {
        return Err(anyhow!("legacy migration requires the existing bootstrap marker"));
    }
    let marker: serde_json::Value = serde_json::from_slice(&std::fs::read(marker_path)?)?;
    // An explicit migration flag must NEVER bypass artifact channel identity
    // or sequence checks, including partially damaged artifact metadata.
    if ["releaseBaseUrl", "releaseSequence", "artifactSha256"].iter()
        .any(|key| marker.get(*key).is_some_and(|v| !v.is_null())) {
        return Err(anyhow!("artifact installs must use the normal update/repair path"));
    }
    let pin = marker.get("pinnedCommit").and_then(serde_json::Value::as_str)
        .filter(|sha| sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        .ok_or_else(|| anyhow!("legacy marker has no valid source SHA"))?;
    let head = legacy_git_head(root)?;
    let status = legacy_git(root, &["merge-base", "--is-ancestor", pin, &head])?;
    if !status.status.success() {
        return Err(anyhow!("legacy marker is not in installed Git history"));
    }
    let archive = InstallSwap::legacy_archive_path(root)?;
    if archive.exists() || archive.is_symlink() {
        return Err(anyhow!("preserved legacy install already exists; review required"));
    }
    Ok(head)
}

fn ensure_replacement_not_downgrade(root: &Path, next: &ArtifactInstallInfo) -> Result<()> {
    let path = root.join(".youtab-agent-runtime-bootstrap-complete");
    if !path.exists() {
        if root.exists() {
            return Err(anyhow!("existing Runtime has no verified artifact marker; automatic replacement refused"));
        }
        return Ok(());
    }
    let old: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    if old.get("releaseBaseUrl").and_then(serde_json::Value::as_str)
        != Some(next.release_base_url.as_str()) {
        return Err(anyhow!("existing Runtime is bound to a different or legacy source"));
    }
    let old_sequence = old.get("releaseSequence").and_then(serde_json::Value::as_u64)
        .filter(|n| *n > 0).ok_or_else(|| anyhow!("existing Runtime has no release sequence"))?;
    let old_sha = old.get("pinnedCommit").and_then(serde_json::Value::as_str)
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or_else(|| anyhow!("existing Runtime has no valid source SHA"))?;
    let old_hash = old.get("artifactSha256").and_then(serde_json::Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or_else(|| anyhow!("existing Runtime has no valid artifact hash"))?;
    if next.release_sequence < old_sequence {
        return Err(anyhow!("Runtime artifact downgrade is forbidden"));
    }
    if next.release_sequence == old_sequence &&
        (old_sha != next.source_sha || old_hash != next.artifact_sha256) {
        return Err(anyhow!("release sequence was reused for different content"));
    }
    Ok(())
}

/// Exercise the installed backend's existing ready-file and /api/health path
/// before retiring the prior install. The probe has its own empty home and
/// never exposes the user's session or credentials to this synthetic server.
async fn verify_installed_backend(install_root: &Path, youtab_home: &Path) -> Result<()> {
    let cli = if cfg!(windows) {
        install_root.join("venv/Scripts/youtab.exe")
    } else {
        install_root.join("venv/bin/youtab")
    };
    if !cli.is_file() {
        return Err(anyhow!("installed Youtab CLI is absent"));
    }
    let probe_dir = youtab_home.join(format!(".setup-health-{}", std::process::id()));
    std::fs::create_dir(&probe_dir).context("creating isolated backend probe home")?;
    let ready = probe_dir.join("ready.json");
    let relocation = crate::home_relocation::source_for_current_setup()?.is_some();
    let mut command = if relocation {
        let mut command = tokio::process::Command::new(install_root.join("venv/Scripts/python.exe"));
        command.args(["-I", "-S", "-B", "-c",
            "import importlib.metadata as m,sys; root=sys.argv.pop(1); sys.path[:0]=[root,root+'/venv/Lib/site-packages']; ep=next(e for e in m.distribution('youtab-agent-runtime').entry_points if e.group=='console_scripts' and e.name=='youtab'); sys.exit(ep.load()())"])
            .arg(install_root);
        crate::home_relocation::isolate_tokio_child(&mut command);
        command
    } else { tokio::process::Command::new(cli) };
    let mut child = command
        .args(["serve", "--host", "127.0.0.1", "--port", "0", "--no-open"])
        .env("YOUTAB_AGENT_HOME", &probe_dir)
        .env(crate::diagnostics::OPERATION_ENV, crate::diagnostics::operation_id())
        .env("YOUTAB_AGENT_DESKTOP_READY_FILE", &ready)
        .current_dir(install_root)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn().context("starting installed backend health probe")?;
    let result = async {
        let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).no_proxy().build()?;
        for _ in 0..150 {
            if let Some(status) = child.try_wait()? {
                return Err(anyhow!("installed backend exited before ready: {status}"));
            }
            if let Ok(bytes) = std::fs::read(&ready) {
                let payload: serde_json::Value = serde_json::from_slice(&bytes)?;
                let port = payload.get("port").and_then(serde_json::Value::as_u64)
                    .filter(|n| (1..=65535).contains(n))
                    .ok_or_else(|| anyhow!("backend ready file has invalid port"))?;
                let url = format!("http://127.0.0.1:{port}/api/health");
                if let Ok(response) = client.get(url).send().await {
                    if response.status().is_success() {
                        let body: serde_json::Value = serde_json::from_slice(&response.bytes().await?)?;
                        if body.get("ok") == Some(&serde_json::Value::Bool(true)) {
                            return Ok(());
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err(anyhow!("installed backend did not pass /api/health within 30 seconds"))
    }.await;
    let _ = child.kill().await;
    let waited = child.wait().await;
    let _ = std::fs::remove_dir_all(&probe_dir);
    waited.context("waiting for owned backend probe to stop")?;
    result
}

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

/// Frontend â†’ Rust: kick off the install.
#[derive(Debug, Deserialize)]
pub struct StartBootstrapArgs {
    #[serde(default = "default_release_channel")]
    pub release_channel: String,
    /// Explicit consent from the common Setup's migration screen.
    #[serde(default)]
    pub migrate_legacy: bool,
    /// Optional override for the commit pin. Defaults to the build-time
    /// pin baked in via `BUILD_PIN_COMMIT`.
    pub commit: Option<String>,
    /// Optional override for the branch pin. Defaults to `BUILD_PIN_BRANCH`.
    pub branch: Option<String>,
    /// Include Stage-Desktop (build apps/desktop) in the manifest. The
    /// signed bootstrap installer passes true; the deprecated Electron-side
    /// bootstrap-runner passes false to avoid building-while-running.
    #[serde(default = "default_true")]
    pub include_desktop: bool,
    /// Optional override for YOUTAB_AGENT_HOME. Tests use this; production
    /// almost always falls back to the OS default.
    pub youtab_home: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_release_channel() -> String { "stable".to_owned() }

#[derive(Debug, Serialize)]
pub struct BootstrapStatus {
    pub running: bool,
    pub completed: bool,
    pub install_root: Option<String>,
    pub last_error: Option<String>,
}

/// Handle stored in AppState while a bootstrap run is in flight. Carries
/// the cancellation channel and the most recent terminal status so the
/// frontend can re-query after a window refresh.
pub struct BootstrapHandle {
    pub cancel_tx: mpsc::Sender<()>,
    pub started_at: Instant,
    pub status: BootstrapStatus,
}

#[tauri::command]
pub async fn start_bootstrap(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    args: StartBootstrapArgs,
) -> Result<(), String> {
    let mut guard = state.bootstrap.lock().await;
    if state.location_handoff.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Wait for the location change to finish".into());
    }
    if let Some(h) = guard.as_ref() {
        if h.status.running {
            return Err("Bootstrap is already running".into());
        }
    }

    let (cancel_tx, cancel_rx) = mpsc::channel::<()>(1);
    let handle = BootstrapHandle {
        cancel_tx,
        started_at: Instant::now(),
        status: BootstrapStatus {
            running: true,
            completed: false,
            install_root: None,
            last_error: None,
        },
    };
    *guard = Some(handle);
    drop(guard);

    let app_for_task = app.clone();
    let state_for_task = state.inner().clone();
    let args_for_task = args;
    let cancel_rx = Arc::new(Mutex::new(Some(cancel_rx)));

    tokio::spawn(async move {
        let result = run_requested_bootstrap(app_for_task.clone(), args_for_task, cancel_rx).await;

        if let Err(err) = &result {
            // A transaction failure may occur outside a PowerShell stage. The
            // renderer needs a terminal event even when an inner stage did not
            // emit one (for example, promotion or health verification).
            let safe = crate::events::fixed_diagnostic(&format!("{err:#}"), false);
            emit_event(
                &app_for_task,
                BootstrapEvent::Failed {
                    stage: (safe == crate::events::SETUP_CHANNEL_UNPUBLISHED)
                        .then(|| "setup-channel".to_owned()),
                    error: format!("{err:#}"),
                },
            );
        }

        // Reflect terminal state into AppState so get_bootstrap_status()
        // can serve it after the task exits.
        let mut guard = state_for_task.bootstrap.lock().await;
        if let Some(h) = guard.as_mut() {
            h.status.running = false;
            match &result {
                Ok(install_root) => {
                    h.status.completed = true;
                    h.status.install_root = Some(install_root.clone());
                    h.status.last_error = None;
                }
                Err(err) => {
                    h.status.completed = false;
                    h.status.last_error = Some(crate::events::fixed_diagnostic(&err.to_string(), false).into());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_bootstrap(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let guard = state.bootstrap.lock().await;
    if let Some(h) = guard.as_ref() {
        let _ = h.cancel_tx.try_send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_bootstrap_status(
    state: State<'_, Arc<AppState>>,
) -> Result<BootstrapStatus, String> {
    let guard = state.bootstrap.lock().await;
    Ok(match guard.as_ref() {
        Some(h) => BootstrapStatus {
            running: h.status.running,
            completed: h.status.completed,
            install_root: h.status.install_root.clone(),
            last_error: h.status.last_error.clone(),
        },
        None => BootstrapStatus {
            running: false,
            completed: false,
            install_root: None,
            last_error: None,
        },
    })
}

/// Spawn the locally-built Youtab desktop binary, then close the installer
/// window. Caller resolves the binary path from `install_root`.
///
/// Returns Err with a human-readable message if the binary doesn't exist
/// (e.g. when Stage-Desktop was skipped) so the frontend can present
/// actionable failure UI rather than silently doing nothing.
#[tauri::command]
pub async fn launch_youtab_desktop(
    app: AppHandle,
    install_root: String,
) -> Result<(), String> {
    let install_root = PathBuf::from(install_root);
    let exe_path = resolve_youtab_desktop_exe(&install_root).ok_or_else(|| {
        format!(
            "Couldn't find a built Youtab desktop at {}. The desktop build step \
             may have been skipped or failed. Run `youtab desktop` from a \
             terminal to build and launch it.",
            install_root.join("apps").join("desktop").join("release").display()
        )
    })?;

    let _private_code = if cfg!(windows) && option_env!("RELEASE_BASE_URL").is_some() {
        let home = install_root.parent().ok_or_else(|| "installation has no home".to_string())?;
        let namespace = crate::update_coordination::admit_private_code_namespace(home)
            .map_err(|reason| format!("private installation namespace refused: {reason}; preserving migration required"))?;
        let code = namespace.admit_existing_code_tree(exe_path.parent().ok_or_else(|| "Desktop code has no parent".to_string())?)
            .map_err(|reason| format!("Desktop code namespace refused: {reason}"))?
            .ok_or_else(|| "Desktop code is absent".to_string())?;
        code.revalidate().map_err(|reason| format!("Desktop code namespace changed: {reason}"))?;
        namespace.revalidate().map_err(|reason| format!("private installation namespace changed: {reason}"))?;
        Some((namespace, code))
    } else { None };

    tracing::info!(?exe_path, "launching Youtab desktop");

    // Detach from us â€” the installer is about to exit. On macOS launch the
    // bundle through LaunchServices instead of exec'ing Contents/MacOS/Youtab
    // directly; this matches user double-click/open behavior and avoids cwd /
    // quarantine oddities after a self-update rebuild.
    let mut cmd = desktop_launch_command(&exe_path, &install_root).map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        // DETACHED_PROCESS = 0x00000008
        cmd.creation_flags(0x0000_0008);
    }

    cmd.spawn().map_err(|e| {
        format!(
            "failed to launch {}: {e}",
            exe_path.display()
        )
    })?;

    // Give Windows ~150ms to actually start the new process before we exit.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // Exit the installer cleanly. Tauri's process plugin gives us the
    // right hook regardless of platform.
    app.exit(0);
    Ok(())
}

/// Walks the well-known electron-builder unpacked-app paths under
/// `install_root`. Mirrors the resolver in `cmd_gui` (apps/desktop/release/
/// <os>-unpacked/<exe>).
pub(crate) fn resolve_youtab_desktop_exe(install_root: &std::path::Path) -> Option<PathBuf> {
    let release_dir = install_root.join("apps").join("desktop").join("release");
    let candidates: &[(&str, &str)] = if cfg!(target_os = "windows") {
        &[
            ("win-unpacked", "Youtab.exe"),
            ("win-arm64-unpacked", "Youtab.exe"),
        ]
    } else if cfg!(target_os = "macos") {
        &[
            ("mac/Youtab.app/Contents/MacOS", "Youtab"),
            ("mac-arm64/Youtab.app/Contents/MacOS", "Youtab"),
        ]
    } else {
        &[("linux-unpacked", "youtab")]
    };
    for (subdir, exe) in candidates {
        let p = release_dir.join(subdir).join(exe);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn resolve_youtab_desktop_app(install_root: &std::path::Path) -> Option<PathBuf> {
    let exe = resolve_youtab_desktop_exe(install_root)?;
    #[cfg(target_os = "macos")]
    {
        // .../Youtab.app/Contents/MacOS/Youtab -> .../Youtab.app
        let app = exe.parent()?.parent()?.parent()?.to_path_buf();
        if app.extension().and_then(|e| e.to_str()) == Some("app") && app.is_dir() {
            return Some(app);
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(exe)
    }
}

/// True when a prior install completed (bootstrap-complete marker present) AND a
/// launchable desktop app exists on disk. Used by the installer's launcher fast
/// path so a bare re-open just opens Youtab instead of re-running setup.
pub(crate) fn youtab_is_installed(install_root: &std::path::Path) -> bool {
    install_root.join(".youtab-agent-runtime-bootstrap-complete").exists()
        && resolve_youtab_desktop_exe(install_root).is_some()
}

fn resolve_marker_commit(install_root: &Path, pin: &Pin) -> Option<String> {
    if let Some(commit) = pin
        .commit
        .as_ref()
        .filter(|commit| !commit.trim().is_empty())
    {
        return Some(commit.clone());
    }

    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(install_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if commit.is_empty() {
        None
    } else {
        Some(commit)
    }
}

#[cfg(test)]
fn write_bootstrap_complete_marker(install_root: &Path, pin: &Pin) -> Result<serde_json::Value> {
    write_bootstrap_complete_marker_with_artifact(install_root, pin, None)
}

fn write_bootstrap_complete_marker_with_artifact(
    install_root: &Path,
    pin: &Pin,
    artifact: Option<&ArtifactInstallInfo>,
) -> Result<serde_json::Value> {
    use std::io::Write;

    let marker_path = crate::paths::likely_bootstrap_marker(install_root);
    if let Some(parent) = marker_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| {
            format!(
                "could not create bootstrap marker directory {}",
                parent.display()
            )
        })?;
    }

    let completed_at_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let mut marker = serde_json::json!({
        "schemaVersion": 1,
        "pinnedCommit": resolve_marker_commit(install_root, pin),
        "pinnedBranch": pin.branch.clone(),
        "completedAtUnix": completed_at_unix,
    });
    if let Some(info) = artifact {
        let contract = install_root.join("runtime-desktop.json");
        let contract_metadata = std::fs::symlink_metadata(&contract)
            .context("verified Runtime lacks its Desktop contract")?;
        if !contract_metadata.is_file() || contract_metadata.len() == 0 || contract_metadata.len() > 4096 {
            return Err(anyhow!("verified Runtime Desktop contract is not a bounded regular file"));
        }
        let contract_bytes = std::fs::read(&contract).context("could not read verified Runtime Desktop contract")?;
        if contract_bytes.is_empty() || contract_bytes.len() > 4096 {
            return Err(anyhow!("verified Runtime Desktop contract exceeds its size limit"));
        }
        let contract_value: serde_json::Value = serde_json::from_slice(&contract_bytes)
            .context("verified Runtime Desktop contract is not valid JSON")?;
        let expected = serde_json::json!({
            "schemaVersion": 1,
            "sourceSha": info.source_sha,
            "version": info.version,
            "entrypoint": "venv/Scripts/youtab.exe",
            "capabilities": ["serve"],
        });
        if contract_value != expected {
            return Err(anyhow!("verified Runtime Desktop contract does not match the staged artifact"));
        }
        use sha2::{Digest, Sha256};
        let contract_sha256 = format!("{:x}", Sha256::digest(&contract_bytes));
        let object = marker.as_object_mut().expect("marker is an object");
        object.insert("runtimeContractSha256".into(), serde_json::json!(contract_sha256));
        object.insert("version".into(), serde_json::json!(info.version));
        object.insert("releaseSequence".into(), serde_json::json!(info.release_sequence));
        object.insert("artifactSha256".into(), serde_json::json!(info.artifact_sha256));
        object.insert("releaseBaseUrl".into(), serde_json::json!(info.release_base_url));
        object.insert("releaseChannel".into(), serde_json::json!(info.release_channel));
        object.insert("setupSourceSha".into(), serde_json::json!(option_env!("BUILD_PIN_COMMIT")));
        object.insert("setupSha256".into(), serde_json::json!(crate::paths::installer_sha256(&std::env::current_exe()?)?));
        object.insert("installedAt".into(), serde_json::json!(completed_at_unix));
    }
    let mut body = serde_json::to_vec_pretty(&marker)?;
    body.push(b'\n');

    // Atomic publish (temp sibling + flush + rename), matching Electron's
    // writeFileAtomic(). youtab_is_installed() only checks existence, so a
    // partial direct write would incorrectly enable the launcher fast path.
    let tmp_path = install_root.join(".youtab-agent-runtime-bootstrap-complete.tmp");
    {
        let mut file = std::fs::File::create(&tmp_path).with_context(|| {
            format!(
                "could not create temp bootstrap marker {}",
                tmp_path.display()
            )
        })?;
        file.write_all(&body).with_context(|| {
            format!(
                "could not write temp bootstrap marker {}",
                tmp_path.display()
            )
        })?;
        file.sync_all().with_context(|| {
            format!(
                "could not flush temp bootstrap marker {}",
                tmp_path.display()
            )
        })?;
    }
    // Windows rename fails if the destination already exists; drop any prior
    // marker first so a re-run can still publish a fresh payload.
    if marker_path.exists() {
        std::fs::remove_file(&marker_path).with_context(|| {
            format!(
                "could not replace existing bootstrap marker {}",
                marker_path.display()
            )
        })?;
    }
    if let Err(err) = std::fs::rename(&tmp_path, &marker_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err).with_context(|| {
            format!(
                "could not publish bootstrap marker {} â†’ {}",
                tmp_path.display(),
                marker_path.display()
            )
        });
    }

    tracing::info!(path = %marker_path.display(), "bootstrap marker written");
    Ok(marker)
}

/// Spawn the already-built desktop app, detached. Returns Err if no built app
/// exists or the spawn fails, so the caller can fall back to showing the
/// installer UI.
pub(crate) fn spawn_installed_desktop(install_root: &std::path::Path) -> std::io::Result<()> {
    let exe = resolve_youtab_desktop_exe(install_root).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no built Youtab desktop app")
    })?;
    let mut cmd = desktop_launch_command_std(&exe, install_root)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS = 0x00000008 â€” keep the desktop alive after the
        // installer exits, mirroring launch_youtab_desktop. Kept correct here
        // even though the only caller is macOS-gated today, so future reuse on
        // Windows doesn't reintroduce the relaunch race.
        cmd.creation_flags(0x0000_0008);
    }
    cmd.spawn().map(|_child| ())
}

#[cfg(target_os = "macos")]
pub(crate) fn open_macos_app_detached(app_bundle: &std::path::Path) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new("/usr/bin/open");
    cmd.arg(app_bundle);
    cmd.current_dir(crate::paths::youtab_home());
    cmd.spawn().map(|_child| ())
}

#[cfg(target_os = "macos")]
fn app_bundle_for_exe(exe: &std::path::Path) -> Option<PathBuf> {
    let app = exe.parent()?.parent()?.parent()?.to_path_buf();
    if app.extension().and_then(|e| e.to_str()) == Some("app") && app.is_dir() {
        Some(app)
    } else {
        None
    }
}

fn desktop_launch_command(
    exe_path: &std::path::Path,
    install_root: &std::path::Path,
) -> Result<tokio::process::Command> {
    #[cfg(target_os = "macos")]
    {
        if let Some(app_bundle) = app_bundle_for_exe(exe_path) {
            let mut cmd = tokio::process::Command::new("/usr/bin/open");
            cmd.arg(app_bundle);
            cmd.current_dir(crate::paths::youtab_home());
            return Ok(cmd);
        }
    }

    let mut cmd = tokio::process::Command::new(exe_path);
    configure_desktop_child(cmd.as_std_mut(), install_root)?;
    cmd.current_dir(exe_path.parent().unwrap_or(install_root));
    Ok(cmd)
}

fn desktop_launch_command_std(
    exe_path: &std::path::Path,
    install_root: &std::path::Path,
) -> Result<std::process::Command> {
    #[cfg(target_os = "macos")]
    {
        if let Some(app_bundle) = app_bundle_for_exe(exe_path) {
            let mut cmd = std::process::Command::new("/usr/bin/open");
            cmd.arg(app_bundle);
            cmd.current_dir(crate::paths::youtab_home());
            return Ok(cmd);
        }
    }

    let mut cmd = std::process::Command::new(exe_path);
    configure_desktop_child(&mut cmd, install_root)?;
    cmd.current_dir(exe_path.parent().unwrap_or(install_root));
    Ok(cmd)
}

fn configure_desktop_child(command: &mut std::process::Command, install_root: &Path) -> Result<()> {
    if let Some(home) = install_root.parent() { command.env("YOUTAB_AGENT_HOME", home); }
    command.env(crate::diagnostics::OPERATION_ENV, crate::diagnostics::operation_id());
    if let Some(source) = std::env::var_os("YOUTAB_AGENT_RELOCATION_SOURCE") {
        crate::home_relocation::isolate_std_child(command);
        let home = install_root.parent().ok_or_else(|| anyhow!("relocation install has no home"))?;
        for (name, value) in crate::home_relocation::published_child_bindings(home, Path::new(&source))? {
            command.env(name, value);
        }
    }
    Ok(())
}

fn install_stage_args(stage: &str, manifest_args: &[String], include_desktop: bool, journal: Option<&Path>) -> Vec<String> {
    let mut args = vec!["-Stage".into(), stage.into(), "-NonInteractive".into(), "-Json".into()];
    args.extend_from_slice(manifest_args);
    if include_desktop { args.push("-IncludeDesktop".into()); }
    if let Some(journal) = journal {
        args.extend(["-RelocationJournal".into(), journal.to_string_lossy().into_owned()]);
    }
    args
}

// ---------------------------------------------------------------------------
// Bootstrap implementation
// ---------------------------------------------------------------------------

enum MarkerlessRepair {
    Fresh,
    InterruptedUpdate { previous_runtime: PathBuf, backup_present: bool, previous_marker: Vec<u8> },
}

fn validate_pending_repair(root: &Path, running_setup: &Path, release_base: &str) -> Result<MarkerlessRepair> {
    let marker = root.join(".youtab-agent-runtime-bootstrap-complete");
    if root.is_symlink() {
        return Err(anyhow!("pending repair has ambiguous installation metadata"));
    }
    match std::fs::symlink_metadata(&marker) {
        Ok(metadata) if !metadata.is_file() => return Err(anyhow!("pending repair marker is not a regular file")),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error).context("pending repair marker cannot be inspected"),
    }
    if root.exists() && !root.is_dir() {
        return Err(anyhow!("markerless repair has an invalid Runtime root"));
    }
    let pending = InstallSwap::marker_path(root, "pending")?;
    if InstallSwap::marker_path(root, "committed")?.exists() {
        return Err(anyhow!("markerless repair has an ambiguous committed transaction"));
    }
    let metadata = std::fs::symlink_metadata(&pending)
        .map_err(|_| anyhow!("markerless repair requires a pending install transaction"))?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(anyhow!("markerless repair has an invalid pending transaction"));
    }
    let journal = InstallSwap::read_journal(root)?;
    if journal.legacy_head_sha.is_some() {
        return Err(anyhow!("markerless repair cannot replay a legacy migration"));
    }
    let setup = journal.setup.as_ref()
        .ok_or_else(|| anyhow!("markerless repair requires a Setup-bound transaction"))?;
    crate::paths::verify_installer(running_setup, &setup.required_sha256)
        .context("markerless repair Setup differs from pending transaction")?;
    let backup = InstallSwap::backup_path(root)?;
    let (setup_target, _, setup_backup) = InstallSwap::setup_paths(root)?;
    let setup_backup_meta = match std::fs::symlink_metadata(&setup_backup) {
        Ok(meta) if meta.is_file() => Some(meta),
        Ok(_) => return Err(anyhow!("previous Setup backup is not a regular file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("previous Setup backup cannot be inspected"),
    };
    if let Some(previous_hash) = &setup.previous_sha256 {
        let previous_setup = if setup_backup_meta.is_some() { &setup_backup } else { &setup_target };
        crate::paths::verify_installer(previous_setup, previous_hash)
            .context("previous Setup identity differs from pending transaction")?;
        if setup_backup_meta.is_some() && std::fs::symlink_metadata(&setup_target).is_ok() {
            let current_hash = crate::paths::installer_sha256(&setup_target)?;
            if current_hash != *previous_hash && current_hash != setup.required_sha256 {
                return Err(anyhow!("current Setup has unknown identity during interrupted install"));
            }
        }
    } else if setup_backup_meta.is_some() {
        return Err(anyhow!("pending repair has an unowned Setup backup"));
    }
    if !journal.had_old {
        if std::fs::symlink_metadata(&backup).is_ok() {
            return Err(anyhow!("fresh repair has unexpected prior installation state"));
        }
        return Ok(MarkerlessRepair::Fresh);
    }

    // A completed old artifact install must be preserved before recovering an
    // interrupted update. Never infer its ownership merely from the sibling
    // name: inspect the directory, marker and prior Setup against the journal.
    let backup_present = match std::fs::symlink_metadata(&backup) {
        Ok(metadata) if metadata.is_dir() => true,
        Ok(_) => return Err(anyhow!("previous Runtime backup is not a directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error).context("previous Runtime backup cannot be inspected"),
    };
    // The journal precedes the old-tree rename. Before that rename the old
    // artifact is still active; after it, the backup holds its identity.
    let previous_runtime = if backup_present { &backup } else { root };
    if !previous_runtime.is_dir() {
        return Err(anyhow!("interrupted update has no previous Runtime"));
    }
    let previous_marker_path = previous_runtime.join(".youtab-agent-runtime-bootstrap-complete");
    let previous_meta = std::fs::symlink_metadata(&previous_marker_path)
        .map_err(|_| anyhow!("previous Runtime backup has no artifact marker"))?;
    if !previous_meta.is_file() || previous_meta.len() > 65536 {
        return Err(anyhow!("previous Runtime artifact marker is invalid"));
    }
    let previous_marker = std::fs::read(&previous_marker_path)?;
    let document: serde_json::Value = serde_json::from_slice(&previous_marker)
        .context("previous Runtime artifact marker is unreadable")?;
    let valid_hex = |key: &str, length: usize| document.get(key).and_then(serde_json::Value::as_str)
        .is_some_and(|value| value.len() == length && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    if document.get("releaseBaseUrl").and_then(serde_json::Value::as_str) != Some(release_base)
        || document.get("releaseSequence").and_then(serde_json::Value::as_u64).unwrap_or(0) == 0
        || !valid_hex("pinnedCommit", 40) || !valid_hex("artifactSha256", 64) {
        return Err(anyhow!("previous Runtime backup is not a bound artifact install"));
    }

    if setup.previous_sha256.is_none() {
        return Err(anyhow!("interrupted update has no previous Setup identity"));
    }
    Ok(MarkerlessRepair::InterruptedUpdate {
        previous_runtime: previous_runtime.to_path_buf(), backup_present, previous_marker,
    })
}

/// An uncommitted transaction does not prove that an active tree contains only
/// installer-owned bytes. Preserve the entire partial tree before rollback so
/// a crash or an unrelated file can never turn recovery into data deletion.
fn preserve_pending_runtime(root: &Path) -> Result<Option<PathBuf>> {
    match std::fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("pending Runtime cannot be inspected"),
        Ok(metadata) if !metadata.is_dir() => return Err(anyhow!("pending Runtime is not a directory")),
        Ok(_) => {},
    }
    let parent = root.parent().context("pending Runtime has no parent")?;
    let preserved = tempfile::Builder::new()
        .prefix(".youtab-runtime-recovery-preserved-")
        .tempdir_in(parent)?
        .keep();
    std::fs::rename(root, preserved.join("runtime"))
        .context("preserving uncommitted Runtime before recovery")?;
    tracing::warn!(path = %preserved.display(), "uncommitted Runtime retained during repair");
    Ok(Some(preserved))
}

async fn run_requested_bootstrap(
    app: AppHandle,
    mut args: StartBootstrapArgs,
    cancel_rx: Arc<Mutex<Option<mpsc::Receiver<()>>>>,
) -> Result<String> {
    let repair = std::env::args().any(|arg| arg == "--repair" || arg == "--reinstall");
    if repair {
        if let Some(base) = option_env!("RELEASE_BASE_URL") {
            #[cfg(windows)]
            let home = {
                let selected = crate::paths::customer_home()
                    .map_err(|reason| anyhow!("customer home selection refused: {reason}"))?;
                if args.youtab_home.as_ref().is_some_and(|explicit|
                    !crate::paths::same_windows_path(Path::new(explicit), selected.path())) {
                    return Err(anyhow!("explicit repair home differs from selected installation"));
                }
                selected.path().to_owned()
            };
            #[cfg(not(windows))]
            let home = args.youtab_home.as_ref().map(PathBuf::from)
                .unwrap_or_else(crate::paths::youtab_home);
            let root = home.join("youtab-agent-runtime");
            let lock = crate::update::UpdateMarkerGuard::acquire_for_install(&home)?;
            let marker = root.join(".youtab-agent-runtime-bootstrap-complete");
            if root.is_symlink() || marker.is_symlink() {
                return Err(anyhow!("repair installation metadata is a link"));
            }
            let pending = InstallSwap::marker_path(&root, "pending")?;
            let committed = InstallSwap::marker_path(&root, "committed")?;
            let pending_repair = if (pending.exists() && !committed.exists()) || !marker.exists() {
                let admitted = validate_pending_repair(&root, &std::env::current_exe()?, base)?;
                let channel_root = match &admitted {
                    MarkerlessRepair::Fresh => &root,
                    MarkerlessRepair::InterruptedUpdate { previous_runtime, .. } => previous_runtime,
                };
                let channel = crate::update::release_channel_for_install(channel_root)?;
                args.release_channel = channel.clone();
                let approved = match &admitted {
                    MarkerlessRepair::Fresh => {
                        crate::update::verify_setup_channel(base, &channel).await?;
                        None
                    }
                    MarkerlessRepair::InterruptedUpdate { previous_runtime, .. } => {
                        let approved = crate::update::approved_artifact_target(base, previous_runtime, &channel).await?;
                        if option_env!("BUILD_PIN_COMMIT") != Some(approved.sha.as_str())
                            || crate::paths::installer_sha256(&std::env::current_exe()?)? != approved.setup_sha256 {
                            return Err(anyhow!("Repair requires the Setup matching the selected release"));
                        }
                        Some(approved.sha)
                    }
                };
                Some((admitted, approved))
            } else {
                None
            };
            if matches!(pending_repair, Some((MarkerlessRepair::Fresh, _))
                | Some((MarkerlessRepair::InterruptedUpdate { backup_present: true, .. }, _))) {
                preserve_pending_runtime(&root)?;
            }
            InstallSwap::recover(&root)?;
            if matches!(pending_repair, Some((MarkerlessRepair::Fresh, None))) && marker.exists() {
                return Err(anyhow!("fresh repair recovered an unexpected installation"));
            }
            if let Some((MarkerlessRepair::InterruptedUpdate { previous_marker, .. }, Some(approved))) = pending_repair.as_ref() {
                if marker.is_symlink() || std::fs::read(&marker).ok().as_ref() != Some(previous_marker) {
                    return Err(anyhow!("recovered Runtime differs from verified previous artifact"));
                }
                return run_bootstrap(app, args, cancel_rx, Some(approved.clone()), Some(lock)).await;
            }
            if marker.exists() {
                let channel = crate::update::release_channel_for_install(&root)?;
                let approved = crate::update::approved_artifact_target(base, &root, &channel).await?;
                args.release_channel = channel;
                if option_env!("BUILD_PIN_COMMIT") != Some(approved.sha.as_str())
                    || crate::paths::installer_sha256(&std::env::current_exe()?)? != approved.setup_sha256 {
                    return Err(anyhow!("Repair requires the Setup matching the selected release"));
                }
                return run_bootstrap(app, args, cancel_rx, Some(approved.sha), Some(lock)).await;
            }
            if !matches!(pending_repair, Some((MarkerlessRepair::Fresh, None))) || root.exists() {
                return Err(anyhow!("markerless repair did not recover to a fresh installation"));
            }
            return run_bootstrap(app, args, cancel_rx, None, Some(lock)).await;
        }
    }
    run_bootstrap(app, args, cancel_rx, None, None).await
}

pub(crate) async fn run_artifact_update(
    app: AppHandle,
    source_sha: String,
    release_channel: String,
    lock: crate::update::UpdateMarkerGuard,
) -> Result<String> {
    let (cancel_tx, cancel_rx) = mpsc::channel(1);
    drop(cancel_tx);
    run_bootstrap(
        app,
        StartBootstrapArgs { commit: None, branch: None, youtab_home: None, include_desktop: true, migrate_legacy: false, release_channel },
        Arc::new(Mutex::new(Some(cancel_rx))),
        Some(source_sha),
        Some(lock),
    ).await
}

async fn run_bootstrap(
    app: AppHandle,
    args: StartBootstrapArgs,
    cancel_rx_holder: Arc<Mutex<Option<mpsc::Receiver<()>>>>,
    authorized_artifact_target: Option<String>,
    preheld_lock: Option<crate::update::UpdateMarkerGuard>,
) -> Result<String> {
    let kind = ScriptKind::for_current_os();
    let release_base = option_env!("RELEASE_BASE_URL");
    let relocation_intent = crate::home_relocation::startup_intent()?;
    if relocation_intent.is_some() {
        let selected = crate::update::release_channel_from_args(std::env::args().skip(1))?;
        if args.release_channel != selected {
            return Err(anyhow!("relocation release channel differs from its Setup handoff"));
        }
    }
    if release_base.is_some() {
        crate::update::release_channel_from_args(["--channel", args.release_channel.as_str()])?;
        crate::update::verify_setup_channel(release_base.unwrap(), &args.release_channel).await?;
    }
    if release_base.is_some() && !args.include_desktop {
        return Err(anyhow!("customer artifact Setup requires the Desktop build stage"));
    }
    let relocation_source = relocation_intent.as_ref().map(|intent| intent.source.clone());
    if relocation_source.is_some() && (!cfg!(windows) || release_base.is_none() || authorized_artifact_target.is_some()) {
        return Err(anyhow!("home relocation requires the common Windows install flow"));
    }
    #[cfg(windows)]
    if release_base.is_some() && relocation_intent.is_none() {
        let selected = crate::paths::customer_home().map_err(|reason| anyhow!("customer home selection refused: {reason}"))?;
        if let Some(explicit) = args.youtab_home.as_ref() {
            if !crate::paths::same_windows_path(Path::new(explicit), selected.path()) {
                return Err(anyhow!("explicit home differs from the single selected installation; use preserving relocation"));
            }
        }
        crate::paths::prepare_fresh_customer_home(&selected)
            .map_err(|reason| anyhow!("fresh customer home refused: {reason}"))?;
    }
    let youtab_home = args.youtab_home.clone()
        .unwrap_or_else(|| crate::paths::youtab_home().to_string_lossy().into_owned());
    let youtab_home_path = PathBuf::from(&youtab_home);
    if let Some(intent) = &relocation_intent {
        if youtab_home_path.canonicalize()? != intent.target.canonicalize()? {
            return Err(anyhow!("relocation target differs from the pre-logging admitted intent"));
        }
    }
    let install_root = youtab_home_path.join("youtab-agent-runtime");
    // Hold private namespace handles before any repository promotion or code
    // build. Unsafe legacy/custom homes require a preserving migration; Setup
    // never silently rewrites their owner or DACL.
    let code_namespace = if cfg!(windows) && release_base.is_some() {
        std::fs::create_dir_all(&youtab_home_path)
            .context("creating installation namespace")?;
        Some(crate::update_coordination::admit_private_code_namespace(&youtab_home_path)
            .map_err(|reason| anyhow!("private installation namespace refused: {reason}; preserving migration required"))?)
    } else {
        None
    };
    let _install_lock = if release_base.is_some() {
        let lock = match preheld_lock {
            Some(lock) => lock,
            None => crate::update::UpdateMarkerGuard::acquire_for_install(&youtab_home_path)?,
        };
        InstallSwap::recover(&install_root)?;
        Some(lock)
    } else {
        None
    };
    let mut relocation = if let Some(source) = &relocation_source {
        let namespace = code_namespace.as_ref().ok_or_else(|| anyhow!("private target admission absent"))?;
        let journal = youtab_home_path.join(".youtab-home-relocation-v1.json");
        let staged = youtab_home_path.join(".youtab-home-relocation-v1.json.new-staged");
        Some(if journal.exists() || staged.exists() {
            crate::home_relocation::Relocation::resume(source, &youtab_home_path, namespace)?
        } else {
            crate::home_relocation::Relocation::begin(source, &youtab_home_path, namespace)?
        })
    } else { None };
    let resume_validated_product = relocation.as_ref().is_some_and(|value| value.product_validated());

    if let Some(namespace) = &code_namespace {
        // These existing executables can run before the repository is replaced.
        for path in [crate::paths::installer_dest_in(&youtab_home_path), youtab_home_path.join("bin")] {
            if let Some(code) = namespace.admit_existing_code_tree(&path)
                .map_err(|reason| anyhow!("existing installer code refused: {reason}"))? {
                code.revalidate().map_err(|reason| anyhow!("existing installer code changed: {reason}"))?;
                // Release descendant handles before authorized Setup rename.
                drop(code);
            }
        }
    }
    let migration_requested = args.migrate_legacy || std::env::args().any(|arg| arg == "--migrate-legacy");
    let legacy_head_sha = if migration_requested {
        if !cfg!(target_os = "windows") || release_base.is_none() || authorized_artifact_target.is_some() {
            return Err(anyhow!("legacy migration requires the Windows customer Setup install flow"));
        }
        if let Some(namespace) = &code_namespace {
            if let Some(code) = namespace.admit_existing_code_tree(&install_root.join(".git"))
                .map_err(|reason| anyhow!("legacy Git metadata refused: {reason}"))? {
                code.revalidate().map_err(|reason| anyhow!("legacy Git metadata changed: {reason}"))?;
                drop(code);
            }
        }
        Some(validate_legacy_migration(&install_root)?)
    } else { None };
    let mut install_swap: Option<InstallSwap> = None;
    let mut artifact_info: Option<ArtifactInstallInfo> = None;

    let pin = Pin {
        commit: authorized_artifact_target.clone()
            .or(args.commit).or_else(|| option_env_string("BUILD_PIN_COMMIT")),
        branch: args.branch.or_else(|| option_env_string("BUILD_PIN_BRANCH")),
    };

    tracing::info!(
        ?pin,
        kind = ?kind,
        include_desktop = args.include_desktop,
        "bootstrap starting"
    );

    let app_for_log = app.clone();
    let emit_log = move |line: &str| {
        emit_event(
            &app_for_log,
            BootstrapEvent::Log {
                stage: None,
                line: line.to_string(),
                stream: LogStream::Stdout,
            },
        );
        // Persist only the fixed output category. The raw source may contain
        // an unlabelled credential even when it passes heuristic redaction.
        tracing::info!(target: "bootstrap.log", "{}", crate::events::fixed_diagnostic(line, true));
    };

    // 1. Resolve install.ps1
    let script_pin = if authorized_artifact_target.is_some() {
        Pin { commit: option_env_string("BUILD_PIN_COMMIT"), branch: None }
    } else {
        pin.clone()
    };
    let mut script = install_script::resolve(kind, &script_pin, &emit_log)
        .await
        .map_err(|e| {
            let msg = format!("resolve install script failed: {e:#}");
            emit_event(
                &app,
                BootstrapEvent::Failed {
                    stage: None,
                    error: msg.clone(),
                },
            );
            anyhow!(msg)
        })?;
    if authorized_artifact_target.is_some() {
        // Only the internal latest.json update path may target a new source
        // SHA while retaining the install script trusted by this Setup build.
        script.commit = pin.commit.clone();
        script.branch = None;
    }

    let source_note = match &script.source {
        ScriptSource::DevCheckout => "dev checkout",
        ScriptSource::Bundled => "bundled",
        ScriptSource::Cached => "cached",
        ScriptSource::Downloaded => "downloaded",
    };
    emit_log(&format!(
        "[bootstrap] script {} via {}",
        script.path.display(),
        source_note
    ));

    // 2. Fetch manifest
    //
    // -IncludeDesktop MUST be passed to the manifest call too â€” install.ps1
    // gates the desktop stage inclusion on this flag, so without it here
    // the manifest comes back missing the desktop stage and we never run
    // it. The per-stage call below also passes -IncludeDesktop to keep
    // the contracts identical.
    let mut manifest_args = build_pin_args(&script);
    if relocation.is_some() { manifest_args.push("-PrivateHomeRelocation".into()); }
    let mut manifest_args_full = vec!["-Manifest".to_string()];
    manifest_args_full.extend(manifest_args.clone());
    if args.include_desktop {
        manifest_args_full.push("-IncludeDesktop".to_string());
    }

    let manifest_result = run_install_script(
        &app,
        &script.path,
        &manifest_args_full,
        Some(&youtab_home),
        None,
        Some("__manifest__".to_string()),
    )
    .await?;

    if manifest_result.exit_code != Some(0) {
        let err = format!(
            "install.ps1 -Manifest failed: exit {:?}\n{}",
            manifest_result.exit_code,
            manifest_result.stderr.trim()
        );
        let err = crate::events::actionable_process_hint(&manifest_result.stderr)
            .or_else(|| crate::events::actionable_process_hint(&manifest_result.stdout))
            .map(str::to_owned).unwrap_or(err);
        emit_event(
            &app,
            BootstrapEvent::Failed {
                stage: None,
                error: err.clone(),
            },
        );
        return Err(anyhow!(err));
    }

    let mut manifest: Manifest = powershell::parse_manifest(&manifest_result.stdout).ok_or_else(|| {
        let err = format!(
            "install.ps1 -Manifest produced no parseable JSON payload\n{}",
            truncate(&manifest_result.stdout, 4000)
        );
        emit_event(
            &app,
            BootstrapEvent::Failed {
                stage: None,
                error: err.clone(),
            },
        );
        anyhow!(err)
    })?;

    if relocation.is_some() {
        // Verified artifact extraction uses PowerShell/.NET only. It makes the
        // reviewed shared prerequisite lock available before downloaded code runs.
        manifest.stages.sort_by_key(|stage| if stage.name == "repository" { 0 } else { 1 });
    }
    emit_event(
        &app,
        BootstrapEvent::Manifest {
            stages: manifest.stages.clone(),
            protocol_version: manifest.protocol_version,
        },
    );

    // 3. Iterate stages.
    for stage in &manifest.stages {
        if relocation.is_some() && (resume_validated_product || stage.name == "path") {
            emit_event(&app, BootstrapEvent::Stage {
                name: stage.name.clone(), state: StageState::Skipped, duration_ms: Some(0),
                result: None, error: Some("deferred relocation publication or validated product recovery".into()),
            });
            continue;
        }
        // Skip Stage-Desktop unless explicitly requested. install.ps1 may
        // or may not include it in the manifest depending on the flag we
        // pass, but if it slipped in, gate client-side too.
        if !args.include_desktop && stage.name.eq_ignore_ascii_case("desktop") {
            emit_event(
                &app,
                BootstrapEvent::Stage {
                    name: stage.name.clone(),
                    state: StageState::Skipped,
                    duration_ms: Some(0),
                    result: None,
                    error: Some("skipped by include_desktop=false".into()),
                },
            );
            continue;
        }

        if cancellation_signalled(&cancel_rx_holder).await {
            let err = "bootstrap cancelled by user".to_string();
            emit_event(
                &app,
                BootstrapEvent::Failed {
                    stage: Some(stage.name.clone()),
                    error: err.clone(),
                },
            );
            return Err(anyhow!(err));
        }

        let started = Instant::now();
        emit_event(
            &app,
            BootstrapEvent::Stage {
                name: stage.name.clone(),
                state: StageState::Running,
                duration_ms: None,
                result: None,
                error: None,
            },
        );

        if let Some(namespace) = &code_namespace {
            namespace.revalidate().map_err(|reason|
                anyhow!("private installation namespace changed: {reason}"))?;
        }

        if let Some(namespace) = &code_namespace {
            let mut paths = vec![youtab_home_path.join("bin")];
            if relocation.is_some() {
                paths.push(youtab_home_path.join("git"));
                paths.push(youtab_home_path.join("node"));
                paths.push(install_root.join("venv"));
            }
            if relocation.is_some() && matches!(stage.name.as_str(), "venv" | "dependencies" | "node-deps" | "desktop" | "platform-sdks" | "config-templates") {
                paths.push(crate::home_relocation::private_python_base(&youtab_home_path, namespace)?);
            }
            if matches!(stage.name.as_str(), "venv" | "dependencies" | "node-deps" | "desktop" | "platform-sdks" | "configure" | "gateway" | "config-templates") {
                paths.push(install_root.join("venv"));
            }
            if stage.name.eq_ignore_ascii_case("desktop") {
                paths.push(crate::paths::installer_dest_in(&youtab_home_path));
            }
            for path in paths {
                if let Some(code) = namespace.admit_existing_code_tree(&path)
                    .map_err(|reason| anyhow!("stage executable namespace refused: {reason}"))? {
                    code.revalidate().map_err(|reason| anyhow!("stage executable namespace changed: {reason}"))?;
                    // Effective ACLs and the retained private home deny foreign
                    // replacement; release descendants for uv/build cleanup.
                    drop(code);
                }
            }
        }

        if stage.name == "config-templates" {
            if let Some(data) = relocation.as_mut() { data.prepare_seed_defaults(&install_root)?; }
        }

        let journal = relocation.as_ref().map(|data| data.journal_path());
        let mut stage_args = install_stage_args(&stage.name, &manifest_args, args.include_desktop, journal.as_deref());

        if stage.name.eq_ignore_ascii_case("desktop") && release_base.is_some() {
            let info = artifact_info.as_ref().ok_or_else(|| anyhow!("Desktop stage requires verified artifact identity"))?;
            let installed_setup = crate::paths::installer_dest_in(&youtab_home_path);
            crate::paths::verify_installer(&installed_setup, &info.setup_sha256)?;
            if std::fs::metadata(&installed_setup)?.len() != info.setup_size {
                return Err(anyhow!("persisted common Setup size mismatch"));
            }
            stage_args.extend([
                "-CoordinationSetupSourceSha".into(), info.source_sha.clone(),
                "-CoordinationSetupSha256".into(), info.setup_sha256.clone(),
                "-CoordinationSetupSize".into(), info.setup_size.to_string(),
            ]);
        }

        // Each stage gets its own cancel receiver because tokio::select!
        // in run_script consumes it. Take/return through the Arc<Mutex>.
        let local_cancel_rx = cancel_rx_holder.lock().await.take();

        let stage_result = run_install_script(
            &app,
            &script.path,
            &stage_args,
            Some(&youtab_home),
            local_cancel_rx,
            Some(stage.name.clone()),
        )
        .await?;

        let duration_ms = started.elapsed().as_millis() as u64;

        if stage_result.killed {
            emit_event(
                &app,
                BootstrapEvent::Stage {
                    name: stage.name.clone(),
                    state: StageState::Failed,
                    duration_ms: Some(duration_ms),
                    result: None,
                    error: Some("cancelled by user".into()),
                },
            );
            emit_event(
                &app,
                BootstrapEvent::Failed {
                    stage: Some(stage.name.clone()),
                    error: "cancelled by user".into(),
                },
            );
            return Err(anyhow!("cancelled by user"));
        }

        let result_frame = powershell::parse_stage_result(&stage_result.stdout);

        match result_frame {
            None => {
                let err = format!(
                    "install.ps1 -Stage {} produced no JSON result frame (exit={:?})",
                    stage.name, stage_result.exit_code
                );
                let err = crate::events::actionable_process_hint(&stage_result.stderr)
                    .or_else(|| crate::events::actionable_process_hint(&stage_result.stdout))
                    .map(str::to_owned).unwrap_or(err);
                emit_event(
                    &app,
                    BootstrapEvent::Stage {
                        name: stage.name.clone(),
                        state: StageState::Failed,
                        duration_ms: Some(duration_ms),
                        result: None,
                        error: Some(err.clone()),
                    },
                );
                emit_event(
                    &app,
                    BootstrapEvent::Failed {
                        stage: Some(stage.name.clone()),
                        error: err.clone(),
                    },
                );
                return Err(anyhow!(err));
            }
            Some(frame) if frame.ok && frame.skipped => {
                emit_event(
                    &app,
                    BootstrapEvent::Stage {
                        name: stage.name.clone(),
                        state: StageState::Skipped,
                        duration_ms: Some(duration_ms),
                        result: Some(frame),
                        error: None,
                    },
                );
            }
            Some(frame) if frame.ok => {
                if stage.name.eq_ignore_ascii_case("repository") {
                    if let Some(base) = release_base {
                        let data = frame.data.as_ref().ok_or_else(||
                            anyhow!("artifact repository stage omitted its result data"))?;
                        let mut info = ArtifactInstallInfo::from_stage_data(data, &pin, base)?;
                        info.release_channel = args.release_channel.clone();
                        if legacy_head_sha.is_none() {
                            ensure_replacement_not_downgrade(&install_root, &info)?;
                        }
                        crate::update::require_install_locks_free(&install_root).await?;
                        let setup_source = std::env::current_exe().context("locating running Setup")?;
                        crate::paths::verify_installer(&setup_source, &info.setup_sha256)?;
                        if std::fs::metadata(&setup_source)?.len() != info.setup_size {
                            return Err(anyhow!("running common Setup size mismatch"));
                        }
                        if let Some(namespace) = &code_namespace {
                            namespace.revalidate().map_err(|reason|
                                anyhow!("private installation namespace changed: {reason}"))?;
                        }
                        if let Some(namespace) = &code_namespace {
                            let code = namespace.admit_existing_code_tree(&info.staged)
                                .map_err(|reason| anyhow!("staged verified code refused: {reason}"))?
                                .ok_or_else(|| anyhow!("staged verified code disappeared"))?;
                            code.revalidate().map_err(|reason| anyhow!("staged verified code changed: {reason}"))?;
                            drop(code); // InstallSwap must rename this directory.
                            namespace.revalidate().map_err(|reason| anyhow!("private installation namespace changed: {reason}"))?;
                        }
                        let mut swap = InstallSwap::promote_with_policy(&install_root, &info.staged, Some(&setup_source), legacy_head_sha.clone())?;
                        swap.install_setup()?;
                        artifact_info = Some(info);
                        install_swap = Some(swap);
                    }
                }
                if relocation.is_some() && stage.name == "git" {
                    if let Some(namespace) = &code_namespace {
                        if let Some(code) = namespace.admit_existing_code_tree(&youtab_home_path.join("git"))
                            .map_err(|reason| anyhow!("fresh managed Git namespace refused: {reason}"))? {
                            code.revalidate().map_err(|reason| anyhow!("fresh managed Git namespace changed: {reason}"))?;
                        }
                    }
                }
                if stage.name == "venv" {
                    if let Some(data) = relocation.as_mut() {
                        if !data.data_ready() { data.copy_data(&install_root.join("venv/Scripts/python.exe"))?; }
                    }
                }
                if stage.name == "config-templates" {
                    if let Some(data) = relocation.as_mut() {
                        data.record_seeded_defaults(&install_root)?;
                    }
                }
                emit_event(
                    &app,
                    BootstrapEvent::Stage {
                        name: stage.name.clone(),
                        state: StageState::Succeeded,
                        duration_ms: Some(duration_ms),
                        result: Some(frame),
                        error: None,
                    },
                );
            }
            Some(frame) => {
                let err = frame
                    .reason
                    .clone()
                    .unwrap_or_else(|| format!("exit code {:?}", stage_result.exit_code));
                let err = crate::events::actionable_process_hint(&stage_result.stderr)
                    .or_else(|| crate::events::actionable_process_hint(&stage_result.stdout))
                    .map(str::to_owned).unwrap_or(err);
                emit_event(
                    &app,
                    BootstrapEvent::Stage {
                        name: stage.name.clone(),
                        state: StageState::Failed,
                        duration_ms: Some(duration_ms),
                        result: Some(frame),
                        error: Some(err.clone()),
                    },
                );
                emit_event(
                    &app,
                    BootstrapEvent::Failed {
                        stage: Some(stage.name.clone()),
                        error: err.clone(),
                    },
                );
                return Err(anyhow!(err));
            }
        }
    }

    // 4. Resolve install_root. install.ps1 doesn't (yet) report this back
    // explicitly; we infer it from $YoutabHome which Stage-Repository clones
    // the repo INTO at $YoutabHome\youtab-agent-runtime. Mirrors youtab_constants.
    // Marker publish is terminal for this run: a write failure must emit Failed
    // so the UI leaves the progress state (it does not poll get_bootstrap_status).
    if install_swap.is_some() || resume_validated_product {
        if let Some(namespace) = &code_namespace {
            let code = namespace.admit_existing_code_tree(&install_root.join("venv"))
                .map_err(|reason| anyhow!("installed backend code refused: {reason}"))?
                .ok_or_else(|| anyhow!("installed backend code is absent"))?;
            code.revalidate().map_err(|reason| anyhow!("installed backend code changed: {reason}"))?;
            drop(code);
        }
        verify_installed_backend(&install_root, &youtab_home_path).await?;
    }
    // The Desktop stage runs after the repository swap. Admit its final
    // resource tree before publishing a completion marker; checking only the
    // executable would leave the native add-on and install stamp unchecked.
    let desktop_code = if args.include_desktop && (install_swap.is_some() || resume_validated_product) {
        let exe = resolve_youtab_desktop_exe(&install_root)
            .ok_or_else(|| anyhow!("installed Desktop executable is absent after build"))?;
        if let Some(namespace) = &code_namespace {
            let root = exe.parent().ok_or_else(|| anyhow!("installed Desktop has no parent"))?;
            let code = namespace.admit_existing_code_tree(root)
                .map_err(|reason| anyhow!("installed Desktop code refused: {reason}"))?
                .ok_or_else(|| anyhow!("installed Desktop code is absent"))?;
            code.revalidate().map_err(|reason| anyhow!("installed Desktop code changed: {reason}"))?;
            namespace.revalidate().map_err(|reason| anyhow!("private installation namespace changed: {reason}"))?;
            Some(code)
        } else {
            None
        }
    } else {
        None
    };
    let marker_result = if resume_validated_product {
        serde_json::from_slice(&std::fs::read(crate::paths::likely_bootstrap_marker(&install_root))?).map_err(anyhow::Error::from)
    } else { write_bootstrap_complete_marker_with_artifact(&install_root, &pin, artifact_info.as_ref()) };
    let marker = match marker_result {
        Ok(marker) => marker,
        Err(err) => {
            let msg = format!("write bootstrap marker failed: {err:#}");
            emit_event(
                &app,
                BootstrapEvent::Failed {
                    stage: None,
                    error: msg.clone(),
                },
            );
            return Err(anyhow!(msg));
        }
    };
    // InstallSwap and relocation publication may rename directories on Windows.
    // Release the admission handles after the marker is durable, before either
    // transaction proceeds; the admitted ACL still bars foreign mutation.
    drop(desktop_code);

    if let Some(data) = relocation.as_mut() {
        let expected_source = pin.commit.as_deref().ok_or_else(|| anyhow!("relocation lacks exact source pin"))?;
        let setup_hash = crate::paths::installer_sha256(&std::env::current_exe()?)?;
        data.validate_for_publication(expected_source, &setup_hash)?;
    }
    if let Some(swap) = install_swap.as_mut() { swap.commit()?; }
    if let Some(data) = relocation.as_mut() {
        let desktop = resolve_youtab_desktop_exe(&install_root)
            .ok_or_else(|| anyhow!("relocation target Desktop is absent"))?;
        let mut publication_args = install_stage_args("home-publication", &manifest_args, false, Some(&data.journal_path()));
        publication_args.extend(["-RelocationDesktopExe".into(), desktop.to_string_lossy().into_owned()]);
        let mut prepare = publication_args.clone();
        prepare.extend(["-PublicationAction".into(), "prepare".into()]);
        let result = run_install_script(&app, &script.path, &prepare, Some(&youtab_home), None, Some("home-publication".into())).await?;
        if result.exit_code != Some(0) { return Err(anyhow!("relocation publication preparation failed; both homes retained")); }
        data.refresh_publication()?;
        let _publication_parents = data.hold_publication_parents()?;
        let mut apply = publication_args.clone();
        apply.extend(["-PublicationAction".into(), "apply".into()]);
        let result = run_install_script(&app, &script.path, &apply, Some(&youtab_home), None, Some("home-publication".into())).await?;
        if result.exit_code != Some(0) {
            let mut rollback = publication_args;
            rollback.extend(["-PublicationAction".into(), "rollback".into()]);
            let restored = run_install_script(&app, &script.path, &rollback, Some(&youtab_home), None, Some("home-publication".into())).await?;
            return Err(anyhow!("relocation publication failed; rollback exit {:?}; both homes and journal retained", restored.exit_code));
        }
        data.refresh_publication()?;
        if data.publication_phase() != Some("published") { return Err(anyhow!("relocation publication was not confirmed")); }
    }

    if release_base.is_some() && relocation.is_none() {
        // This is the only customer discovery publication. Stage-Path was a
        // deliberate no-op, so a failed install never registers an incomplete
        // home. Preserve any different existing User binding and all data.
        let registration_args = install_stage_args("home-registration", &manifest_args, false, None);
        let result = run_install_script(&app, &script.path, &registration_args,
            Some(&youtab_home), None, Some("home-registration".into())).await?;
        let frame = powershell::parse_stage_result(&result.stdout);
        if result.exit_code != Some(0) || !frame.as_ref().is_some_and(|value| value.ok && !value.skipped) {
            return Err(anyhow!("validated customer home registration failed; installed files retained for recovery"));
        }
    }

    // Artifact installs stage and verify Setup within the joint transaction.
    // Preserve the existing development/legacy installation behavior.
    if release_base.is_none() {
      if let Some(namespace) = &code_namespace {
        namespace.revalidate().map_err(|reason|
            anyhow!("private installation namespace changed: {reason}"))?;
    }
    if let Err(err) = crate::paths::copy_self_to_youtab_home() {
        tracing::warn!("failed to copy installer into YOUTAB_AGENT_HOME (non-fatal)");
        emit_log(&format!(
            "[bootstrap] warning: could not stage updater binary: {err}"
        ));
      }
    }

    emit_event(
        &app,
        BootstrapEvent::Complete {
            install_root: install_root.to_string_lossy().into_owned(),
            marker: Some(marker),
        },
    );

    Ok(install_root.to_string_lossy().into_owned())
}

async fn cancellation_signalled(holder: &Arc<Mutex<Option<mpsc::Receiver<()>>>>) -> bool {
    let mut guard = holder.lock().await;
    if let Some(rx) = guard.as_mut() {
        rx.try_recv().is_ok()
    } else {
        false
    }
}

async fn run_install_script(
    app: &AppHandle,
    script_path: &std::path::Path,
    args: &[String],
    youtab_home_override: Option<&str>,
    cancel_rx: Option<mpsc::Receiver<()>>,
    stage_name: Option<String>,
) -> Result<powershell::ScriptResult> {
    let app_for_stdout = app.clone();
    let stage_for_stdout = stage_name.clone();
    let app_for_stderr = app.clone();
    let stage_for_stderr = stage_name.clone();
    let stage_for_stdout_log = stage_name.clone();
    let stage_for_stderr_log = stage_name.clone();

    let sink = StreamSink {
        on_stdout_line: Box::new(move |line: &str| {
            emit_event(
                &app_for_stdout,
                BootstrapEvent::Log {
                    stage: stage_for_stdout.clone(),
                    line: line.to_string(),
                    stream: LogStream::Stdout,
                },
            );
            // Record the fixed category, never the raw install.ps1 line.
            match &stage_for_stdout_log {
                Some(name) => {
                    tracing::info!(target: "bootstrap.log", stage = %name, "{}", crate::events::fixed_diagnostic(line, true))
                }
                None => tracing::info!(target: "bootstrap.log", "{}", crate::events::fixed_diagnostic(line, true)),
            }
        }),
        on_stderr_line: Box::new(move |line: &str| {
            emit_event(
                &app_for_stderr,
                BootstrapEvent::Log {
                    stage: stage_for_stderr.clone(),
                    line: line.to_string(),
                    stream: LogStream::Stderr,
                },
            );
            // Keep stderr severity distinct while omitting its raw body.
            match &stage_for_stderr_log {
                Some(name) => {
                    tracing::warn!(target: "bootstrap.log", stage = %name, "stderr: {}", crate::events::fixed_diagnostic(line, true))
                }
                None => tracing::warn!(target: "bootstrap.log", "stderr: {}", crate::events::fixed_diagnostic(line, true)),
            }
        }),
    };

    powershell::run_script(script_path, args, sink, youtab_home_override, cancel_rx)
        .await
        .map_err(|e| {
            tracing::error!("install script invocation failed");
            anyhow!("install script invocation failed: {e:#}")
        })
}

fn build_pin_args(script: &install_script::ResolvedScript) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(c) = &script.commit {
        out.push("-Commit".to_string());
        out.push(c.clone());
    }
    if let Some(b) = &script.branch {
        out.push("-Branch".to_string());
        out.push(b.clone());
    }
    if let Some(base) = option_env!("RELEASE_BASE_URL") {
        out.push("-ReleaseBaseUrl".to_string());
        out.push(base.to_string());
    }
    out
}

fn emit_event(app: &AppHandle, event: BootstrapEvent) {
    let event = event.safe_for_display();
    // Tee important state transitions to the rolling installer log so
    // bootstrap-installer.log isn't just "starting" + final summary.
    // Log lines (the noisy stuff) handle their own tracing in
    // run_install_script's sink; here we cover the lifecycle frames.
    match &event {
        BootstrapEvent::Manifest { stages, .. } => {
            tracing::info!(
                stage_count = stages.len(),
                names = ?stages.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
                "manifest received"
            );
        }
        BootstrapEvent::Stage {
            name,
            state,
            duration_ms,
            error,
            ..
        } => {
            tracing::info!(
                stage = %name,
                ?state,
                duration_ms = ?duration_ms,
                error = ?error,
                "stage transition"
            );
        }
        BootstrapEvent::Complete { install_root, .. } => {
            tracing::info!(install_root = %install_root, "bootstrap complete");
        }
        BootstrapEvent::Failed { stage, error } => {
            tracing::error!(stage = ?stage, error = %error, "bootstrap FAILED");
        }
        BootstrapEvent::Log { .. } => {
            // Log lines are teed via the sink callbacks in
            // run_install_script â€” don't double-emit here.
        }
    }
    let event = event.with_diagnostic();
    tracing::info!(operation_id = %event.diagnostic.operation_id,
        diagnostic_code = %event.diagnostic.code, diagnostic_stage = %event.diagnostic.stage,
        "installer diagnostic context");
    if app.emit(BootstrapEvent::CHANNEL, &event).is_err() {
        tracing::warn!("failed to emit bootstrap event");
    }
}

fn option_env_string(key: &str) -> Option<String> {
    // option_env! only accepts literals, so we hardcode the known keys.
    let val = match key {
        "BUILD_PIN_COMMIT" => option_env!("BUILD_PIN_COMMIT"),
        "BUILD_PIN_BRANCH" => option_env!("BUILD_PIN_BRANCH"),
        _ => None,
    };
    val.map(|s| s.to_string())
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::path::Path;

    #[cfg(windows)]
    #[tokio::test]
    async fn production_stage_request_binds_journal_through_real_powershell_contract() {
        let fixture = crate::update_coordination::relocation_test_fixture();
        let old = fixture.path().join("old"); let home = fixture.path().join("new");
        std::fs::create_dir(&old).unwrap(); std::fs::create_dir(&home).unwrap();
        let namespace = crate::update_coordination::admit_private_code_namespace(&home).unwrap();
        let relocation = crate::home_relocation::Relocation::begin(&old, &home, &namespace).unwrap();
        let manifest = vec!["-PrivateHomeRelocation".into(), "-Commit".into(), "0".repeat(40),
            "-ReleaseBaseUrl".into(), format!("https://api.youtab.io/pilot-runtime-{}/releases", "0".repeat(32))];
        let request = install_stage_args("git", &manifest, false, Some(&relocation.journal_path()));
        let helper = PathBuf::from(std::env::var_os("YOUTAB_RELOCATION_STAGE_CONTRACT_HELPER").unwrap());
        let previous = std::env::var_os("YOUTAB_AGENT_RELOCATION_SOURCE");
        std::env::set_var("YOUTAB_AGENT_RELOCATION_SOURCE", &old);
        let result = crate::powershell::run_script(&helper, &request, crate::powershell::StreamSink {
            on_stdout_line: Box::new(|_| {}), on_stderr_line: Box::new(|_| {}),
        }, Some(home.to_str().unwrap()), None).await;
        match previous { Some(value) => std::env::set_var("YOUTAB_AGENT_RELOCATION_SOURCE", value), None => std::env::remove_var("YOUTAB_AGENT_RELOCATION_SOURCE") }
        let result = result.unwrap();
        assert_eq!(result.exit_code, Some(0), "production stage contract failed: {}", result.stderr);
        let frame = crate::powershell::parse_stage_result(&result.stdout).unwrap();
        assert!(frame.ok && !frame.skipped);
        assert_eq!(frame.data.as_ref().unwrap()["production_journal_bound"], true);
        assert_eq!(frame.data.as_ref().unwrap()["git_calls"], 1);
    }

    #[cfg(windows)]
    #[test]
    fn both_production_desktop_constructors_refresh_actual_child_environment() {
        let fixture = crate::update_coordination::relocation_test_fixture();
        let old = fixture.path().join("old"); let home = fixture.path().join("new");
        let custom = fixture.path().join("explicit-custom");
        std::fs::create_dir(&old).unwrap(); std::fs::create_dir(&home).unwrap(); std::fs::create_dir(&custom).unwrap();
        std::fs::create_dir_all(custom.join("bin")).unwrap();
        std::fs::write(custom.join("bin/bash.exe"), b"external synthetic binding data; not executed").unwrap();
        std::fs::write(custom.join("bash.exe"), b"explicit synthetic override data; not executed").unwrap();
        let junction = old.join("git");
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        // canonicalized fixture paths use verbatim Windows syntax. cmd's
        // mklink grammar needs ordinary spellings at this shell boundary.
        let shell_path = |path: &Path| PathBuf::from(path.to_str().unwrap().strip_prefix("\\\\?\\").unwrap_or(path.to_str().unwrap()));
        let shell_junction = shell_path(&junction);
        let shell_target = shell_path(&custom);
        let shell_fixture = shell_path(fixture.path());
        assert_eq!(shell_target.canonicalize().unwrap(), custom.canonicalize().unwrap());
        assert_eq!(shell_fixture.canonicalize().unwrap(), fixture.path().canonicalize().unwrap());
        use std::os::windows::process::CommandExt;
        for path in [&shell_junction, &shell_target] {
            assert!(!path.to_str().unwrap().chars().any(|c| "\"&|<>^%!\r\n".contains(c)), "owned fixture shell metacharacter refused");
        }
        // cmd decodes its own command string, not CRT argv quoting. This exact
        // once-quoted native form created the real junction in the PS5.1 probe.
        let shell_command = format!("\"mklink /J \"{}\" \"{}\"\"", shell_junction.display(), shell_target.display());
        let output = std::process::Command::new(system.join(r"System32\cmd.exe"))
            .args(["/d", "/s", "/c"]).raw_arg(&shell_command)
            .current_dir(&shell_fixture).output().unwrap();
        assert!(output.status.success(), "owned junction command failed: cwd={}, raw_args=/d /s /c {}, stdout={}, stderr={}",
            shell_fixture.display(), shell_command, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert_eq!(old.join("git/bin/bash.exe").canonicalize().unwrap(), custom.join("bin/bash.exe").canonicalize().unwrap());
        let namespace = crate::update_coordination::admit_private_code_namespace(&home).unwrap();
        std::fs::create_dir_all(home.join("git/bin")).unwrap();
        std::fs::write(home.join("git/bin/bash.exe"), b"synthetic binding data; not executed").unwrap();
        let bash = home.join("git/bin/bash.exe");
        let desired_path = format!("{};{}", home.join("git/bin").display(), home.join("youtab-agent-runtime/venv/Scripts").display());
        let mut journal = serde_json::json!({"schema":1,"source":old.canonicalize().unwrap(),"target":home.canonicalize().unwrap(),
            "phase":"product-validated","entries":[],"retained_product_roots":[],"publication":{"phase":"published","variables":[
                {"name":"Path","desired":desired_path},{"name":"YOUTAB_AGENT_HOME","desired":home},
                {"name":"YOUTAB_AGENT_GIT_BASH_PATH","desired":bash}]}});
        let journal_path = home.join(".youtab-home-relocation-v1.json");
        std::fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
        let names = ["YOUTAB_AGENT_RELOCATION_SOURCE", "PATH", "YOUTAB_AGENT_GIT_BASH_PATH"];
        let previous: Vec<_> = names.iter().map(|name| std::env::var_os(name)).collect();
        std::env::set_var(names[0], &old);
        std::env::set_var(names[1], format!("{};{};{}", old.join("git/bin").display(), custom.join("bin").display(), custom.display()));
        std::env::set_var(names[2], old.join("git/bin/bash.exe"));
        let python = PathBuf::from(std::env::var_os("YOUTAB_RELOCATION_TEST_PYTHON").unwrap());
        let install_root = home.join("youtab-agent-runtime");
        let probe = "import json,os; print(json.dumps({k:os.environ.get(k) for k in ['PATH','YOUTAB_AGENT_GIT_BASH_PATH','YOUTAB_AGENT_HOME']}))";
        let capture = |mut command: std::process::Command| {
            let output = command.args(["-I", "-S", "-B", "-c", probe]).output().unwrap();
            assert!(output.status.success()); serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
        };
        let synchronous = capture(desktop_launch_command_std(&python, &install_root).unwrap());
        let mut asynchronous = desktop_launch_command(&python, &install_root).unwrap();
        let output = asynchronous.as_std_mut().args(["-I", "-S", "-B", "-c", probe]).output().unwrap();
        assert!(output.status.success());
        let asynchronous: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        std::env::set_var(names[2], custom.join("bash.exe"));
        let explicit = capture(desktop_launch_command_std(&python, &install_root).unwrap());
        journal["publication"]["phase"] = serde_json::json!("prepared");
        std::fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
        let refused_std = desktop_launch_command_std(&python, &install_root).is_err();
        let refused_tokio = desktop_launch_command(&python, &install_root).is_err();
        for (name, value) in names.into_iter().zip(previous) {
            match value { Some(value) => std::env::set_var(name, value), None => std::env::remove_var(name) }
        }
        // Remove only this owned junction entry; its external fixture target
        // and synthetic bytes remain intact until the owned TempDir cleanup.
        std::fs::remove_dir(&junction).unwrap();
        for child in [&synchronous, &asynchronous] {
            assert_eq!(child["YOUTAB_AGENT_HOME"], home.to_string_lossy().as_ref());
            assert_eq!(child["YOUTAB_AGENT_GIT_BASH_PATH"], bash.to_string_lossy().as_ref());
            let path = child["PATH"].as_str().unwrap();
            assert!(!path.contains(old.to_str().unwrap()));
            assert!(path.contains(custom.to_str().unwrap()));
            assert!(path.split(';').any(|entry| entry == custom.join("bin").to_str().unwrap()));
            assert!(path.starts_with(&desired_path));
        }
        assert_eq!(explicit["YOUTAB_AGENT_GIT_BASH_PATH"], custom.join("bash.exe").to_string_lossy().as_ref());
        assert!(refused_std && refused_tokio);
        namespace.revalidate().unwrap();
    }

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "youtab-bootstrap-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    // Build a fake built-desktop release tree at the platform's expected path
    // and return (install_root, expected_app_bundle_or_exe).
    fn make_release_tree(install_root: &Path) -> PathBuf {
        let release = install_root.join("apps").join("desktop").join("release");
        if cfg!(target_os = "macos") {
            let macos_dir = release
                .join("mac-arm64")
                .join("Youtab.app")
                .join("Contents")
                .join("MacOS");
            std::fs::create_dir_all(&macos_dir).unwrap();
            std::fs::write(macos_dir.join("Youtab"), b"#!/bin/sh\n").unwrap();
            macos_dir.parent().unwrap().parent().unwrap().to_path_buf() // .../Youtab.app
        } else if cfg!(target_os = "windows") {
            let dir = release.join("win-unpacked");
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join("Youtab.exe");
            std::fs::write(&exe, b"stub").unwrap();
            exe
        } else {
            let dir = release.join("linux-unpacked");
            std::fs::create_dir_all(&dir).unwrap();
            let exe = dir.join("youtab");
            std::fs::write(&exe, b"stub").unwrap();
            exe
        }
    }

    // The relaunch / install target is derived from the rebuilt desktop app.
    // On macOS this MUST resolve to the .app bundle (what `open` relaunches and
    // what the updater ditto's over /Applications/Youtab.app). A regression in
    // this derivation breaks the post-update auto-relaunch, so guard it.
    #[test]
    fn resolve_youtab_desktop_app_finds_built_bundle() {
        let root = unique_tmp_dir("app-ok");
        let expected = make_release_tree(&root);

        let resolved = resolve_youtab_desktop_app(&root)
            .expect("should resolve the freshly-built desktop app");

        #[cfg(target_os = "macos")]
        {
            assert_eq!(resolved, expected, "must resolve to the .app bundle");
            assert_eq!(
                resolved.extension().and_then(|e| e.to_str()),
                Some("app"),
                "relaunch target must be a .app bundle on macOS"
            );
        }
        #[cfg(not(target_os = "macos"))]
        {
            assert_eq!(resolved, expected);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_youtab_desktop_app_is_none_without_a_build() {
        let root = unique_tmp_dir("app-none");
        // No release tree created.
        assert!(
            resolve_youtab_desktop_app(&root).is_none(),
            "no resolved app when nothing has been built"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bootstrap_complete_marker_uses_desktop_compatible_schema() {
        let root = unique_tmp_dir("marker-schema");
        let pin = Pin {
            commit: Some("abcdef1234567890".to_string()),
            branch: Some("main".to_string()),
        };

        let marker =
            write_bootstrap_complete_marker(&root, &pin).expect("marker write should succeed");
        let marker_path = root.join(".youtab-agent-runtime-bootstrap-complete");
        let from_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&marker_path).unwrap()).unwrap();

        assert_eq!(marker, from_disk);
        assert_eq!(from_disk["schemaVersion"], 1);
        assert_eq!(from_disk["pinnedCommit"], "abcdef1234567890");
        assert_eq!(from_disk["pinnedBranch"], "main");
        assert!(
            from_disk["completedAtUnix"].as_u64().is_some(),
            "marker must carry a completion timestamp"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn artifact_marker_binds_runtime_desktop_contract_bytes() {
        let root = unique_tmp_dir("marker-runtime-contract");
        let source = "a".repeat(40);
        let pin = Pin { commit: Some(source.clone()), branch: None };
        let artifact = ArtifactInstallInfo {
            staged: root.join("unused"), source_sha: source.clone(),
            artifact_sha256: "b".repeat(64), version: "0.19.2".into(),
            release_sequence: 3, release_base_url: "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases".into(),
            release_channel: "pilot".into(), setup_sha256: "c".repeat(64), setup_size: 64,
        };
        assert!(write_bootstrap_complete_marker_with_artifact(&root, &pin, Some(&artifact)).is_err());
        let contract = br#"{"capabilities":["serve"],"entrypoint":"venv/Scripts/youtab.exe","schemaVersion":1,"sourceSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","version":"0.19.2"}"#;
        std::fs::write(root.join("runtime-desktop.json"), contract).unwrap();
        let marker = write_bootstrap_complete_marker_with_artifact(&root, &pin, Some(&artifact)).unwrap();
        assert_eq!(marker["runtimeContractSha256"], crate::paths::installer_sha256(&root.join("runtime-desktop.json")).unwrap());
        assert_eq!(marker["artifactSha256"], artifact.artifact_sha256);
        let marker_path = root.join(".youtab-agent-runtime-bootstrap-complete");
        std::fs::remove_file(&marker_path).unwrap();
        let valid: serde_json::Value = serde_json::from_slice(contract).unwrap();
        for (field, value) in [
            ("sourceSha", serde_json::json!("c".repeat(40))),
            ("version", serde_json::json!("0.19.1")),
            ("entrypoint", serde_json::json!("../../outside.exe")),
            ("capabilities", serde_json::json!(["serve", "extra"])),
            ("schemaVersion", serde_json::json!(2)),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            std::fs::write(root.join("runtime-desktop.json"), serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(write_bootstrap_complete_marker_with_artifact(&root, &pin, Some(&artifact)).is_err(), "{field} must be rejected");
            assert!(!marker_path.exists(), "invalid contract must not publish a success marker");
        }
        std::fs::write(root.join("runtime-desktop.json"), b"not JSON").unwrap();
        assert!(write_bootstrap_complete_marker_with_artifact(&root, &pin, Some(&artifact)).is_err());
        assert!(!marker_path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bootstrap_complete_marker_is_published_atomically() {
        let root = unique_tmp_dir("marker-atomic");
        make_release_tree(&root);
        let pin = Pin {
            commit: Some("abcdef1234567890".to_string()),
            branch: Some("main".to_string()),
        };

        write_bootstrap_complete_marker(&root, &pin).expect("marker write should succeed");

        let marker_path = root.join(".youtab-agent-runtime-bootstrap-complete");
        let tmp_path = root.join(".youtab-agent-runtime-bootstrap-complete.tmp");
        assert!(
            marker_path.is_file(),
            "final marker must exist after atomic publish"
        );
        assert!(
            !tmp_path.exists(),
            "temp sibling must not remain after atomic publish"
        );
        assert!(
            youtab_is_installed(&root),
            "atomically published marker must enable the installer fast path"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn youtab_is_installed_treats_marker_existence_as_sufficient() {
        // Documents why write_bootstrap_complete_marker must publish atomically:
        // the launcher predicate only checks existence, so a partial/corrupt
        // final marker would still enable the fast path.
        let root = unique_tmp_dir("marker-existence-only");
        make_release_tree(&root);
        std::fs::write(root.join(".youtab-agent-runtime-bootstrap-complete"), b"").unwrap();

        assert!(
            youtab_is_installed(&root),
            "empty/partial marker content still counts as installed"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn marker_write_failure_leaves_no_final_marker() {
        // install_root is a regular file â†’ create_dir_all on its path fails
        // before any marker bytes are published under the final name.
        let base = unique_tmp_dir("marker-fail");
        let not_a_dir = base.join("not-a-dir");
        std::fs::write(&not_a_dir, b"not a directory").unwrap();
        let pin = Pin {
            commit: Some("abcdef1234567890".to_string()),
            branch: Some("main".to_string()),
        };

        let err = write_bootstrap_complete_marker(&not_a_dir, &pin)
            .expect_err("marker write against a non-directory root must fail");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("bootstrap marker"),
            "error should mention the marker path: {msg}"
        );
        assert!(
            !not_a_dir.join(".youtab-agent-runtime-bootstrap-complete").exists(),
            "failed write must not leave a final marker that enables the fast path"
        );
        assert!(
            !not_a_dir.join(".youtab-agent-runtime-bootstrap-complete.tmp").exists(),
            "failed write must not leave a temp marker sibling either"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn install_swap_restores_old_tree_on_failure() {
        let parent = unique_tmp_dir("swap-rollback");
        let current = parent.join("youtab-agent-runtime");
        let staged = parent.join("youtab-agent-runtime.new-test");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(current.join("old.txt"), b"old").unwrap();
        std::fs::write(staged.join("new.txt"), b"new").unwrap();
        let mut swap = InstallSwap::promote(&current, &staged).unwrap();
        assert!(current.join("new.txt").exists());
        swap.rollback().unwrap();
        assert!(current.join("old.txt").exists());
        assert!(!current.join("new.txt").exists());
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn install_swap_recovers_crash_before_and_after_promotion() {
        let parent = unique_tmp_dir("swap-crash");
        let current = parent.join("youtab-agent-runtime");
        let staged = parent.join("youtab-agent-runtime.new-test");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("old.txt"), b"old").unwrap();
        InstallSwap::write_pending(&current, true).unwrap();
        std::fs::rename(&current, InstallSwap::backup_path(&current).unwrap()).unwrap();
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("old.txt").exists());

        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("new.txt"), b"new").unwrap();
        let swap = InstallSwap::promote(&current, &staged).unwrap();
        std::mem::forget(swap); // simulate process death before verification
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("old.txt").exists());
        assert!(!current.join("new.txt").exists());
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn fresh_install_failure_removes_unverified_current() {
        let parent = unique_tmp_dir("swap-fresh-failure");
        let current = parent.join("youtab-agent-runtime");
        let staged = parent.join("youtab-agent-runtime.new-test");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("new.txt"), b"new").unwrap();
        let mut swap = InstallSwap::promote(&current, &staged).unwrap();
        swap.rollback().unwrap();
        assert!(!current.exists());
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn artifact_stage_requires_exact_common_setup_identity() {
        let source = "a".repeat(40);
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let pin = Pin { commit: Some(source.clone()), branch: None };
        let valid = serde_json::json!({
            "staged_install_dir": "synthetic-stage", "source_sha": source,
            "artifact_sha256": "b".repeat(64), "version": "0.19.2",
            "release_sequence": 1, "release_base_url": base,
            "setup_source_sha": source, "setup_sha256": "c".repeat(64),
            "setup_size": 1024, "update_coordination_protocol": 1,
        });
        let accepted = ArtifactInstallInfo::from_stage_data(&valid, &pin, base).unwrap();
        assert_eq!(accepted.setup_sha256, "c".repeat(64));
        assert_eq!(accepted.setup_size, 1024);
        let mut largest = valid.clone(); largest["setup_size"] = serde_json::json!(256 * 1024 * 1024);
        assert_eq!(ArtifactInstallInfo::from_stage_data(&largest, &pin, base).unwrap().setup_size, 256 * 1024 * 1024);
        for (key, value) in [
            ("setup_source_sha", serde_json::json!("d".repeat(40))),
            ("setup_sha256", serde_json::json!("C".repeat(64))),
            ("setup_size", serde_json::json!(0)),
            ("setup_size", serde_json::json!(268435457)),
            ("setup_size", serde_json::json!("1024")),
            ("update_coordination_protocol", serde_json::json!("1")),
            ("update_coordination_protocol", serde_json::json!(2)),
        ] {
            let mut malformed = valid.clone(); malformed[key] = value;
            assert!(ArtifactInstallInfo::from_stage_data(&malformed, &pin, base).is_err());
        }
    }

    #[test]
    fn artifact_replacement_rejects_downgrade_and_sequence_reuse() {
        let parent = unique_tmp_dir("swap-sequence");
        let current = parent.join("youtab-agent-runtime");
        std::fs::create_dir_all(&current).unwrap();
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let mut next = ArtifactInstallInfo {
            staged: parent.join("unused"), source_sha: "b".repeat(40),
            artifact_sha256: "c".repeat(64), version: "0.19.0".into(),
            release_sequence: 1, release_base_url: base.into(), release_channel: "stable".into(),
            setup_sha256: "f".repeat(64), setup_size: 64,
        };
        std::fs::write(current.join(".youtab-agent-runtime-bootstrap-complete"),
            serde_json::to_vec(&serde_json::json!({
                "releaseBaseUrl": base, "releaseSequence": 2,
                "pinnedCommit": "d".repeat(40), "artifactSha256": "e".repeat(64),
            })).unwrap()).unwrap();
        assert!(ensure_replacement_not_downgrade(&current, &next).is_err());
        next.release_sequence = 2;
        assert!(ensure_replacement_not_downgrade(&current, &next).is_err());
        next.release_sequence = 3;
        assert!(ensure_replacement_not_downgrade(&current, &next).is_ok());
        std::fs::write(current.join(".youtab-agent-runtime-bootstrap-complete"),
            serde_json::to_vec(&serde_json::json!({
                "releaseBaseUrl": base, "releaseSequence": 2,
                "pinnedCommit": "invalid", "artifactSha256": "e".repeat(64),
            })).unwrap()).unwrap();
        assert!(ensure_replacement_not_downgrade(&current, &next).is_err());
        let _ = std::fs::remove_dir_all(parent);
    }

    fn setup_swap_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let parent = unique_tmp_dir(label);
        let current = parent.join("youtab-agent-runtime");
        let staged = parent.join("youtab-agent-runtime.new-test");
        let source = parent.join("downloaded-setup.exe");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(current.join("old.txt"), b"old-runtime").unwrap();
        std::fs::write(staged.join("new.txt"), b"new-runtime").unwrap();
        std::fs::write(&source, b"new-setup-fixture").unwrap();
        std::fs::write(crate::paths::installer_dest_in(&parent), b"old-setup-fixture").unwrap();
        (parent, current, staged, source)
    }

    #[test]
    fn setup_only_repair_preserves_runtime_and_cleans_transaction() {
        let (parent, current, _staged, source) = setup_swap_fixture("setup-only-repair");
        let expected = crate::paths::installer_sha256(&source).unwrap();
        replace_setup_only(&current, &source, &expected).unwrap();
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap(), b"new-setup-fixture");
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        assert!(!InstallSwap::setup_paths(&current).unwrap().2.exists());
        replace_setup_only(&current, &source, &expected).unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_only_repair_rejects_unverified_source_without_touching_runtime() {
        let (parent, current, _staged, source) = setup_swap_fixture("setup-only-invalid");
        assert!(replace_setup_only(&current, &source, &"0".repeat(64)).is_err());
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap(), b"old-setup-fixture");
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_only_repair_refuses_foreign_failed_recovery_path() {
        let (parent, current, _staged, source) = setup_swap_fixture("setup-only-foreign-recovery");
        let expected = crate::paths::installer_sha256(&source).unwrap();
        let failed = crate::paths::installer_dest_in(&parent)
            .with_file_name("youtab-setup.exe.failed-recovery");
        std::fs::write(&failed, b"foreign-data").unwrap();
        assert!(replace_setup_only(&current, &source, &expected).is_err());
        assert_eq!(std::fs::read(&failed).unwrap(), b"foreign-data");
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap(), b"old-setup-fixture");
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn promotion_refuses_foreign_failed_recovery_path_before_journaling() {
        let (parent, current, staged, source) = setup_swap_fixture("promote-foreign-recovery");
        let failed = current.with_file_name("youtab-agent-runtime.failed-recovery");
        std::fs::create_dir(&failed).unwrap();
        std::fs::write(failed.join("foreign.txt"), b"foreign-data").unwrap();
        assert!(InstallSwap::promote_with_setup(&current, &staged, Some(&source)).is_err());
        assert_eq!(std::fs::read(failed.join("foreign.txt")).unwrap(), b"foreign-data");
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(staged.join("new.txt")).unwrap(), b"new-runtime");
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn pending_recovery_preserves_foreign_failed_path_and_backup() {
        let (parent, current, _staged, _source) = setup_swap_fixture("recover-foreign-failed");
        InstallSwap::write_pending(&current, true).unwrap();
        let backup = InstallSwap::backup_path(&current).unwrap();
        std::fs::rename(&current, &backup).unwrap();
        let failed = current.with_file_name("youtab-agent-runtime.failed-recovery");
        std::fs::create_dir(&failed).unwrap();
        std::fs::write(failed.join("foreign.txt"), b"foreign-data").unwrap();
        assert!(InstallSwap::recover(&current).is_err());
        assert!(!current.exists());
        assert_eq!(std::fs::read(backup.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(failed.join("foreign.txt")).unwrap(), b"foreign-data");
        assert!(InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_only_pending_recovery_restores_prior_setup_without_runtime_backup() {
        let (parent, current, _staged, source) = setup_swap_fixture("setup-only-recovery");
        let old = crate::paths::installer_dest_in(&parent);
        let old_sha = crate::paths::installer_sha256(&old).unwrap();
        let expected = crate::paths::installer_sha256(&source).unwrap();
        InstallSwap::write_journal(&current, &InstallJournal { schema: 2, had_old: true,
            setup: Some(SetupJournal { replace: true, previous_sha256: Some(old_sha),
                required_sha256: expected.clone() }), legacy_head_sha: None }).unwrap();
        let (_, stage, backup) = InstallSwap::setup_paths(&current).unwrap();
        crate::paths::stage_installer(&source, &stage, &expected).unwrap();
        std::fs::rename(&old, &backup).unwrap();
        std::fs::rename(&stage, &old).unwrap();
        InstallSwap::recover(&current).unwrap();
        assert_eq!(std::fs::read(&old).unwrap(), b"old-setup-fixture");
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert!(!backup.exists());
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_staging_success_commits_both_verified_paths() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-success");
        let (target, setup_stage, setup_backup) = InstallSwap::setup_paths(&current).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"old-setup-fixture");
        assert_eq!(std::fs::read(&setup_stage).unwrap(), b"new-setup-fixture");
        swap.install_setup().unwrap();
        swap.commit().unwrap();
        assert!(current.join("new.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), std::fs::read(source).unwrap());
        assert!(!setup_stage.exists());
        assert!(!setup_backup.exists());
        assert!(!InstallSwap::backup_path(&current).unwrap().exists());
        InstallSwap::recover(&current).unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_copy_and_verification_failure_preserves_existing_pair() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-copy-fail");
        let (target, setup_stage, _) = InstallSwap::setup_paths(&current).unwrap();
        // Missing source fails before either active path is touched.
        assert!(InstallSwap::promote_with_setup(&current, &staged, Some(&parent.join("missing"))).is_err());
        assert!(current.join("old.txt").exists());
        // The low-level copy never truncates an existing staging path.
        std::fs::write(&setup_stage, b"partial-copy").unwrap();
        let expected = crate::paths::installer_sha256(&source).unwrap();
        assert!(crate::paths::stage_installer(&source, &setup_stage, &expected).is_err());
        assert_eq!(std::fs::read(&setup_stage).unwrap(), b"partial-copy");
        std::fs::remove_file(&setup_stage).unwrap();
        // A copied file whose bytes fail verification remains journal-owned.
        InstallSwap::write_journal(&current, &InstallJournal {
            schema: 2, legacy_head_sha: None, had_old: true, setup: Some(SetupJournal {
                replace: true,
                previous_sha256: Some(crate::paths::installer_sha256(&target).unwrap()),
                required_sha256: "0".repeat(64),
            }),
        }).unwrap();
        assert!(crate::paths::stage_installer(&source, &setup_stage, &"0".repeat(64)).is_err());
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("old.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
        assert!(!setup_stage.exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_verification_failure_after_runtime_promotion_restores_both() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-verify-fail");
        let (target, setup_stage, _) = InstallSwap::setup_paths(&current).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        std::fs::write(&setup_stage, b"corrupt").unwrap();
        assert!(swap.install_setup().is_err());
        assert!(swap.commit().is_err());
        swap.rollback().unwrap();
        assert!(current.join("old.txt").exists());
        assert!(!current.join("new.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_recovery_after_both_promotions_restores_prior_install() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-crash");
        let (target, _, _) = InstallSwap::setup_paths(&current).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        swap.install_setup().unwrap();
        std::mem::forget(swap);
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("old.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
        InstallSwap::recover(&current).unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_missing_or_corrupt_after_promotion_never_commits() {
        for missing in [true, false] {
            let (parent, current, staged, source) = setup_swap_fixture("setup-final-verify");
            let (target, _, _) = InstallSwap::setup_paths(&current).unwrap();
            let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
            swap.install_setup().unwrap();
            if missing { std::fs::remove_file(&target).unwrap(); }
            else { std::fs::write(&target, b"corrupt").unwrap(); }
            assert!(swap.commit().is_err());
            swap.rollback().unwrap();
            assert!(current.join("old.txt").exists());
            assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
            std::fs::remove_dir_all(parent).unwrap();
        }
    }

    #[test]
    fn setup_running_from_stable_path_is_verified_without_self_replacement() {
        let (parent, current, staged, _) = setup_swap_fixture("setup-self");
        let (target, setup_stage, setup_backup) = InstallSwap::setup_paths(&current).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&target)).unwrap();
        assert!(!setup_stage.exists());
        swap.install_setup().unwrap();
        swap.commit().unwrap();
        assert!(!setup_backup.exists());
        assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_fresh_install_failure_removes_both_unverified_paths() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-fresh");
        let (target, _, _) = InstallSwap::setup_paths(&current).unwrap();
        std::fs::remove_dir_all(&current).unwrap();
        std::fs::remove_file(&target).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        swap.install_setup().unwrap();
        swap.rollback().unwrap();
        assert!(!current.exists());
        assert!(!target.exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_recovery_between_backup_and_promotion_restores_prior_pair() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-rename-crash");
        let (target, _, backup) = InstallSwap::setup_paths(&current).unwrap();
        let swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        std::fs::rename(&target, &backup).unwrap();
        std::mem::forget(swap);
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("old.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_committed_crash_retries_cleanup_without_reverting_verified_pair() {
        let (parent, current, staged, source) = setup_swap_fixture("setup-commit-crash");
        let (target, _, backup) = InstallSwap::setup_paths(&current).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        swap.install_setup().unwrap();
        std::fs::write(InstallSwap::marker_path(&current, "committed").unwrap(), b"verified\n").unwrap();
        std::mem::forget(swap);
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("new.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), b"new-setup-fixture");
        assert!(!backup.exists());
        assert!(!InstallSwap::backup_path(&current).unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn setup_legacy_runtime_only_journal_remains_recoverable() {
        let (parent, current, _, _) = setup_swap_fixture("setup-legacy-journal");
        std::fs::write(InstallSwap::marker_path(&current, "pending").unwrap(), b"old\n").unwrap();
        std::fs::rename(&current, InstallSwap::backup_path(&current).unwrap()).unwrap();
        InstallSwap::recover(&current).unwrap();
        assert!(current.join("old.txt").exists());
        assert_eq!(std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap(), b"old-setup-fixture");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn setup_windows_lock_fails_closed_then_recovery_retries_after_unlock() {
        use std::os::windows::fs::OpenOptionsExt;
        let (parent, current, staged, source) = setup_swap_fixture("setup-windows-lock");
        let (target, _, _) = InstallSwap::setup_paths(&current).unwrap();
        let mut swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        assert!(swap.install_setup().is_err());
        assert!(swap.commit().is_err());
        assert!(swap.rollback().is_err());
        assert!(InstallSwap::backup_path(&current).unwrap().exists());
        assert!(InstallSwap::marker_path(&current, "pending").unwrap().exists());
        drop(lock);
        swap.rollback().unwrap();
        assert!(current.join("old.txt").exists());
        assert_eq!(std::fs::read(target).unwrap(), b"old-setup-fixture");
        std::fs::remove_dir_all(parent).unwrap();
    }

    fn legacy_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf, String) {
        let (parent, current, staged, setup) = setup_swap_fixture(label);
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(["-c", "core.hooksPath=", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"])
                .arg("-C").arg(&current).args(args).output().unwrap();
            assert!(output.status.success(), "fixture Git command failed");
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        };
        git(&["init", "--quiet"]);
        git(&["add", "old.txt"]);
        git(&["commit", "--quiet", "-m", "Original install"]);
        let pin = git(&["rev-parse", "HEAD"]);
        std::fs::write(current.join("carried.txt"), b"carried-local-work").unwrap();
        git(&["add", "carried.txt"]);
        git(&["commit", "--quiet", "-m", "Carried local commit"]);
        let head = git(&["rev-parse", "HEAD"]);
        std::fs::write(current.join("untracked.txt"), b"untracked-local-work").unwrap();
        std::fs::write(current.join(".youtab-agent-runtime-bootstrap-complete"),
            serde_json::to_vec(&serde_json::json!({"schemaVersion": 1, "pinnedCommit": pin})).unwrap()).unwrap();
        (parent, current, staged, setup, head)
    }

    #[test]
    fn migration_preserves_git_carried_commits_and_untracked_files_after_commit() {
        let (parent, current, staged, setup, head) = legacy_fixture("migration-preserve");
        std::fs::write(parent.join("config.yaml"), b"user-config-fixture").unwrap();
        assert_eq!(validate_legacy_migration(&current).unwrap(), head);
        let mut swap = InstallSwap::promote_with_policy(&current, &staged, Some(&setup), Some(head.clone())).unwrap();
        swap.install_setup().unwrap();
        swap.commit().unwrap();
        let archive = InstallSwap::legacy_archive_path(&current).unwrap();
        assert_eq!(legacy_git_head(&archive).unwrap(), head);
        assert_eq!(std::fs::read(archive.join("carried.txt")).unwrap(), b"carried-local-work");
        assert_eq!(std::fs::read(archive.join("untracked.txt")).unwrap(), b"untracked-local-work");
        assert_eq!(std::fs::read(parent.join("config.yaml")).unwrap(), b"user-config-fixture");
        assert!(current.join("new.txt").exists());
        assert!(!InstallSwap::backup_path(&current).unwrap().exists());
        InstallSwap::recover(&current).unwrap();
        assert!(archive.join(".git").is_dir());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn migration_failure_rolls_back_runtime_and_setup_without_losing_local_work() {
        let (parent, current, staged, setup, head) = legacy_fixture("migration-rollback");
        {
            let mut swap = InstallSwap::promote_with_policy(&current, &staged, Some(&setup), Some(head.clone())).unwrap();
            swap.install_setup().unwrap();
            // Simulated provisioning/health failure: uncommitted drop rolls back.
        }
        assert_eq!(legacy_git_head(&current).unwrap(), head);
        assert_eq!(std::fs::read(current.join("untracked.txt")).unwrap(), b"untracked-local-work");
        assert_eq!(std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap(), b"old-setup-fixture");
        assert!(!InstallSwap::legacy_archive_path(&current).unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn migration_committed_recovery_resumes_after_archive_rename() {
        let (parent, current, staged, setup, head) = legacy_fixture("migration-resume");
        let mut swap = InstallSwap::promote_with_policy(&current, &staged, Some(&setup), Some(head.clone())).unwrap();
        swap.install_setup().unwrap();
        std::fs::write(InstallSwap::marker_path(&current, "committed").unwrap(), b"verified\n").unwrap();
        let archive = InstallSwap::legacy_archive_path(&current).unwrap();
        std::fs::rename(InstallSwap::backup_path(&current).unwrap(), &archive).unwrap();
        std::mem::forget(swap);
        InstallSwap::recover(&current).unwrap();
        InstallSwap::recover(&current).unwrap();
        assert_eq!(legacy_git_head(&archive).unwrap(), head);
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn migration_existing_archive_fails_before_any_promotion() {
        let (parent, current, staged, setup, head) = legacy_fixture("migration-collision");
        let archive = InstallSwap::legacy_archive_path(&current).unwrap();
        std::fs::create_dir(&archive).unwrap();
        std::fs::write(archive.join("preserve.txt"), b"previous-archive").unwrap();
        assert!(InstallSwap::promote_with_policy(&current, &staged, Some(&setup), Some(head.clone())).is_err());
        assert_eq!(legacy_git_head(&current).unwrap(), head);
        assert_eq!(std::fs::read(archive.join("preserve.txt")).unwrap(), b"previous-archive");
        assert!(staged.join("new.txt").exists());
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn migration_flag_cannot_bypass_artifact_channel_or_partial_metadata() {
        let (parent, current, _, _, _) = legacy_fixture("migration-no-bypass");
        let marker = current.join(".youtab-agent-runtime-bootstrap-complete");
        let original: serde_json::Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        for key in ["releaseBaseUrl", "releaseSequence", "artifactSha256"] {
            let mut data = original.clone();
            data[key] = serde_json::json!("damaged-or-different-channel");
            std::fs::write(&marker, serde_json::to_vec(&data).unwrap()).unwrap();
            assert!(validate_legacy_migration(&current).is_err(), "{key}");
        }
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn migration_invalid_journal_preserves_pending_state() {
        let (parent, current, _, _, _) = legacy_fixture("migration-invalid-journal");
        let pending = InstallSwap::marker_path(&current, "pending").unwrap();
        std::fs::write(&pending, br#"{"schema":3,"had_old":false,"setup":null,"legacy_head_sha":"invalid"}"#).unwrap();
        assert!(InstallSwap::recover(&current).is_err());
        assert!(pending.exists());
        assert!(current.join("carried.txt").exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn later_artifact_updates_leave_the_preserved_legacy_tree_untouched() {
        let (parent, current, staged, setup, head) = legacy_fixture("migration-later-update");
        let mut swap = InstallSwap::promote_with_policy(&current, &staged, Some(&setup), Some(head.clone())).unwrap();
        swap.install_setup().unwrap();
        swap.commit().unwrap();
        let archive = InstallSwap::legacy_archive_path(&current).unwrap();
        let next = parent.join("youtab-agent-runtime.new-later");
        std::fs::create_dir(&next).unwrap();
        std::fs::write(next.join("later.txt"), b"later-artifact").unwrap();
        let mut update = InstallSwap::promote_with_setup(&current, &next, Some(&setup)).unwrap();
        update.install_setup().unwrap();
        update.commit().unwrap();
        assert!(current.join("later.txt").exists());
        assert_eq!(legacy_git_head(&archive).unwrap(), head);
        assert_eq!(std::fs::read(archive.join("untracked.txt")).unwrap(), b"untracked-local-work");
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn migration_source_change_fails_before_promotion() {
        let (parent, current, staged, setup, _) = legacy_fixture("migration-source-change");
        assert!(InstallSwap::promote_with_policy(&current, &staged, Some(&setup), Some("a".repeat(40))).is_err());
        assert!(current.join("carried.txt").exists());
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn markerless_repair_requires_its_setup_bound_fresh_transaction() {
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("youtab-agent-runtime");
        let setup = parent.path().join("repair-setup.exe");
        std::fs::write(&setup, b"exact setup fixture").unwrap();
        let hash = crate::paths::installer_sha256(&setup).unwrap();

        // An arbitrary markerless directory must never be treated as an
        // interrupted install, even when it contains existing user data.
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("preserve.txt"), b"user data").unwrap();
        assert!(validate_pending_repair(&root, &setup, base).is_err());
        assert!(root.join("preserve.txt").exists());

        let journal = InstallJournal { schema: 2, had_old: false,
            setup: Some(SetupJournal { replace: true, previous_sha256: None,
                required_sha256: hash.clone() }), legacy_head_sha: None };
        InstallSwap::write_journal(&root, &journal).unwrap();
        assert!(matches!(validate_pending_repair(&root, &setup, base), Ok(MarkerlessRepair::Fresh)));
        let preserved = preserve_pending_runtime(&root).unwrap().unwrap();
        InstallSwap::recover(&root).unwrap();
        assert!(!root.exists());
        assert_eq!(std::fs::read(preserved.join("runtime").join("preserve.txt")).unwrap(), b"user data");
        let other = parent.path().join("different-setup.exe");
        std::fs::write(&other, b"different bytes").unwrap();
        assert!(validate_pending_repair(&root, &other, base).is_err());

        std::fs::write(InstallSwap::marker_path(&root, "pending").unwrap(),
            serde_json::to_vec(&InstallJournal { had_old: true, ..journal }).unwrap()).unwrap();
        assert!(validate_pending_repair(&root, &setup, base).is_err());
        assert_eq!(std::fs::read(preserved.join("runtime").join("preserve.txt")).unwrap(), b"user data");
    }

    #[test]
    fn fresh_repair_preserves_tree_when_marker_was_written_before_commit() {
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("youtab-agent-runtime");
        let setup = parent.path().join("repair-setup.exe");
        std::fs::write(&setup, b"exact setup fixture").unwrap();
        std::fs::create_dir(&root).unwrap();
        let marker = root.join(".youtab-agent-runtime-bootstrap-complete");
        std::fs::write(&marker, b"verified-but-uncommitted-marker").unwrap();
        std::fs::write(root.join("preserve.txt"), b"do not delete").unwrap();
        InstallSwap::write_journal(&root, &InstallJournal { schema: 2, had_old: false,
            setup: Some(SetupJournal { replace: true, previous_sha256: None,
                required_sha256: crate::paths::installer_sha256(&setup).unwrap() }),
            legacy_head_sha: None }).unwrap();

        assert!(matches!(validate_pending_repair(&root, &setup, base), Ok(MarkerlessRepair::Fresh)));
        let preserved = preserve_pending_runtime(&root).unwrap().unwrap();
        InstallSwap::recover(&root).unwrap();
        assert!(!root.exists());
        assert!(!InstallSwap::marker_path(&root, "pending").unwrap().exists());
        assert_eq!(std::fs::read(preserved.join("runtime").join("preserve.txt")).unwrap(), b"do not delete");
        assert_eq!(std::fs::read(preserved.join("runtime").join(".youtab-agent-runtime-bootstrap-complete")).unwrap(),
            b"verified-but-uncommitted-marker");
    }

    #[test]
    fn fresh_repair_restores_preexisting_setup_without_runtime() {
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("youtab-agent-runtime");
        let old_setup = crate::paths::installer_dest_in(parent.path());
        std::fs::write(&old_setup, b"old common Setup").unwrap();
        let next_setup = parent.path().join("next-setup.exe");
        std::fs::write(&next_setup, b"next common Setup").unwrap();
        InstallSwap::write_journal(&root, &InstallJournal { schema: 2, had_old: false,
            setup: Some(SetupJournal { replace: true,
                previous_sha256: Some(crate::paths::installer_sha256(&old_setup).unwrap()),
                required_sha256: crate::paths::installer_sha256(&next_setup).unwrap() }),
            legacy_head_sha: None }).unwrap();
        assert!(matches!(validate_pending_repair(&root, &next_setup, base), Ok(MarkerlessRepair::Fresh)));
        InstallSwap::recover(&root).unwrap();
        assert_eq!(std::fs::read(&old_setup).unwrap(), b"old common Setup");
        assert!(!root.exists());
        assert!(!InstallSwap::marker_path(&root, "pending").unwrap().exists());
    }

    #[test]
    fn interrupted_update_before_backup_keeps_old_active_runtime() {
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let (parent, current, _staged, source) = setup_swap_fixture("repair-before-backup");
        let marker_name = ".youtab-agent-runtime-bootstrap-complete";
        let old_marker = serde_json::to_vec(&serde_json::json!({
            "releaseBaseUrl": base, "releaseSequence": 2, "releaseChannel": "pilot",
            "pinnedCommit": "a".repeat(40), "artifactSha256": "b".repeat(64),
        })).unwrap();
        std::fs::write(current.join(marker_name), &old_marker).unwrap();
        let old_setup = crate::paths::installer_dest_in(&parent);
        InstallSwap::write_journal(&current, &InstallJournal { schema: 2, had_old: true,
            setup: Some(SetupJournal { replace: true,
                previous_sha256: Some(crate::paths::installer_sha256(&old_setup).unwrap()),
                required_sha256: crate::paths::installer_sha256(&source).unwrap() }),
            legacy_head_sha: None }).unwrap();

        let admitted = validate_pending_repair(&current, &source, base).unwrap();
        let MarkerlessRepair::InterruptedUpdate { previous_runtime, backup_present, previous_marker } = admitted else {
            panic!("expected interrupted update admission");
        };
        assert!(!backup_present);
        assert_eq!(previous_runtime, current);
        assert_eq!(previous_marker, old_marker);
        InstallSwap::recover(&current).unwrap();
        assert_eq!(std::fs::read(current.join(marker_name)).unwrap(), old_marker);
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
    }

    #[test]
    fn markerless_repair_admits_verified_interrupted_artifact_update_and_restores_old_pair() {
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let (parent, current, staged, source) = setup_swap_fixture("repair-update-recovery");
        let marker_name = ".youtab-agent-runtime-bootstrap-complete";
        let old_marker = serde_json::to_vec(&serde_json::json!({
            "releaseBaseUrl": base, "releaseSequence": 2, "releaseChannel": "pilot",
            "pinnedCommit": "a".repeat(40), "artifactSha256": "b".repeat(64),
        })).unwrap();
        std::fs::write(current.join(marker_name), &old_marker).unwrap();
        let old_setup = std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap();
        let swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        std::mem::forget(swap); // crash after Runtime rename, before new marker

        let admitted = validate_pending_repair(&current, &source, base).unwrap();
        let MarkerlessRepair::InterruptedUpdate { previous_runtime, backup_present, previous_marker } = admitted else {
            panic!("expected interrupted update admission");
        };
        assert!(backup_present);
        assert_eq!(previous_runtime, InstallSwap::backup_path(&current).unwrap());
        assert_eq!(previous_marker, old_marker);
        std::fs::write(current.join("uncommitted-user-file.txt"), b"preserve during rollback").unwrap();
        let preserved = preserve_pending_runtime(&current).unwrap().unwrap();
        InstallSwap::recover(&current).unwrap();
        assert_eq!(std::fs::read(current.join(marker_name)).unwrap(), old_marker);
        assert_eq!(std::fs::read(current.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(preserved.join("runtime").join("uncommitted-user-file.txt")).unwrap(),
            b"preserve during rollback");
        assert_eq!(std::fs::read(crate::paths::installer_dest_in(&parent)).unwrap(), old_setup);
        assert!(!InstallSwap::marker_path(&current, "pending").unwrap().exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn markerless_interrupted_update_refuses_missing_or_tampered_prior_identity() {
        let base = "https://api.youtab.io/pilot-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/releases";
        let (parent, current, staged, source) = setup_swap_fixture("repair-update-refusal");
        let marker_name = ".youtab-agent-runtime-bootstrap-complete";
        let old_marker = serde_json::to_vec(&serde_json::json!({
            "releaseBaseUrl": base, "releaseSequence": 2, "releaseChannel": "pilot",
            "pinnedCommit": "a".repeat(40), "artifactSha256": "b".repeat(64),
        })).unwrap();
        std::fs::write(current.join(marker_name), &old_marker).unwrap();
        let old_setup_path = crate::paths::installer_dest_in(&parent);
        let old_setup = std::fs::read(&old_setup_path).unwrap();
        let swap = InstallSwap::promote_with_setup(&current, &staged, Some(&source)).unwrap();
        std::mem::forget(swap);
        let backup = InstallSwap::backup_path(&current).unwrap();
        let marker = backup.join(marker_name);
        assert!(validate_pending_repair(&current, &source, base).is_ok());

        std::fs::write(&marker, b"not an artifact marker").unwrap();
        assert!(validate_pending_repair(&current, &source, base).is_err());
        std::fs::write(&marker, &old_marker).unwrap();
        std::fs::write(&old_setup_path, b"unknown previous Setup").unwrap();
        assert!(validate_pending_repair(&current, &source, base).is_err());
        std::fs::write(&old_setup_path, &old_setup).unwrap();
        let missing = parent.join("preserved-backup-fixture");
        std::fs::rename(&backup, &missing).unwrap();
        assert!(validate_pending_repair(&current, &source, base).is_err());
        std::fs::rename(&missing, &backup).unwrap();

        assert!(InstallSwap::marker_path(&current, "pending").unwrap().exists());
        assert_eq!(std::fs::read(backup.join("old.txt")).unwrap(), b"old-runtime");
        assert_eq!(std::fs::read(current.join("new.txt")).unwrap(), b"new-runtime");
        InstallSwap::recover(&current).unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }

}
