//! Data-only relocation for the existing common Windows Setup.
//! Caller retains PrivateCodeNamespace and the install lock. No source code executes.
//! Discovery publication is deliberately unavailable until its existing side effects
//! are journaled by Setup; validate_for_publication is only a precondition.
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File, OpenOptions}, io::{Read, Seek, SeekFrom, Write}, path::{Path, PathBuf}, process::{Command, Stdio}};
use crate::update_coordination::PrivateCodeNamespace;


const PRIVATE_PYTHON_LOCK: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../config/windows-private-home-prerequisites.json"));

/// Select only the full base authorized by this common Setup's shipped lock.
/// UV's sibling minor-version convenience junction is not an execution root.
pub(crate) fn private_python_base(home: &Path, namespace: &PrivateCodeNamespace) -> Result<PathBuf> {
    namespace.require_home(home).map_err(|e| anyhow!(e))?;
    namespace.revalidate().map_err(|e| anyhow!(e))?;
    let home = namespace.selected_home().map_err(|e| anyhow!(e))?;
    let trusted: serde_json::Value = serde_json::from_str(PRIVATE_PYTHON_LOCK)?;
    let lock_path = home.join("youtab-agent-runtime/config/windows-private-home-prerequisites.json");
    let receipt_path = home.join("bootstrap-cache/private-prerequisites/python-receipt.json");
    let mut authority = Vec::new();
    for path in [&lock_path, &receipt_path] {
        let code = namespace.admit_existing_code_tree(path).map_err(|e| anyhow!(e))?
            .ok_or_else(|| anyhow!("private Python authority is absent"))?;
        code.revalidate().map_err(|e| anyhow!(e))?;
        authority.push(code);
    }
    let read = |path: &Path| -> Result<serde_json::Value> {
        let mut file = open_frozen(path)?;
        if file.metadata()?.len() > 1024 * 1024 { bail!("private Python authority size differs"); }
        let mut bytes = Vec::new(); file.read_to_end(&mut bytes)?;
        Ok(serde_json::from_slice(&bytes)?)
    };
    let lock = read(&lock_path)?;
    let receipt = read(&receipt_path)?;
    if lock["schema"] != 1 || lock["python"] != trusted["python"] ||
        receipt["key"] != trusted["python"]["key"] || receipt["sha256"] != trusted["python"]["sha256"] {
        bail!("private Python lock/receipt differs from common Setup authority");
    }
    let key = trusted["python"]["key"].as_str().context("common Setup Python key absent")?;
    let relative = valid_relative(&format!("python/{key}"))?;
    let base = home.join(relative);
    let tree = namespace.admit_existing_code_tree(&base).map_err(|e| anyhow!(e))?
        .ok_or_else(|| anyhow!("exact private Python base is absent"))?;
    tree.revalidate().map_err(|e| anyhow!(e))?;
    for item in &authority { item.revalidate().map_err(|e| anyhow!(e))?; }
    namespace.revalidate().map_err(|e| anyhow!(e))?;
    Ok(base)
}

fn private_python_binding_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    text.strip_prefix("\\\\?\\").unwrap_or(&text).trim_end_matches('\\').to_lowercase()
}
fn require_exact_private_python_binding(observed: &Path, expected: &Path) -> Result<()> {
    // Permit Windows case/verbatim spelling, never a minor alias/foreign path.
    if private_python_binding_key(observed) != private_python_binding_key(expected) || observed.canonicalize()? != expected.canonicalize()? {
        bail!("target interpreter does not bind its exact locked private base");
    }
    regular_metadata(observed)?;
    Ok(())
}
fn private_venv_lexically_contains(python: &Path, code_root: &Path) -> bool {
    #[cfg(windows)]
    {
        let python_key = private_python_binding_key(python);
        let root_key = private_python_binding_key(code_root);
        let python = Path::new(&python_key);
        let root = Path::new(&root_key);
        !python.components().any(|part| matches!(part, std::path::Component::ParentDir)) &&
            !root.components().any(|part| matches!(part, std::path::Component::ParentDir)) && python.starts_with(root)
    }
    #[cfg(not(windows))]
    { !python.components().any(|part| matches!(part, std::path::Component::ParentDir)) && python.starts_with(code_root) }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StartupIntent { pub source: PathBuf, pub target: PathBuf }
impl StartupIntent {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Option<Self>> {
        let args: Vec<_> = args.into_iter().collect();
        if !args.iter().any(|a| a == "--relocate-home-v1") {
            if args.iter().any(|a| a == "--source-home" || a == "--target-home") {
                bail!("source/target home flags require explicit relocation intent");
            }
            return Ok(None);
        }
        if args.iter().any(|a| matches!(a.as_str(), "--update" | "--repair" | "--reinstall" | "--migrate-legacy")) {
            bail!("home relocation is a separate common Setup install intent");
        }
        if args.iter().filter(|a| *a == "--relocate-home-v1").count() != 1 {
            bail!("duplicate relocation intent");
        }
        let read = |flag: &str| -> Result<PathBuf> {
            let positions: Vec<_> = args.iter().enumerate().filter(|(_, a)| *a == flag).map(|(i, _)| i).collect();
            if positions.len() != 1 { bail!("relocation requires exactly one {flag}"); }
            let value = args.get(positions[0] + 1).filter(|v| !v.starts_with("--"))
                .ok_or_else(|| anyhow!("missing {flag} value"))?;
            let path = PathBuf::from(value);
            if !path.is_absolute() { bail!("relocation homes must be absolute"); }
            Ok(path)
        };
        Ok(Some(Self { source: read("--source-home")?, target: read("--target-home")? }))
    }
    pub fn prepare_before_logging(&self) -> Result<PrivateCodeNamespace> {
        if !regular_metadata(&self.source)?.is_dir() { bail!("relocation source is not a directory"); }
        let source = self.source.canonicalize()?;
        let parent = self.target.parent().context("target has no parent")?;
        regular_metadata(parent)?;
        let prospective = parent.canonicalize()?.join(self.target.file_name().context("target has no name")?);
        disjoint(&source, &prospective)?;
        if !self.target.exists() { fs::create_dir(&self.target)?; }
        regular_metadata(&self.target)?;
        let namespace = crate::update_coordination::admit_private_code_namespace(&self.target)
            .map_err(|e| anyhow!("relocation target refused before logging: {e}"))?;
        namespace.revalidate().map_err(|e| anyhow!(e))?;
        let target = self.target.canonicalize()?;
        if !target.join(JOURNAL).exists() && !target.join(JOURNAL_STAGE).exists() {
            let handoff = pre_journal_handoff(&source, &target);
            verify_pre_journal_target(&target, &handoff, false)?;
            if !handoff.exists() { fs::create_dir(&handoff)?; }
            verify_pre_journal_target(&target, &handoff, true)?;
        }
        Ok(namespace)
    }
}
/// The UI accepts a parent directory and always creates one product-owned leaf.
/// Existing user data can move only through the preserving relocation journal.
#[cfg(windows)]
pub(crate) fn selected_location_target(source: &Path, parent: &Path) -> Result<PathBuf> {
    if !parent.is_absolute() { bail!("installation location must be absolute"); }
    for ancestor in parent.ancestors() {
        if !regular_metadata(ancestor)?.is_dir() { bail!("installation parent is not a regular directory"); }
    }
    let parent = parent.canonicalize()?;
    let target = parent.join("Youtab");
    let source = source.canonicalize()?;
    if crate::paths::same_windows_path(&source, &target) { return Ok(target); }
    disjoint(&source, &target)?;
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            if !regular_metadata(&target)?.is_dir() { bail!("installation target is not a regular directory"); }
            let mut entries = fs::read_dir(&target)?;
            if entries.next().is_some() {
                // A failed relocation is resumable only with its original
                // source and target. Another installation is never adopted.
                let target = target.canonicalize()?;
                if target.join(JOURNAL).exists() {
                    let journal = read_guarded_journal(&target.join(JOURNAL))?;
                    if journal.schema != 1 || journal.source != source || journal.target != target {
                        bail!("installation target contains unrelated state");
                    }
                } else {
                    verify_pre_journal_target(&target, &pre_journal_handoff(&source, &target), true)?;
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(target)
}

pub fn startup_intent() -> Result<Option<StartupIntent>> {
    StartupIntent::parse(std::env::args().skip(1))
}
pub fn log_directory(home: &Path, relocation: bool) -> PathBuf {
    if relocation { home.join("bootstrap-cache/relocation-logs") } else { home.join("logs") }
}
pub fn source_for_current_setup() -> Result<Option<PathBuf>> {
    Ok(startup_intent()?.map(|intent| intent.source))
}

// All relocation children discard Python environment injection at the shared
// launch boundary. Fresh Python entrypoints additionally use -I.
pub fn isolate_std_child(command: &mut std::process::Command) {
    for (name, _) in std::env::vars_os() {
        let key = name.to_string_lossy().to_ascii_uppercase();
        if key.starts_with("PYTHON") || matches!(key.as_str(), "VIRTUAL_ENV" | "__PYVENV_LAUNCHER__") {
            command.env_remove(name);
        }
    }
}
pub fn isolate_tokio_child(command: &mut tokio::process::Command) {
    isolate_std_child(command.as_std_mut());
}

// Only the confirmed publication snapshot may refresh Setup's cached child
// bindings. Reading process environment is separate from User registry writes.
pub fn published_child_bindings(home: &Path, source: &Path) -> Result<Vec<(String, String)>> {
    let namespace = crate::update_coordination::admit_private_code_namespace(home).map_err(|e| anyhow!(e))?;
    namespace.require_home(home).map_err(|e| anyhow!(e))?;
    let journal = read_guarded_journal(&home.join(JOURNAL))?;
    if journal.schema != 1 || journal.target != home.canonicalize()? || journal.source != source.canonicalize()? ||
        journal.phase != "product-validated" {
        bail!("relocation child requires the validated matching publication journal");
    }
    let publication = journal.publication.as_ref().context("publication snapshot absent")?;
    if publication.get("phase").and_then(|v| v.as_str()) != Some("published") {
        bail!("relocation publication is not confirmed for child launch");
    }
    let variables = publication.get("variables").and_then(|v| v.as_array()).context("published variables absent")?;
    let mut desired = BTreeMap::new();
    for variable in variables {
        let name = variable.get("name").and_then(|v| v.as_str()).context("published variable name absent")?;
        if !matches!(name, "Path" | "YOUTAB_AGENT_HOME" | "YOUTAB_AGENT_GIT_BASH_PATH") || desired.contains_key(name) {
            bail!("invalid or duplicate published child variable");
        }
        desired.insert(name, variable.get("desired").and_then(|v| v.as_str()).context("published child value absent")?);
    }
    let lexical_key = |value: &Path| {
        let mut normalized = PathBuf::new();
        for component in value.components() {
            match component {
                std::path::Component::CurDir => {},
                std::path::Component::ParentDir => { normalized.pop(); },
                _ => normalized.push(component.as_os_str()),
            }
        }
        normalized.to_string_lossy().replace('/', "\\").trim_start_matches("\\\\?\\").trim_end_matches('\\').to_lowercase()
    };
    let key = |value: &Path| lexical_key(&value.canonicalize().unwrap_or_else(|_| value.to_path_buf()));
    let source_key = key(&journal.source);
    let lexical_source_key = lexical_key(source);
    let descendant = |value: &str, root: &str| value == root || value.starts_with(&(root.to_string() + "\\"));
    let owned = |value: &str| {
        let path = Path::new(value.trim_matches('"'));
        let lexical = lexical_key(path);
        // Retained OLD product code may be a junction. Its OLD lexical binding
        // remains owned even when canonicalization resolves to an external tree.
        descendant(&lexical, &lexical_source_key) || descendant(&lexical, &source_key) ||
            descendant(&key(path), &source_key)
    };
    if key(Path::new(desired.get("YOUTAB_AGENT_HOME").context("published home absent")?)) != key(home) {
        bail!("published child home differs from admitted target");
    }
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut paths = Vec::new();
    for part in desired.get("Path").context("published PATH absent")?.split(';').chain(inherited_path.split(';')) {
        if !part.is_empty() && !owned(part) && seen.insert(key(Path::new(part.trim_matches('"')))) {
            paths.push(part.to_string());
        }
    }
    let mut bindings = vec![("PATH".into(), paths.join(";"))];
    let inherited_bash = std::env::var("YOUTAB_AGENT_GIT_BASH_PATH").ok();
    let stale_bash = inherited_bash.as_deref().is_some_and(owned);
    if let Some(bash) = desired.get("YOUTAB_AGENT_GIT_BASH_PATH") {
        let expected = home.join("git/bin/bash.exe");
        if Path::new(bash).canonicalize()? != expected.canonicalize()? { bail!("published managed Git binding differs"); }
        let git = namespace.admit_existing_code_tree(&home.join("git")).map_err(|e| anyhow!(e))?
            .ok_or_else(|| anyhow!("published fresh Git code is absent"))?;
        git.revalidate().map_err(|e| anyhow!(e))?;
        if inherited_bash.is_none() || stale_bash { bindings.push(("YOUTAB_AGENT_GIT_BASH_PATH".into(), (*bash).into())); }
    } else if stale_bash { bail!("cached OLD Bash has no confirmed published replacement"); }
    namespace.revalidate().map_err(|e| anyhow!(e))?;
    Ok(bindings)
}

const JOURNAL: &str = ".youtab-home-relocation-v1.json";
const JOURNAL_STAGE: &str = ".youtab-home-relocation-v1.json.new-staged";
const HANDOFF_PREFIX: &str = ".youtab-home-relocation-v1.handoff-";
const MAX_ENTRIES: usize = 32768;
fn pre_journal_handoff(source: &Path, target: &Path) -> PathBuf {
    // Directory creation is atomic: a crash cannot leave a half-written
    // identity. Both inputs have already been canonicalized by the caller.
    let mut digest = Sha256::new();
    digest.update(b"youtab-relocation-handoff-v1\0");
    digest.update(source.to_string_lossy().to_lowercase().as_bytes());
    digest.update(b"\0");
    digest.update(target.to_string_lossy().to_lowercase().as_bytes());
    target.join(format!("{HANDOFF_PREFIX}{:x}", digest.finalize()))
}

fn verify_pre_journal_target(target: &Path, handoff: &Path, require_handoff: bool) -> Result<()> {
    let expected = handoff.file_name().context("handoff name absent")?;
    let mut found = false;
    let mut saw_state = false;
    for child in fs::read_dir(target)? {
        let child = child?;
        saw_state = true;
        let name = child.file_name();
        let path = child.path();
        if name == expected {
            if !regular_metadata(&path)?.is_dir() || fs::read_dir(&path)?.next().is_some() {
                bail!("relocation handoff identity is not an empty regular directory");
            }
            found = true;
        } else if name == "bootstrap-cache" {
            if !regular_metadata(&path)?.is_dir() { bail!("relocation cache is not a regular directory"); }
            for item in fs::read_dir(&path)? {
                let item = item?;
                let item_name = item.file_name();
                if item_name == "relocation-logs" {
                    if !regular_metadata(&item.path())?.is_dir() { bail!("relocation logs are not a regular directory"); }
                    for log in fs::read_dir(item.path())? {
                        let log = log?;
                        let log_name = log.file_name();
                        let log_name = log_name.to_str().context("relocation log name is not Unicode")?;
                        if !matches!(log_name, "bootstrap-installer.log" | "bootstrap-installer.log.1" |
                            "bootstrap-installer.log.2" | "bootstrap-installer.log.3") ||
                            !regular_metadata(&log.path())?.is_file() {
                            bail!("unknown pre-journal relocation log state");
                        }
                    }
                } else if item_name == "relocation-recovery" {
                    if !regular_metadata(&item.path())?.is_dir() { bail!("relocation recovery is not a regular directory"); }
                    for saved in fs::read_dir(item.path())? {
                        let saved = saved?;
                        let name = saved.file_name();
                        let name = name.to_str().context("recovery file name is not Unicode")?;
                        let suffix = name.strip_prefix("journal-save-").and_then(|value| value.strip_suffix(".preserved"));
                        if !suffix.is_some_and(|value| uuid::Uuid::parse_str(value).is_ok()) ||
                            !regular_metadata(&saved.path())?.is_file() ||
                            regular_metadata(&saved.path())?.len() > 16777216 {
                            bail!("unknown pre-journal relocation recovery state");
                        }
                    }
                } else { bail!("unknown pre-journal relocation cache state"); }
            }
        } else if name == ".youtab-agent-runtime-update-in-progress" {
            if !regular_metadata(&path)?.is_file() { bail!("relocation install lock is not a regular file"); }
        } else if name == JOURNAL_STAGE {
            if !regular_metadata(&path)?.is_file() || regular_metadata(&path)?.len() > 16777216 {
                bail!("relocation staged journal is invalid");
            }
        } else { bail!("installation target contains unrelated state"); }
    }
    if (require_handoff || saw_state) && !found { bail!("relocation handoff identity is absent"); }
    Ok(())
}
const SQLITE_BACKUP: &str = r#"
import pathlib, sqlite3, sys
source, target = map(pathlib.Path, sys.argv[1:])
a = sqlite3.connect(str(source))  # writable PRIVATE replica permits hot-journal recovery
b = sqlite3.connect(str(target))
try:
    a.backup(b)
    if b.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise RuntimeError('SQLite snapshot validation failed')
finally:
    b.close()
    a.close()
"#;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    relative: String,
    directory: bool,
    source_hash: Option<String>,
    sqlite: bool,
    copied_hash: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedFile { source: Option<String>, content: Option<String> }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedIntent { entries: Vec<Entry>, files: BTreeMap<String, SeedFile> }
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    schema: u32,
    source: PathBuf,
    target: PathBuf,
    phase: String,
    entries: Vec<Entry>,
    retained_product_roots: Vec<String>,
    #[serde(default)]
    publication: Option<serde_json::Value>,
    #[serde(default)]
    trusted_defaults: Vec<Entry>,
    #[serde(default)]
    seeded_manifest_hash: Option<String>,
    #[serde(default)]
    seed_intent: Option<SeedIntent>,
}
struct FrozenSource {
    root: PathBuf,
    held: Vec<File>,
    entries: Vec<Entry>,
    retained: Vec<String>,
    target_inventory: bool,
}
pub struct Relocation<'a> {
    source: FrozenSource,
    namespace: &'a PrivateCodeNamespace,
    journal: Journal,
}

fn product_root(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(name.as_str(), "youtab-agent-runtime" | "bin" | "node" | "git" |
        "bootstrap-cache" | "update-cache" | "python" | "gateway-service" | "youtab-setup.exe" | "youtab-setup" |
        ".youtab-agent-runtime-update-in-progress") ||
        name.starts_with("youtab-agent-runtime.") ||
        name.starts_with(".youtab-runtime-install-")
}
fn valid_relative(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if value.is_empty() || value.contains(':') ||
        path.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
        bail!("invalid relocation relative path");
    }
    Ok(path)
}
fn regular_metadata(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
        bail!("relocation refuses linked or special objects");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { bail!("relocation refuses reparse points"); }
    }
    Ok(metadata)
}
fn open_frozen(path: &Path) -> Result<File> {
    regular_metadata(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options.share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).context("source data is unavailable or has an active writer")?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 ||
            info.dwFileAttributes & 0x400 != 0 ||
            (info.dwFileAttributes & 0x10 == 0 && info.nNumberOfLinks != 1) {
            bail!("source identity, reparse point or hardlink refused");
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.is_file() && file.metadata()?.nlink() != 1 {
            bail!("source hardlink refused");
        }
    }
    Ok(file)
}
fn file_hash(file: &mut File) -> Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn path_hash(path: &Path) -> Result<String> {
    if !regular_metadata(path)?.is_file() { bail!("expected a regular relocation file"); }
    file_hash(&mut File::open(path)?)
}
fn read_guarded_journal(path: &Path) -> Result<Journal> {
    let mut file = open_frozen(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 16777216 {
        bail!("invalid or oversized relocation journal");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    // The native handle remains retained through parsing; no named reread.
    let journal = serde_json::from_slice(&bytes)?;
    drop(file);
    Ok(journal)
}
fn disjoint(source: &Path, target: &Path) -> Result<()> {
    // canonicalize removes 8.3 aliases; case folding covers Windows spelling aliases.
    let key = |path: &Path| path.to_string_lossy().replace('/', "\\").to_lowercase();
    let source_key = key(source);
    let target_key = key(target);
    if source_key == target_key || source_key.starts_with(&(target_key.clone() + "\\")) ||
        target_key.starts_with(&(source_key + "\\")) {
        bail!("source and target homes must be distinct and disjoint");
    }
    Ok(())
}
impl FrozenSource {
    fn open(source: &Path) -> Result<Self> {
        let absolute = if source.is_absolute() { source.to_path_buf() } else { std::env::current_dir()?.join(source) };
        let mut held = Vec::new();
        for ancestor in absolute.ancestors() {
            held.push(open_frozen(ancestor)?);
        }
        let root = source.canonicalize()?;
        let mut result = Self { root, held, entries: Vec::new(), retained: Vec::new(), target_inventory: false };
        result.walk(Path::new(""))?;
        Ok(result)
    }
    fn walk(&mut self, relative: &Path) -> Result<()> {
        let mut children = fs::read_dir(self.root.join(relative))?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        let mut names = BTreeSet::new();
        for child in children {
            let name = child.file_name().into_string().map_err(|_| anyhow!("non-Unicode source name refused"))?;
            if !names.insert(name.to_lowercase()) { bail!("case alias in source data"); }
            let named_profile = relative.components().count() == 2 &&
                relative.components().next().is_some_and(|part| part.as_os_str() == "profiles");
            let old_handoff = name.strip_prefix(HANDOFF_PREFIX)
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
            if (relative.as_os_str().is_empty() && (product_root(&name) || old_handoff)) ||
                (named_profile && name.eq_ignore_ascii_case("gateway-service")) {
                self.retained.push(relative.join(name).to_string_lossy().into_owned()); continue;
            }
            if self.target_inventory && relative.as_os_str().is_empty() &&
                (name == JOURNAL || name == JOURNAL_STAGE) { continue; }
            if name == JOURNAL || name.starts_with(".relocation-") {
                bail!("source has reserved relocation entries");
            }
            if self.held.len() >= MAX_ENTRIES { bail!("source data handle limit reached; nothing is dropped"); }
            let rel = relative.join(name);
            let relative_string = rel.to_str().context("source path is not Unicode")?.to_string();
            valid_relative(&relative_string)?;
            let mut file = open_frozen(&child.path())?;
            let directory = file.metadata()?.is_dir();
            let (source_hash, sqlite) = if directory { (None, false) } else {
                let mut header = [0u8; 16];
                let count = file.read(&mut header)?;
                let sqlite = count == 16 && &header == b"SQLite format 3\0";
                (Some(file_hash(&mut file)?), sqlite)
            };
            self.entries.push(Entry { relative: relative_string, directory, source_hash, sqlite, copied_hash: None });
            self.held.push(file);
            if directory { self.walk(&rel)?; }
        }
        Ok(())
    }
    fn revalidate(&self) -> Result<()> {
        // Reenumeration also detects newly added/removed names; retained source
        // handles deny Windows writer/delete opens while the snapshot runs.
        let next = Self::open(&self.root)?;
        if next.entries != self.entries || next.retained != self.retained {
            bail!("source data changed during relocation; source and journal retained");
        }
        Ok(())
    }
}
impl<'a> Relocation<'a> {
    pub fn product_validated(&self) -> bool { self.journal.phase == "product-validated" }
    pub fn prepare_seed_defaults(&mut self, runtime: &Path) -> Result<()> {
        if !self.data_ready() || self.product_validated() { bail!("seeding requires copied unvalidated state"); }
        self.namespace.require_home(&self.journal.target).map_err(|e| anyhow!(e))?;
        if runtime.canonicalize()? != self.journal.target.join("youtab-agent-runtime").canonicalize()? { bail!("fresh target runtime required"); }
        self.verify_target_inventory()?;
        if self.journal.seed_intent.is_some() { return Ok(()); }
        let mut command = Command::new(runtime.join("venv/Scripts/python.exe"));
        command.args(["-I", "-S", "-B"]).arg(runtime.join("scripts/youtab/relocation_seed.py"))
            .arg("plan").arg(runtime).arg(&self.journal.target).current_dir(runtime);
        isolate_std_child(&mut command);
        let output = command.output()?;
        if !output.status.success() || output.stdout.len() > 16 * 1024 * 1024 { bail!("isolated seed planning failed"); }
        let intent: SeedIntent = serde_json::from_slice(&output.stdout)?;
        self.record_seed_intent(intent, runtime)
    }
    fn record_seed_intent(&mut self, intent: SeedIntent, runtime: &Path) -> Result<()> {
        if !self.data_ready() || self.product_validated() || self.journal.seed_intent.is_some() {
            bail!("seed intent requires copied state and may only be recorded once");
        }
        if intent.entries.len() > MAX_ENTRIES { bail!("oversized seed intent"); }
        let mut seen = BTreeSet::new();
        for entry in &intent.entries {
            let rel = valid_relative(&entry.relative)?;
            if !seen.insert(rel.clone()) || entry.sqlite || entry.copied_hash.is_some() { bail!("invalid seed intent entry"); }
            let normalized = entry.relative.replace('\\', "/");
            let skeleton = ["cron", "sessions", "logs", "pairing", "hooks", "image_cache", "audio_cache", "memories", "skills"];
            let original = self.journal.entries.iter().find(|old| old.relative == entry.relative);
            if original.is_some() && normalized != "skills/.bundled_manifest" { bail!("seed intent would replace copied user state"); }
            if entry.directory {
                if entry.source_hash.is_some() || !(skeleton.contains(&normalized.as_str()) || normalized.starts_with("skills/")) {
                    bail!("invalid seed directory");
                }
            } else {
                if self.journal.entries.iter().any(|old| old.relative.eq_ignore_ascii_case(&seed_stage_name(&entry.relative))) {
                    bail!("seed staging would replace copied user state");
                }
                let file = intent.files.get(&entry.relative).context("seed bytes absent")?;
                let data = match (&file.source, &file.content) {
                    (Some(source), None) => fs::read(runtime.join(valid_relative(source)?))?,
                    (None, Some(content)) => content.as_bytes().to_vec(),
                    _ => bail!("seed source must be exact packaged or generated bytes"),
                };
                if entry.source_hash.as_deref() != Some(format!("{:x}", Sha256::digest(&data)).as_str()) ||
                    !(normalized.starts_with("skills/") || matches!(normalized.as_str(), ".env" | "config.yaml" | "SOUL.md")) {
                    bail!("seed intent bytes or path differ");
                }
                if let Some(source) = &file.source {
                    let expected = match normalized.as_str() {
                        ".env" => ".env.example", "config.yaml" => "cli-config.yaml.example", _ => &entry.relative,
                    };
                    if valid_relative(source)? != valid_relative(expected)? { bail!("seed package mapping differs"); }
                }
            }
        }
        if intent.files.len() != intent.entries.iter().filter(|e| !e.directory).count() { bail!("extra seed files"); }
        self.source.revalidate()?;
        self.journal.seed_intent = Some(intent);
        self.save(false) // Durable intent precedes every configuration/skill write.
    }
    pub fn record_seeded_defaults(&mut self, runtime: &Path) -> Result<()> {
        if !self.data_ready() { bail!("seeding requires copied state"); }
        self.namespace.require_home(&self.journal.target).map_err(|e| anyhow!(e))?;
        if runtime.canonicalize()? != self.journal.target.join("youtab-agent-runtime").canonicalize()? { bail!("fresh target runtime required"); }
        let intent = self.journal.seed_intent.as_ref().context("durable seed intent absent")?;
        self.verify_target_inventory()?;
        let mut defaults = Vec::new();
        for entry in &intent.entries {
            let target = self.journal.target.join(valid_relative(&entry.relative)?);
            if regular_metadata(&target)?.is_dir() != entry.directory { bail!("seed entry type differs"); }
            if !entry.directory && Some(path_hash(&target)?) != entry.source_hash { bail!("seed bytes differ from durable intent"); }
            if entry.relative.replace('\\', "/") == "skills/.bundled_manifest" {
                self.journal.seeded_manifest_hash = entry.source_hash.clone();
            }
            if !self.journal.entries.iter().any(|old| old.relative == entry.relative) { defaults.push(entry.clone()); }
            if !entry.directory && self.journal.target.join(seed_stage_name(&entry.relative)).exists() {
                bail!("seed staging was not completed");
            }
        }
        for original in &self.journal.entries {
            if !original.directory && original.copied_hash.is_none() { continue; } // SQLite sidecars stay at source.
            let target = self.journal.target.join(valid_relative(&original.relative)?);
            if regular_metadata(&target)?.is_dir() != original.directory { bail!("copied entry type changed during seeding"); }
            if !original.directory {
                let expected = if original.relative.replace('\\', "/") == "skills/.bundled_manifest" {
                    self.journal.seeded_manifest_hash.as_ref().or(original.copied_hash.as_ref())
                } else { original.copied_hash.as_ref() };
                if Some(path_hash(&target)?).as_ref() != expected { bail!("copied user state changed during seeding"); }
            }
        }
        self.journal.trusted_defaults = defaults;
        self.source.revalidate()?;
        self.save(false)
    }
    pub fn journal_path(&self) -> PathBuf { self.journal.target.join(JOURNAL) }
    pub fn data_ready(&self) -> bool { self.journal.phase == "data-ready" || self.journal.phase == "product-validated" }
    pub fn publication_phase(&self) -> Option<&str> {
        self.journal.publication.as_ref()?.get("phase")?.as_str()
    }
    pub fn refresh_publication(&mut self) -> Result<()> {
        self.namespace.require_home(&self.journal.target).map_err(|e| anyhow!(e))?;
        let next = read_guarded_journal(&self.journal_path())?;
        if next.source != self.journal.source || next.target != self.journal.target ||
            next.entries != self.journal.entries || next.phase != self.journal.phase ||
            next.trusted_defaults != self.journal.trusted_defaults || next.seeded_manifest_hash != self.journal.seeded_manifest_hash || next.seed_intent != self.journal.seed_intent {
            bail!("publication changed relocation data identity");
        }
        self.journal.publication = next.publication;
        Ok(())
    }
    pub fn hold_publication_parents(&self) -> Result<Vec<File>> {
        let publication = self.journal.publication.as_ref().context("publication snapshot absent")?;
        let links = publication.get("links").and_then(|v| v.as_array()).context("publication links absent")?;
        let mut held = Vec::new();
        let startup = publication.get("autostart").and_then(|v| v.as_array());
        let startup_links = startup.into_iter().flatten().filter(|item| item.get("kind").and_then(|v| v.as_str()) == Some("startup"));
        for link in links.iter().chain(startup_links) {
            let path = Path::new(link.get("path").and_then(|v| v.as_str()).context("shortcut path absent")?);
            let name = path.file_name().and_then(|n| n.to_str()).context("publication filename absent")?;
            let startup = link.get("kind").and_then(|v| v.as_str()) == Some("startup") &&
                name.starts_with("Youtab_Gateway") && name.ends_with(".vbs");
            if (!startup && name != "Youtab.lnk") || !path.is_absolute() {
                bail!("invalid product shortcut path");
            }
            let parent = path.parent().context("shortcut parent absent")?;
            let canonical = parent.canonicalize()?;
            disjoint(&self.source.root, &canonical)?;
            for ancestor in parent.ancestors() { held.push(open_frozen(ancestor)?); }
        }
        Ok(held)
    }
    pub fn begin(source: &Path, target: &Path, namespace: &'a PrivateCodeNamespace) -> Result<Self> {
        namespace.require_home(target).map_err(|e| anyhow!(e))?;
        let frozen = FrozenSource::open(source)?;
        let target = target.canonicalize()?;
        disjoint(&frozen.root, &target)?;
        let handoff = pre_journal_handoff(&frozen.root, &target);
        if handoff.exists() { verify_pre_journal_target(&target, &handoff, true)?; }
        for child in fs::read_dir(&target)? {
            let child = child?;
            let name = child.file_name().into_string().map_err(|_| anyhow!("target name is not Unicode"))?;
            if !product_root(&name) && child.path() != handoff { bail!("target contains existing state; collision refused"); }
        }
        let journal = Journal { schema: 1, source: frozen.root.clone(), target,
            phase: "copying".into(), entries: frozen.entries.clone(),
            retained_product_roots: frozen.retained.clone(), publication: None, trusted_defaults: Vec::new(), seeded_manifest_hash: None, seed_intent: None };
        let relocation = Self { source: frozen, namespace, journal };
        relocation.save(true)?;
        Ok(relocation)
    }
    pub fn resume(source: &Path, target: &Path, namespace: &'a PrivateCodeNamespace) -> Result<Self> {
        namespace.require_home(target).map_err(|e| anyhow!(e))?;
        let target = target.canonicalize()?;
        Self::recover_journal_save(source, &target, namespace)?;
        let journal_path = target.join(JOURNAL);
        let journal = read_guarded_journal(&journal_path)?;
        let frozen = FrozenSource::open(source)?;
        disjoint(&frozen.root, &target)?;
        if journal.schema != 1 || journal.source != frozen.root || journal.target != target ||
            !matches!(journal.phase.as_str(), "copying" | "data-ready" | "product-validated") {
            bail!("journal homes or phase do not match");
        }
        let mut original = journal.entries.clone();
        for entry in &mut original { entry.copied_hash = None; valid_relative(&entry.relative)?; }
        if original != frozen.entries || journal.retained_product_roots != frozen.retained {
            bail!("source no longer matches journal; both homes retained");
        }
        let relocation = Self { source: frozen, namespace, journal };
        relocation.verify_target_inventory()?;
        Ok(relocation)
    }
    fn recover_journal_save(source: &Path, target: &Path, namespace: &'a PrivateCodeNamespace) -> Result<()> {
        namespace.require_home(target).map_err(|e| anyhow!(e))?;
        let stage = target.join(JOURNAL_STAGE);
        if !stage.exists() { return Ok(()); }
        let mut staged = open_frozen(&stage)?;
        if !staged.metadata()?.is_file() || staged.metadata()?.len() > 16777216 {
            bail!("journal stage is invalid or oversized");
        }
        let mut staged_bytes = Vec::new();
        staged.read_to_end(&mut staged_bytes)?;
        let pending = serde_json::from_slice::<Journal>(&staged_bytes);
        // Authorization decisions use bytes parsed under this retained handle.
        drop(staged);
        if !target.join(JOURNAL).exists() {
            let handoff = pre_journal_handoff(&source.canonicalize()?, target);
            if handoff.exists() { verify_pre_journal_target(target, &handoff, true)?; }
            if let Ok(pending) = &pending {
                if pending.schema != 1 || pending.source != source.canonicalize()? || pending.target != target ||
                    pending.phase != "copying" || pending.entries.iter().any(|entry| entry.copied_hash.is_some()) {
                    bail!("staged initial intent differs; metadata retained without mutation");
                }
            }
            // Before the first live journal exists, data copying cannot start.
            // Refuse any target user state; preserve torn metadata in private
            // product cache and reconstruct only from explicit source/target intent.
            for child in fs::read_dir(target)? {
                let child = child?;
                let name = child.file_name().into_string().map_err(|_| anyhow!("target name refused"))?;
                if name != JOURNAL_STAGE && !product_root(&name) && child.path() != handoff {
                    bail!("initial journal recovery found target state; retained for review");
                }
            }
        } else {
            // A fully activated old journal is authoritative. Discarding only
            // its unactivated save lets copy recovery verify any already-renamed
            // data against the same recorded source snapshot.
            let old = read_guarded_journal(&target.join(JOURNAL))?;
            if old.schema != 1 || old.source != source.canonicalize()? || old.target != target {
                bail!("active journal identity differs; staged metadata retained");
            }
        }
        namespace.require_home(target).map_err(|e| anyhow!(e))?;
        let cache = namespace.selected_home().map_err(|e| anyhow!(e))?.join("bootstrap-cache");
        let preserved = cache.join("relocation-recovery");
        // Reuse target-specific retained native directory/code admission.
        // Never follow an unchecked cache/recovery junction during creation.
        let mut held = Vec::new();
        for path in [&cache, &preserved] {
            if let Some(tree) = namespace.admit_existing_code_tree(path).map_err(|e| anyhow!(e))? {
                tree.revalidate().map_err(|e| anyhow!(e))?;
                held.push(tree);
            } else {
                fs::create_dir(path)?;
                let tree = namespace.admit_existing_code_tree(path).map_err(|e| anyhow!(e))?
                    .ok_or_else(|| anyhow!("recovery directory disappeared"))?;
                tree.revalidate().map_err(|e| anyhow!(e))?;
                held.push(tree);
            }
        }
        let saved = preserved.join(format!("journal-save-{}.preserved", uuid::Uuid::new_v4()));
        if saved.exists() { bail!("unique recovery destination collision"); }
        for tree in &held { tree.revalidate().map_err(|e| anyhow!(e))?; }
        fs::rename(&stage, saved)?;
        drop(held);
        if !target.join(JOURNAL).exists() {
            let next = Self::begin(source, target, namespace)?;
            drop(next);
        }
        Ok(())
    }
    fn save(&self, initial: bool) -> Result<()> {
        self.namespace.require_home(&self.journal.target).map_err(|e| anyhow!(e))?;
        let path = self.journal.target.join(JOURNAL);
        let staged = self.journal.target.join(JOURNAL_STAGE);
        let bytes = serde_json::to_vec_pretty(&self.journal)?;
        let mut file = OpenOptions::new().write(true).create_new(true).open(&staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        if initial {
            if path.exists() { bail!("initial journal collision; staged bytes retained"); }
            fs::rename(staged, path)?;
        } else {
            if !regular_metadata(&path)?.is_file() { bail!("active journal is not a regular file"); }
            atomic_replace(&staged, &path)?;
        }
        Ok(())
    }
    fn partial(&self, index: usize) -> PathBuf {
        self.journal.target.join(format!(".relocation-part-{index}"))
    }
    fn verify_target_inventory(&self) -> Result<()> {
        let handoff = pre_journal_handoff(&self.source.root, &self.journal.target);
        let mut allowed = BTreeSet::from([PathBuf::from(JOURNAL), PathBuf::from(JOURNAL_STAGE)]);
        allowed.insert(PathBuf::from(handoff.file_name().context("handoff name absent")?));
        for entry in &self.journal.trusted_defaults { allowed.insert(valid_relative(&entry.relative)?); }
        if let Some(intent) = &self.journal.seed_intent {
            for entry in &intent.entries {
                let rel = valid_relative(&entry.relative)?;
                allowed.insert(rel.clone());
                if !entry.directory {
                    allowed.insert(PathBuf::from(seed_stage_name(&entry.relative)));
                    let path = self.journal.target.join(&rel);
                    if path.exists() {
                        let actual = path_hash(&path)?;
                        let original = self.journal.entries.iter().find(|old| old.relative == entry.relative)
                            .and_then(|old| old.copied_hash.as_ref());
                        if Some(&actual) != entry.source_hash.as_ref() && Some(&actual) != original {
                            bail!("seed target bytes differ from durable intent; retained for review");
                        }
                    }
                }
            }
        }
        for (index, entry) in self.journal.entries.iter().enumerate() {
            allowed.insert(valid_relative(&entry.relative)?);
            allowed.insert(PathBuf::from(format!(".relocation-part-{index}")));
            allowed.insert(PathBuf::from(format!(".relocation-part-{index}.sqlite-source")));
            for suffix in ["", "-wal", "-shm", "-journal"] {
                allowed.insert(PathBuf::from(format!(".relocation-part-{index}.sqlite-source/source.db{suffix}")));
            }
        }
        fn walk(root: &Path, rel: &Path, allowed: &BTreeSet<PathBuf>) -> Result<()> {
            for child in fs::read_dir(root.join(rel))? {
                let child = child?;
                let name = child.file_name().into_string().map_err(|_| anyhow!("target name is not Unicode"))?;
                let profile = rel.components().count() == 2 &&
                    rel.components().next().is_some_and(|part| part.as_os_str() == "profiles");
                if (rel.as_os_str().is_empty() && product_root(&name)) ||
                    (profile && name.eq_ignore_ascii_case("gateway-service")) { continue; }
                let path = rel.join(name);
                if !allowed.contains(&path) { bail!("unknown target state collision; retained for review"); }
                let inspected = open_frozen(&child.path())?;
                let directory = inspected.metadata()?.is_dir();
                if directory { walk(root, &path, allowed)?; }
                drop(inspected);
            }
            Ok(())
        }
        walk(&self.journal.target, Path::new(""), &allowed)
    }
    pub fn copy_data(&mut self, python: &Path) -> Result<()> {
        self.namespace.revalidate().map_err(|e| anyhow!(e))?;
        // The caller supplies the NEW target interpreter after venv provisioning.
        // Admit the full executable tree, including Python's dlls/stdlib siblings.
        let code_root = self.namespace.selected_home().map_err(|e| anyhow!(e))?.join("youtab-agent-runtime/venv");
        if !private_venv_lexically_contains(python, &code_root) { bail!("snapshot interpreter is not in fresh target venv"); }
        let base_root = private_python_base(&self.journal.target, &self.namespace)?;
        let base = self.namespace.admit_existing_code_tree(&base_root).map_err(|e| anyhow!(e))?
            .ok_or_else(|| anyhow!("fresh private Python base is absent"))?;
        base.revalidate().map_err(|e| anyhow!(e))?;
        let config = fs::read_to_string(code_root.join("pyvenv.cfg"))?;
        let homes: Vec<_> = config.lines().filter_map(|line| line.split_once('='))
            .filter(|(key, _)| key.trim() == "home").map(|(_, value)| value.trim()).collect();
        if homes.len() != 1 {
            bail!("target venv does not bind its base to private target Python");
        }
        require_exact_private_python_binding(Path::new(homes[0]), &base_root)?;
        let code = self.namespace.admit_existing_code_tree(&code_root).map_err(|e| anyhow!(e))?
            .ok_or_else(|| anyhow!("fresh target Python tree is absent"))?;
        code.revalidate().map_err(|e| anyhow!(e))?;
        // Lexical components reject outside aliases; retained full-tree admission
        // rejects descendant reparses before canonical containment or execution.
        if !python.canonicalize()?.starts_with(code_root.canonicalize()?) || !regular_metadata(python)?.is_file() {
            bail!("snapshot interpreter does not bind regular code in fresh target venv");
        }
        self.copy_data_inner(python)?;
        base.revalidate().map_err(|e| anyhow!(e))?;
        code.revalidate().map_err(|e| anyhow!(e))?;
        Ok(())
    }
    fn copy_data_inner(&mut self, python: &Path) -> Result<()> {
        self.verify_target_inventory()?;
        for index in 0..self.journal.entries.len() {
            self.namespace.revalidate().map_err(|e| anyhow!(e))?;
            let entry = self.journal.entries[index].clone();
            let rel = valid_relative(&entry.relative)?;
            let target = self.journal.target.join(&rel);
            if entry.directory {
                if !target.exists() { fs::create_dir(&target)?; }
                if !regular_metadata(&target)?.is_dir() { bail!("directory collision"); }
                continue;
            }
            // WAL/SHM are inventoried and held but not activated alongside a
            // consistent snapshot. They remain untouched at source.
            let parent_db = ["-wal", "-shm", "-journal"].into_iter().find_map(|suffix|
                entry.relative.strip_suffix(suffix).filter(|base|
                    self.journal.entries.iter().any(|e| e.relative == *base && e.sqlite)));
            if parent_db.is_some() { continue; }
            if let Some(expected) = &entry.copied_hash {
                if path_hash(&target)? != *expected { bail!("copied data changed; target retained"); }
                continue;
            }
            let partial = self.partial(index);
            if partial.exists() {
                if !regular_metadata(&partial)?.is_file() { bail!("partial is not a regular owned file"); }
                fs::remove_file(&partial)?; // journal-owned target staging only
            }
            let source = self.source.root.join(&rel);
            if entry.sqlite {
                snapshot_sqlite(python, &source, &partial)?;
            } else {
                let mut input = open_frozen(&source)?;
                let mut output = OpenOptions::new().write(true).create_new(true).open(&partial)?;
                std::io::copy(&mut input, &mut output)?;
                output.sync_all()?;
            }
            let copied_hash = path_hash(&partial)?;
            if !entry.sqlite && Some(&copied_hash) != entry.source_hash.as_ref() {
                bail!("source copy digest mismatch");
            }
            if target.exists() {
                // Recovery after rename but before journal flush is idempotent.
                if path_hash(&target)? != copied_hash { bail!("target collision; both versions retained"); }
                fs::remove_file(&partial)?;
            } else { fs::rename(&partial, &target)?; }
            self.journal.entries[index].copied_hash = Some(copied_hash);
            self.save(false)?;
        }
        self.source.revalidate()?;
        self.journal.phase = "data-ready".into();
        self.save(false)
    }
    pub fn validate_for_publication(&mut self, source_sha: &str, setup_sha256: &str) -> Result<()> {
        if !self.data_ready() { bail!("relocation data is not ready"); }
        self.namespace.revalidate().map_err(|e| anyhow!(e))?;
        self.source.revalidate()?;
        self.verify_target_inventory()?;
        for entry in &self.journal.entries {
            if let Some(expected) = &entry.copied_hash {
                let expected = if entry.relative.replace('\\', "/") == "skills/.bundled_manifest" {
                    self.journal.seeded_manifest_hash.as_ref().unwrap_or(expected)
                } else { expected };
                if path_hash(&self.journal.target.join(valid_relative(&entry.relative)?))? != *expected {
                    bail!("copied state failed final validation");
                }
            }
        }
        for entry in &self.journal.trusted_defaults {
            if !entry.directory && path_hash(&self.journal.target.join(valid_relative(&entry.relative)?))? !=
                entry.source_hash.as_deref().context("trusted default digest missing")? {
                bail!("trusted default changed after seeding");
            }
        }
        let marker = self.journal.target.join("youtab-agent-runtime/.youtab-agent-runtime-bootstrap-complete");
        regular_metadata(&marker)?;
        let value: serde_json::Value = serde_json::from_slice(&fs::read(marker)?)?;
        if value.get("pinnedCommit").and_then(|v| v.as_str()) != Some(source_sha) ||
            value.get("setupSha256").and_then(|v| v.as_str()) != Some(setup_sha256) ||
            value.get("releaseSequence").and_then(|v| v.as_u64()).unwrap_or(0) == 0 ||
            path_hash(&self.journal.target.join("youtab-setup.exe"))? != setup_sha256 {
            bail!("fresh product validation marker or Setup identity mismatch");
        }
        // Preserve filesystem timestamps as well as the SQLite/session timestamps.
        // Reverse order restores parent directories after all child writes.
        for entry in self.journal.entries.iter().rev() {
            if !entry.directory && entry.copied_hash.is_none() { continue; }
            let relative = valid_relative(&entry.relative)?;
            restore_data_times(&self.source.root.join(&relative), &self.journal.target.join(relative))?;
        }
        self.journal.phase = "product-validated".into();
        self.save(false)
    }
}
fn restore_data_times(source: &Path, target: &Path) -> Result<()> {
    let source = open_frozen(source)?;
    let metadata = source.metadata()?;
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};
        options.access_mode(0x100).share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let target = options.open(target)?;
    target.set_times(std::fs::FileTimes::new().set_accessed(metadata.accessed()?).set_modified(metadata.modified()?))?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle, SetFileTime};
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(source.as_raw_handle() as _, &mut info) } == 0 ||
            unsafe { SetFileTime(target.as_raw_handle() as _, &info.ftCreationTime, std::ptr::null(), std::ptr::null()) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}
fn atomic_replace(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    { fs::rename(source, target)?; }
    Ok(())
}

fn seed_stage_name(relative: &str) -> String {
    format!(".relocation-seed-{:x}.part", Sha256::digest(relative.as_bytes()))
}

fn snapshot_sqlite(python: &Path, source: &Path, target: &Path) -> Result<()> {
    // SQLite operates on a PRIVATE replica, so WAL recovery and shared-memory
    // writes cannot touch the source home. Source db and all sidecars remain
    // held without Windows write/delete sharing by FrozenSource.
    let replica = target.with_extension("sqlite-source");
    if replica.exists() {
        if !regular_metadata(&replica)?.is_dir() { bail!("snapshot replica collision"); }
        for child in fs::read_dir(&replica)? {
            let child = child?;
            let name = child.file_name().into_string().map_err(|_| anyhow!("replica name refused"))?;
            if !matches!(name.as_str(), "source.db" | "source.db-wal" | "source.db-shm" | "source.db-journal") ||
                !regular_metadata(&child.path())?.is_file() {
                bail!("unknown snapshot replica collision; retained");
            }
        }
        // These are journal-owned target scratch files, never source data.
        for child in fs::read_dir(&replica)? { fs::remove_file(child?.path())?; }
    } else { fs::create_dir(&replica)?; }
    let clone = replica.join("source.db");
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = PathBuf::from(format!("{}{suffix}", source.display()));
        if !path.exists() { continue; }
        let mut input = open_frozen(&path)?;
        let mut output = OpenOptions::new().write(true).create_new(true)
            .open(replica.join(format!("source.db{suffix}")))?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    }
    let mut command = Command::new(python);
    isolate_std_child(&mut command);
    let status = command.args(["-I", "-S", "-B", "-c", SQLITE_BACKUP])
        .arg(&clone).arg(target).current_dir(&replica)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status()?;
    if !status.success() { bail!("isolated SQLite snapshot failed; replica retained"); }
    OpenOptions::new().read(true).write(true).open(target)?.sync_all()?;
    for child in fs::read_dir(&replica)? {
        let child = child?;
        if !regular_metadata(&child.path())?.is_file() { bail!("snapshot replica changed"); }
        fs::remove_file(child.path())?;
    }
    fs::remove_dir(replica)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn python() -> PathBuf {
        std::env::var_os("YOUTAB_RELOCATION_TEST_PYTHON")
            .map(PathBuf::from).expect("set an explicitly qualified synthetic test Python")
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "requires separately reviewed locked fresh private Python provisioning"]
    fn real_fresh_private_interpreter_binds_its_base_and_copies_preserved_state() {
        let target = PathBuf::from(std::env::var_os("YOUTAB_RELOCATION_PRIVATE_QA_HOME")
            .expect("exact newly provisioned disposable private home required"));
        let root = std::env::var_os("YOUTAB_NATIVE_PRIVATE_QA_ROOT").map(PathBuf::from).unwrap().canonicalize().unwrap();
        assert!(target.canonicalize().unwrap().starts_with(&root));
        let source = tempfile::Builder::new().prefix("private-python-source-").tempdir_in(&root).unwrap();
        fs::write(source.path().join(".env"), b"SYNTHETIC_TOKEN=preserved\n").unwrap();
        fs::create_dir_all(source.path().join("skills/custom")).unwrap();
        fs::write(source.path().join("skills/custom/SKILL.md"), b"custom-skill-bytes").unwrap();
        let namespace = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        let base_root = private_python_base(&target, &namespace).unwrap();
        let base = namespace.admit_existing_code_tree(&base_root).unwrap().unwrap();
        let venv = namespace.admit_existing_code_tree(&target.join("youtab-agent-runtime/venv")).unwrap().unwrap();
        base.revalidate().unwrap(); venv.revalidate().unwrap();
        let python = target.join("youtab-agent-runtime/venv/Scripts/python.exe");
        let proof = Command::new(&python).args(["-I", "-S", "-B", "-c", "import json,sys; print(json.dumps({'executable':sys.executable,'base_prefix':sys.base_prefix,'version':list(sys.version_info[:3])}))"])
            .stdin(Stdio::null()).output().unwrap();
        assert!(proof.status.success());
        let proof: serde_json::Value = serde_json::from_slice(&proof.stdout).unwrap();
        assert_eq!(PathBuf::from(proof["executable"].as_str().unwrap()).canonicalize().unwrap(), python.canonicalize().unwrap());
        require_exact_private_python_binding(Path::new(proof["base_prefix"].as_str().unwrap()), &base_root).unwrap();
        assert_eq!(proof["version"], serde_json::json!([3,11,17]));
        let mut relocation = Relocation::begin(source.path(), &target, &namespace).unwrap();
        relocation.copy_data(&python).unwrap();
        assert!(relocation.data_ready());
        assert_eq!(fs::read(target.join(".env")).unwrap(), fs::read(source.path().join(".env")).unwrap());
        assert_eq!(fs::read(target.join("skills/custom/SKILL.md")).unwrap(), b"custom-skill-bytes");
        base.revalidate().unwrap(); venv.revalidate().unwrap();
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "requires separately reviewed locked fresh managed Git provisioning"]
    fn real_fresh_managed_git_ignores_source_shell_environment() {
        let target = PathBuf::from(std::env::var_os("YOUTAB_RELOCATION_PRIVATE_QA_HOME").unwrap());
        let root = PathBuf::from(std::env::var_os("YOUTAB_NATIVE_PRIVATE_QA_ROOT").unwrap()).canonicalize().unwrap();
        assert_eq!(target.canonicalize().unwrap(), root.join("fresh-private-home").canonicalize().unwrap());
        let namespace = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        let git = namespace.admit_existing_code_tree(&target.join("git")).unwrap().unwrap();
        git.revalidate().unwrap();
        let helper = PathBuf::from(std::env::var_os("YOUTAB_RELOCATION_GIT_POISON_HELPER").unwrap());
        let source = PathBuf::from(std::env::var_os("YOUTAB_RELOCATION_QA_SOURCE").unwrap());
        regular_metadata(&helper).unwrap();
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
        let mut command = Command::new(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
        command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(helper)
            .arg("-Fixture").arg(&root).arg("-Source").arg(source).args(["-Mode", "poison"])
            .arg("-PrivateHome").arg(&target).stdin(Stdio::null());
        isolate_std_child(&mut command);
        let output = command.output().unwrap();
        assert!(output.status.success(), "fresh Git poison proof failed: {}", String::from_utf8_lossy(&output.stderr));
        git.revalidate().unwrap();
    }
    #[cfg(windows)]
    fn exact_base_fixture() -> (tempfile::TempDir, PathBuf, crate::update_coordination::PrivateCodeNamespace, PathBuf) {
        let root = crate::update_coordination::relocation_test_fixture();
        let home = root.path().join("home"); fs::create_dir(&home).unwrap();
        let namespace = crate::update_coordination::admit_private_code_namespace(&home).unwrap();
        let lock: serde_json::Value = serde_json::from_str(PRIVATE_PYTHON_LOCK).unwrap();
        let config = home.join("youtab-agent-runtime/config"); fs::create_dir_all(&config).unwrap();
        fs::write(config.join("windows-private-home-prerequisites.json"), PRIVATE_PYTHON_LOCK).unwrap();
        let cache = home.join("bootstrap-cache/private-prerequisites"); fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("python-receipt.json"), serde_json::to_vec(&serde_json::json!({"key":lock["python"]["key"],"sha256":lock["python"]["sha256"]})).unwrap()).unwrap();
        let base = home.join("python").join(lock["python"]["key"].as_str().unwrap());
        fs::create_dir_all(base.join("DLLs")).unwrap(); fs::create_dir_all(base.join("Lib/site-packages/custom")).unwrap();
        for name in ["python.exe", "python311.dll", "DLLs/synthetic.pyd", "Lib/site-packages/custom/package.py"] {
            fs::write(base.join(name), b"synthetic code inventory data; never executed").unwrap();
        }
        (root, home, namespace, base)
    }
    #[cfg(windows)]
    fn exact_base_junction(link: &Path, target: &Path) {
        use std::os::windows::process::CommandExt;
        let plain = |path: &Path| path.to_str().unwrap().strip_prefix("\\\\?\\").unwrap_or(path.to_str().unwrap()).to_owned();
        let link = plain(link); let target = plain(target);
        for text in [&link, &target] { assert!(!text.chars().any(|c| "\"&|<>^%!\r\n".contains(c))); }
        let command = format!("\"mklink /J \"{}\" \"{}\"\"", link, target);
        let output = Command::new(PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\cmd.exe"))
            .args(["/d", "/s", "/c"]).raw_arg(command).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    #[cfg(windows)]
    #[test]
    fn exact_private_base_admits_full_locked_tree_with_unused_minor_junction() {
        let (_root, home, namespace, base) = exact_base_fixture();
        let alias = home.join("python/cpython-3.11-windows-x86_64-none"); exact_base_junction(&alias, &base);
        assert!(namespace.admit_existing_code_tree(&home.join("python")).is_err());
        assert_eq!(private_python_base(&home, &namespace).unwrap(), base);
        let tree = namespace.admit_existing_code_tree(&base).unwrap().unwrap(); tree.revalidate().unwrap();
        assert!(base.join("DLLs/synthetic.pyd").exists() && base.join("Lib/site-packages/custom/package.py").exists());
        assert!(require_exact_private_python_binding(&alias, &base).is_err());
        require_exact_private_python_binding(&base, &base).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn exact_private_base_rejects_changed_lock_wrong_receipt_and_foreign_selection() {
        let (root, home, namespace, base) = exact_base_fixture();
        let receipt = home.join("bootstrap-cache/private-prerequisites/python-receipt.json");
        let bytes = fs::read(&receipt).unwrap(); fs::write(&receipt, br#"{"key":"cpython-3.11.16-windows-x86_64-none","sha256":"wrong"}"#).unwrap();
        assert!(private_python_base(&home, &namespace).is_err()); fs::write(&receipt, bytes).unwrap();
        let path = home.join("youtab-agent-runtime/config/windows-private-home-prerequisites.json");
        let mut lock: serde_json::Value = serde_json::from_str(PRIVATE_PYTHON_LOCK).unwrap();
        lock["python"]["key"] = serde_json::json!("../foreign"); fs::write(&path, serde_json::to_vec(&lock).unwrap()).unwrap();
        assert!(private_python_base(&home, &namespace).is_err()); fs::write(&path, PRIVATE_PYTHON_LOCK).unwrap();
        let foreign = root.path().join("foreign"); fs::create_dir(&foreign).unwrap();
        assert!(require_exact_private_python_binding(&foreign, &base).is_err());
        assert!(base.canonicalize().unwrap().starts_with(home.canonicalize().unwrap()));
        fs::remove_dir_all(&base).unwrap(); exact_base_junction(&base, &foreign);
        assert!(private_python_base(&home, &namespace).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn exact_private_base_rejects_intermediate_parent_and_descendant_junctions() {
        let (root, home, namespace, base) = exact_base_fixture();
        let foreign = root.path().join("foreign"); fs::create_dir(&foreign).unwrap();
        exact_base_junction(&base.join("Lib/foreign"), &foreign);
        assert!(private_python_base(&home, &namespace).is_err()); fs::remove_dir(base.join("Lib/foreign")).unwrap();
        let moved = home.join("retained-python"); fs::rename(home.join("python"), &moved).unwrap();
        exact_base_junction(&home.join("python"), &moved);
        assert!(private_python_base(&home, &namespace).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn exact_private_base_refuses_foreign_and_minor_alias_pyvenv_home_before_execution() {
        let (root, home, namespace, base) = exact_base_fixture();
        let source = root.path().join("source"); fs::create_dir(&source).unwrap();
        fs::write(source.join(".env"), b"custom-state-preserved").unwrap();
        let code = home.join("youtab-agent-runtime/venv"); fs::create_dir_all(code.join("Scripts")).unwrap();
        let python = code.join("Scripts/python.exe"); fs::write(&python, b"not an executable; binding refusal precedes execution").unwrap();
        let foreign = root.path().join("foreign"); fs::create_dir(&foreign).unwrap();
        let alias = home.join("python/cpython-3.11-windows-x86_64-none"); exact_base_junction(&alias, &base);
        let mut relocation = Relocation::begin(&source, &home, &namespace).unwrap();
        for incorrect in [&foreign, &alias] {
            fs::write(code.join("pyvenv.cfg"), format!("home = {}\n", incorrect.display())).unwrap();
            let error = relocation.copy_data(&python).unwrap_err();
            assert!(error.to_string().contains("target interpreter does not bind its exact locked private base"), "wrong refusal gate: {error}");
            assert!(!home.join(".env").exists());
            assert_eq!(fs::read(source.join(".env")).unwrap(), b"custom-state-preserved");
        }
    }

    #[cfg(windows)]
    fn copy_data_spelling_fixture() -> (tempfile::TempDir, PathBuf, crate::update_coordination::PrivateCodeNamespace, PathBuf, PathBuf) {
        let (root, home, namespace, base) = exact_base_fixture();
        let source = root.path().join("source"); fs::create_dir(&source).unwrap();
        fs::write(source.join(".env"), b"synthetic-custom-env-preserved").unwrap();
        fs::create_dir_all(source.join("skills/custom")).unwrap();
        fs::write(source.join("skills/custom/SKILL.md"), b"synthetic-custom-skill-preserved").unwrap();
        let code = home.join("youtab-agent-runtime/venv"); fs::create_dir_all(code.join("Scripts")).unwrap();
        fs::write(code.join("pyvenv.cfg"), format!("home = {}\n", base.display())).unwrap();
        let python = code.join("Scripts/python.exe");
        // No SQLite entries: this synthetic interpreter must never execute.
        fs::write(&python, b"synthetic native-code inventory; never execute").unwrap();
        (root, home, namespace, source, python)
    }
    #[cfg(windows)]
    #[test]
    fn copy_data_interpreter_accepts_equivalent_windows_component_spellings() {
        for spelling in 0..5 {
            let (_root, home, namespace, source, python) = copy_data_spelling_fixture();
            let canonical = python.canonicalize().unwrap();
            let plain = canonical.to_str().unwrap().strip_prefix("\\\\?\\").unwrap().to_owned();
            let observed = match spelling {
                0 => PathBuf::from(&plain),
                1 => canonical,
                2 => PathBuf::from(plain.replace('\\', "/")),
                3 => PathBuf::from(plain.to_uppercase()),
                _ => PathBuf::from(plain.replace("\\Scripts\\", "/Scripts/")),
            };
            let mut relocation = Relocation::begin(&source, &home, &namespace).unwrap();
            assert!(relocation.journal.target.to_str().unwrap().starts_with("\\\\?\\"));
            relocation.copy_data(&observed).unwrap();
            assert!(relocation.data_ready());
            assert_eq!(fs::read(home.join(".env")).unwrap(), b"synthetic-custom-env-preserved");
            assert_eq!(fs::read(home.join("skills/custom/SKILL.md")).unwrap(), b"synthetic-custom-skill-preserved");
            assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-custom-env-preserved");
        }
    }
    #[cfg(windows)]
    #[test]
    fn copy_data_interpreter_refuses_foreign_sibling_prefix_and_junction_aliases_before_effects() {
        for kind in 0..5 {
            let (root, home, namespace, source, python) = copy_data_spelling_fixture();
            let code = python.parent().unwrap().parent().unwrap();
            let observed = match kind {
                0 => { let path = root.path().join("foreign/python.exe"); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(&path,b"foreign-never-execute").unwrap(); path },
                1 => { let path = home.join("youtab-agent-runtime/venv-other/Scripts/python.exe"); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(&path,b"sibling-never-execute").unwrap(); path },
                2 => { let alias = home.join("bin/venv-alias"); fs::create_dir_all(alias.parent().unwrap()).unwrap(); exact_base_junction(&alias,code); assert_eq!(alias.join("Scripts/python.exe").canonicalize().unwrap(),python.canonicalize().unwrap()); alias.join("Scripts/python.exe") },
                3 => { let alias = code.join("Scripts/internal-alias"); exact_base_junction(&alias,python.parent().unwrap()); alias.join("python.exe") },
                _ => { let alias = code.parent().unwrap().join("venv-alias"); exact_base_junction(&alias,code);
                    let plain = code.to_str().unwrap().strip_prefix("\\\\?\\").unwrap_or(code.to_str().unwrap());
                    let escaped = Path::new(plain).join("../venv-alias/Scripts/python.exe");
                    assert_eq!(escaped.canonicalize().unwrap(),python.canonicalize().unwrap()); escaped },
            };
            let mut relocation = Relocation::begin(&source, &home, &namespace).unwrap();
            assert!(relocation.copy_data(&observed).is_err());
            assert!(!home.join(".env").exists());
            assert!(!home.join("skills").exists());
            assert_eq!(fs::read(source.join(".env")).unwrap(),b"synthetic-custom-env-preserved");
        }
    }

    #[cfg(windows)]
    #[test]
    fn selected_code_home_normal_namespace_begin_accepts_normal_and_canonical_target() {
        for canonical_target in [false, true] {
            let (_root, home, old_namespace, source, python) = copy_data_spelling_fixture();
            drop(old_namespace);
            let normal = PathBuf::from(home.to_str().unwrap().strip_prefix("\\\\?\\").unwrap_or(home.to_str().unwrap()));
            let namespace = crate::update_coordination::admit_private_code_namespace(&normal).unwrap();
            assert_eq!(namespace.selected_home().unwrap(), normal);
            let target = if canonical_target { normal.canonicalize().unwrap() } else { normal.clone() };
            let mut relocation = Relocation::begin(&source, &target, &namespace).unwrap();
            assert_eq!(relocation.journal.target, normal.canonicalize().unwrap());
            relocation.copy_data(&python).unwrap();
            assert!(relocation.data_ready());
            assert_eq!(fs::read(home.join(".env")).unwrap(),b"synthetic-custom-env-preserved");
            assert_eq!(fs::read(home.join("skills/custom/SKILL.md")).unwrap(),b"synthetic-custom-skill-preserved");
        }
    }
    #[cfg(windows)]
    #[test]
    fn selected_code_home_normal_namespace_interrupted_resume_recovers_then_copies() {
        for canonical_target in [false, true] {
            let (_root, home, old_namespace, source, python) = copy_data_spelling_fixture();
            drop(old_namespace);
            let normal = PathBuf::from(home.to_str().unwrap().strip_prefix("\\\\?\\").unwrap_or(home.to_str().unwrap()));
            let namespace = crate::update_coordination::admit_private_code_namespace(&normal).unwrap();
            let target = if canonical_target { normal.canonicalize().unwrap() } else { normal.clone() };
            let relocation = Relocation::begin(&source, &target, &namespace).unwrap();
            let canonical = relocation.journal.target.clone(); drop(relocation);
            fs::write(canonical.join(JOURNAL_STAGE),b"{\"partial\":").unwrap();
            let mut resumed = Relocation::resume(&source,&target,&namespace).unwrap();
            assert!(!canonical.join(JOURNAL_STAGE).exists());
            assert!(canonical.join("bootstrap-cache/relocation-recovery").is_dir());
            assert_eq!(resumed.journal.target,canonical);
            resumed.copy_data(&python).unwrap();
            assert!(resumed.data_ready());
            assert_eq!(fs::read(home.join(".env")).unwrap(),b"synthetic-custom-env-preserved");
            assert_eq!(fs::read(source.join(".env")).unwrap(),b"synthetic-custom-env-preserved");
        }
    }

    #[test]
    fn relative_paths_reject_escape_ads_and_absolute_values() {
        for value in ["", "../outside", "C:\\outside", "state.db:stream", "/outside"] {
            assert!(valid_relative(value).is_err(), "{value}");
        }
        assert!(valid_relative("profiles/alice/config.yaml").is_ok());
    }
    #[test]
    fn disjoint_homes_reject_equal_nested_and_case_aliases() {
        for (source, target) in [("C:\\Home", "c:\\home"), ("C:\\Home", "C:\\Home\\new"),
            ("C:\\Home\\old", "C:\\Home")] {
            assert!(disjoint(Path::new(source), Path::new(target)).is_err());
        }
        assert!(disjoint(Path::new("C:\\Home\\old"), Path::new("C:\\Home\\new")).is_ok());
    }
    #[test]
    fn inventory_keeps_profiles_skills_plugins_empty_dirs_and_unknown_data() {
        let root = tempfile::tempdir().unwrap();
        for name in ["profiles/alice", "skills/custom", "desktop-plugins/custom", "empty"] {
            fs::create_dir_all(root.path().join(name)).unwrap();
        }
        fs::write(root.path().join(".env"), b"synthetic-secret").unwrap();
        fs::write(root.path().join("unknown.state"), b"irreplaceable").unwrap();
        fs::write(root.path().join("desktop-plugins/custom/package.json"), b"{}").unwrap();
        fs::create_dir(root.path().join("youtab-agent-runtime")).unwrap();
        fs::write(root.path().join("youtab-agent-runtime/do-not-run.py"), b"raise RuntimeError()").unwrap();
        let frozen = FrozenSource::open(root.path()).unwrap();
        assert!(frozen.entries.iter().any(|e| e.relative == "unknown.state"));
        assert!(frozen.entries.iter().any(|e| e.relative == ".env"));
        assert!(frozen.entries.iter().any(|e| e.relative == "empty" && e.directory));
        assert_eq!(frozen.retained, ["youtab-agent-runtime"]);
        frozen.revalidate().unwrap();
    }
    #[test]
    fn generated_gateway_code_is_retained_at_source_for_fresh_target_rendering() {
        let root = tempfile::tempdir().unwrap();
        for path in ["gateway-service", "profiles/coder/gateway-service"] {
            fs::create_dir_all(root.path().join(path)).unwrap();
            fs::write(root.path().join(path).join("Youtab_Gateway.vbs"), b"source-code-must-not-run").unwrap();
        }
        fs::write(root.path().join("profiles/coder/config.yaml"), b"custom: preserved").unwrap();
        let source = FrozenSource::open(root.path()).unwrap();
        assert!(!source.entries.iter().any(|entry| entry.relative.contains("gateway-service")));
        assert!(source.entries.iter().any(|entry| entry.relative.replace('\\', "/") == "profiles/coder/config.yaml"));
        assert_eq!(source.retained.len(), 2);
        source.revalidate().unwrap();
    }
    #[test]
    fn copied_data_files_keep_source_times() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::write(&source, b"synthetic-state").unwrap();
        fs::write(&target, b"synthetic-state").unwrap();
        let historical = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1500000000);
        OpenOptions::new().write(true).open(&source).unwrap().set_times(std::fs::FileTimes::new().set_modified(historical)).unwrap();
        restore_data_times(&source, &target).unwrap();
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), historical);
        assert_eq!(fs::read(&source).unwrap(), fs::read(&target).unwrap());
    }
    #[test]
    fn hardlink_refusal_leaves_source_untouched() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("secret"), b"synthetic").unwrap();
        fs::hard_link(root.path().join("secret"), root.path().join("alias")).unwrap();
        assert!(FrozenSource::open(root.path()).is_err());
        assert_eq!(fs::read(root.path().join("secret")).unwrap(), b"synthetic");
    }
    #[test]
    fn source_addition_is_detected() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("config.yaml"), b"synthetic").unwrap();
        let frozen = FrozenSource::open(root.path()).unwrap();
        fs::write(root.path().join("new.state"), b"new").unwrap();
        assert!(frozen.revalidate().is_err());
    }
    #[cfg(windows)]
    #[test]
    fn live_writer_refused_and_retained_read_handles_block_writes() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("state");
        fs::write(&file, b"synthetic").unwrap();
        let writer = OpenOptions::new().write(true).open(&file).unwrap();
        assert!(FrozenSource::open(root.path()).is_err());
        drop(writer);
        let frozen = FrozenSource::open(root.path()).unwrap();
        assert!(OpenOptions::new().write(true).open(&file).is_err());
        drop(frozen);
        assert!(OpenOptions::new().write(true).open(file).is_ok());
    }
    #[test]
    fn genuine_sqlite_detected_by_header_not_suffix() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("arbitrary.db"), b"not a database").unwrap();
        let status = Command::new(python()).args(["-I", "-S", "-B", "-c",
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table messages(content)'); c.commit(); c.close()"])
            .arg(root.path().join("history.storage")).status().unwrap();
        assert!(status.success());
        let frozen = FrozenSource::open(root.path()).unwrap();
        assert!(!frozen.entries.iter().find(|e| e.relative == "arbitrary.db").unwrap().sqlite);
        assert!(frozen.entries.iter().find(|e| e.relative == "history.storage").unwrap().sqlite);
    }
    #[test]
    fn sqlite_replica_preserves_committed_wal_without_source_writes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        // Copy a live WAL database into synthetic source, then close the ORIGINAL
        // writer. Source retains committed WAL pages that are absent from main DB.
        let status = Command::new(python()).args(["-I", "-S", "-B", "-c", r#"
import pathlib, shutil, sqlite3, sys
root=pathlib.Path(sys.argv[1]); old=root/'old'; live=root/'live.db'
c=sqlite3.connect(str(live)); c.execute('pragma journal_mode=wal')
c.execute('pragma wal_autocheckpoint=0')
c.execute('create table messages(content)')
c.execute("insert into messages values('old chat')"); c.commit()
for suffix in ('', '-wal', '-shm'):
    p=pathlib.Path(str(live)+suffix)
    if p.exists(): shutil.copyfile(p, old/('state.db'+suffix))
c.close()
"#]).arg(root.path()).status().unwrap();
        assert!(status.success());
        let before = FrozenSource::open(&source).unwrap();
        assert!(source.join("state.db-wal").is_file());
        let output = target.join(".relocation-part-0");
        snapshot_sqlite(&python(), &source.join("state.db"), &output).unwrap();
        before.revalidate().unwrap();
        let status = Command::new(python()).args(["-I", "-S", "-B", "-c",
            "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); assert c.execute('select content from messages').fetchall()==[('old chat',)]; assert c.execute('pragma quick_check').fetchall()==[('ok',)]"])
            .arg(&output).status().unwrap();
        assert!(status.success());
        assert!(!output.with_extension("sqlite-source").exists());
    }
    #[cfg(windows)]
    #[test]
    fn real_target_namespace_journal_recovery_and_collisions() {
        #[cfg(windows)]
        let root = crate::update_coordination::relocation_test_fixture();
        #[cfg(not(windows))]
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::create_dir(source.join("profiles")).unwrap();
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        fs::write(source.join("profiles/agent.json"), b"synthetic-agent").unwrap();
        let namespace = crate::update_coordination::admit_private_code_namespace(&target)
            .expect("synthetic target must pass the REAL native admission; no ACL changes or waiver");
        let mut relocation = Relocation::begin(&source, &target, &namespace).unwrap();
        relocation.copy_data_inner(&python()).unwrap();
        assert_eq!(fs::read(target.join(".env")).unwrap(), b"synthetic-secret");
        drop(relocation);
        let mut resumed = Relocation::resume(&source, &target, &namespace).unwrap();
        resumed.copy_data_inner(&python()).unwrap();
        assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
        assert!(Relocation::begin(&source, &target, &namespace).is_err());
        fs::write(target.join("unexpected.state"), b"external").unwrap();
        assert!(Relocation::resume(&source, &target, &namespace).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn selected_location_preserves_fresh_marker_and_state() {
        let root = crate::update_coordination::relocation_test_fixture();
        let profile = root.path().join("profile");
        let parent = root.path().join("selected");
        fs::create_dir(&profile).unwrap();
        fs::create_dir(&parent).unwrap();
        let source = profile.join("Youtab");
        crate::paths::prepare_fresh_customer_home(&crate::paths::CustomerHome::Fresh(source.clone())).unwrap();
        fs::create_dir(source.join("logs")).unwrap();
        fs::write(source.join("logs/bootstrap-installer.log"), b"synthetic setup log").unwrap();
        fs::write(source.join("chat.txt"), b"synthetic chat").unwrap();
        let target = selected_location_target(&source, &parent).unwrap();
        let intent = StartupIntent { source: source.clone(), target: target.clone() };
        let namespace = intent.prepare_before_logging().unwrap();
        let mut relocation = Relocation::begin(&source, &target, &namespace).unwrap();
        relocation.copy_data_inner(&python()).unwrap();
        assert_eq!(fs::read(source.join("chat.txt")).unwrap(), b"synthetic chat");
        assert_eq!(fs::read(target.join("chat.txt")).unwrap(), b"synthetic chat");
        assert_eq!(fs::read(target.join(".youtab-fresh-home-v1")).unwrap(), b"youtab-fresh-home-v1\n");
        assert!(selected_location_target(&source, &source.join("nested")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn selected_location_rejects_unrelated_state_and_first_run_collision() {
        let root = crate::update_coordination::relocation_test_fixture();
        let profile = root.path().join("profile");
        let parent = root.path().join("selected");
        fs::create_dir(&profile).unwrap();
        fs::create_dir(&parent).unwrap();
        let source = profile.join("Youtab");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("unrelated.txt"), b"unrelated").unwrap();
        assert!(crate::paths::prepare_fresh_customer_home(&crate::paths::CustomerHome::Fresh(source.clone())).is_err());
        let lower = root.path().join("youtab");
        fs::create_dir(&lower).unwrap();
        assert!(crate::paths::same_windows_path(&lower, &selected_location_target(&lower, root.path()).unwrap()));
        let target = parent.join("Youtab");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("other-user.txt"), b"unrelated").unwrap();
        assert!(selected_location_target(&source, &parent).is_err());
        assert_eq!(fs::read(target.join("other-user.txt")).unwrap(), b"unrelated");
    }

    #[cfg(windows)]
    #[test]
    fn crashed_child_before_journal_can_retry_only_same_handoff() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let parent = root.path().join("selected");
        fs::create_dir(&source).unwrap(); fs::create_dir(&parent).unwrap();
        fs::write(source.join("chat.txt"), b"preserved chat").unwrap();
        let target = selected_location_target(&source, &parent).unwrap();
        let intent = StartupIntent { source: source.clone(), target: target.clone() };
        drop(intent.prepare_before_logging().unwrap());
        let log = log_directory(&target, true);
        fs::create_dir_all(&log).unwrap();
        fs::write(log.join("bootstrap-installer.log"), b"failed child diagnostic").unwrap();
        // The child exits before any journal exists; the next picker call must
        // accept only its exact atomic handoff identity and known log files.
        assert!(!target.join(JOURNAL).exists());
        assert_eq!(selected_location_target(&source, &parent).unwrap(), target);
        let other = root.path().join("different-source");
        fs::create_dir(&other).unwrap();
        assert!(selected_location_target(&other, &parent).is_err());
        let guard = intent.prepare_before_logging().unwrap();
        let mut resumed = Relocation::begin(&source, &target, &guard).unwrap();
        resumed.copy_data_inner(&python()).unwrap();
        assert_eq!(fs::read(target.join("chat.txt")).unwrap(), b"preserved chat");
        assert_eq!(fs::read(source.join("chat.txt")).unwrap(), b"preserved chat");
    }

    #[cfg(windows)]
    #[test]
    fn pre_journal_handoff_refuses_unknown_file_without_deleting_it() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let parent = root.path().join("selected");
        fs::create_dir(&source).unwrap(); fs::create_dir(&parent).unwrap();
        fs::write(source.join("chat.txt"), b"source unchanged").unwrap();
        let target = selected_location_target(&source, &parent).unwrap();
        let intent = StartupIntent { source: source.clone(), target: target.clone() };
        drop(intent.prepare_before_logging().unwrap());
        fs::write(target.join("unknown-user-data.txt"), b"do not delete").unwrap();
        assert!(selected_location_target(&source, &parent).is_err());
        assert!(intent.prepare_before_logging().is_err());
        assert_eq!(fs::read(target.join("unknown-user-data.txt")).unwrap(), b"do not delete");
        assert_eq!(fs::read(source.join("chat.txt")).unwrap(), b"source unchanged");
    }

    #[cfg(windows)]
    #[test]
    fn complete_initial_stage_after_handoff_recovers_exact_source() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let parent = root.path().join("selected");
        fs::create_dir(&source).unwrap(); fs::create_dir(&parent).unwrap();
        fs::write(source.join("chat.txt"), b"retained chat").unwrap();
        let target = selected_location_target(&source, &parent).unwrap();
        let intent = StartupIntent { source: source.clone(), target: target.clone() };
        let guard = intent.prepare_before_logging().unwrap();
        let log = log_directory(&target, true);
        fs::create_dir_all(&log).unwrap();
        fs::write(log.join("bootstrap-installer.log"), b"pre-journal diagnostic").unwrap();
        let frozen = FrozenSource::open(&source).unwrap();
        let staged = Journal { schema: 1, source: frozen.root.clone(), target: target.canonicalize().unwrap(),
            phase: "copying".into(), entries: frozen.entries.clone(),
            retained_product_roots: frozen.retained.clone(), publication: None,
            trusted_defaults: Vec::new(), seeded_manifest_hash: None, seed_intent: None };
        fs::write(target.join(JOURNAL_STAGE), serde_json::to_vec(&staged).unwrap()).unwrap();
        assert_eq!(selected_location_target(&source, &parent).unwrap(), target);
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        assert!(selected_location_target(&other, &parent).is_err());
        let mut resumed = Relocation::resume(&source, &target, &guard).unwrap();
        resumed.copy_data_inner(&python()).unwrap();
        assert_eq!(fs::read(target.join("chat.txt")).unwrap(), b"retained chat");
        assert_eq!(fs::read(source.join("chat.txt")).unwrap(), b"retained chat");
    }

    #[cfg(windows)]
    #[test]
    fn relocation_intent_and_logging_cannot_target_source_home() {
        let root = crate::update_coordination::relocation_test_fixture();
        let old = root.path().join("old");
        let new = root.path().join("new");
        fs::create_dir(&old).unwrap();
        fs::write(old.join(".env"), b"synthetic-secret").unwrap();
        let args = vec!["--relocate-home-v1".into(), "--source-home".into(), old.display().to_string(),
            "--target-home".into(), new.display().to_string()];
        let intent = StartupIntent::parse(args).unwrap().unwrap();
        let guard = intent.prepare_before_logging().unwrap();
        let log = log_directory(&new, true);
        fs::create_dir_all(&log).unwrap();
        fs::write(log.join("bootstrap-installer.log"), b"synthetic-log").unwrap();
        assert!(!old.join("logs").exists());
        assert_eq!(fs::read(old.join(".env")).unwrap(), b"synthetic-secret");
        assert_eq!(log_directory(&old, false), old.join("logs"));
        guard.revalidate().unwrap();
        assert!(StartupIntent { source: old.clone(), target: old.clone() }.prepare_before_logging().is_err());
        assert!(StartupIntent { source: old.clone(), target: old.join("nested") }.prepare_before_logging().is_err());
        assert!(!old.join("nested").exists());
    }
    #[test]
    fn relocation_requires_explicit_non_update_absolute_intent() {
        for args in [
            vec!["--source-home", "C:\\old"],
            vec!["--relocate-home-v1", "--source-home", "relative", "--target-home", "C:\\new"],
            vec!["--relocate-home-v1", "--source-home", "C:\\old", "--target-home", "C:\\new", "--update"],
            vec!["--relocate-home-v1", "--source-home", "C:\\old", "--source-home", "C:\\other", "--target-home", "C:\\new"],
        ] {
            assert!(StartupIntent::parse(args.into_iter().map(String::from)).is_err());
        }
        assert!(StartupIntent::parse(vec!["--update".into()]).unwrap().is_none());
    }

    #[test]
    fn hot_rollback_journal_recovers_private_replica_and_preserves_source() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        let status = Command::new(python()).args(["-I", "-S", "-B", "-c", r#"
import os, pathlib, sqlite3, sys
p=pathlib.Path(sys.argv[1])/'state.db'
c=sqlite3.connect(str(p)); c.execute('pragma journal_mode=delete')
c.execute('create table messages(id integer primary key, content text)')
c.executemany('insert into messages(content) values (?)', [('old chat '+('x'*1024),)]*2000)
c.commit(); c.execute('pragma cache_size=1')
c.execute("update messages set content='uncommitted '+content")
os._exit(0)
"#]).arg(&source).status().unwrap();
        assert!(status.success());
        assert!(source.join("state.db-journal").is_file());
        let original = FrozenSource::open(&source).unwrap();
        let output = target.join(".relocation-part-0");
        snapshot_sqlite(&python(), &source.join("state.db"), &output).unwrap();
        original.revalidate().unwrap();
        let status = Command::new(python()).args(["-I", "-S", "-B", "-c",
            "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute('select count(*) from messages').fetchone()==(2000,); assert c.execute(\"select count(*) from messages where content like 'uncommitted %'\").fetchone()==(0,); assert c.execute('pragma quick_check').fetchall()==[('ok',)]"])
            .arg(&output).status().unwrap();
        assert!(status.success());
    }


    #[cfg(windows)]
    #[test]
    fn mismatched_namespace_cannot_read_or_write_another_target_journal() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let a = root.path().join("safe-a");
        let b = root.path().join("unadmitted-b");
        for path in [&source, &a, &b] { fs::create_dir(path).unwrap(); }
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        fs::write(b.join(JOURNAL), b"malformed-unrelated-journal").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&a).unwrap();
        let before = fs::read(b.join(JOURNAL)).unwrap();
        let error = Relocation::begin(&source, &b, &guard).err().unwrap().to_string();
        assert!(error.contains("code-scope-unverifiable"), "{error}");
        let error = Relocation::resume(&source, &b, &guard).err().unwrap().to_string();
        assert!(error.contains("code-scope-unverifiable"), "{error}");
        assert_eq!(fs::read(b.join(JOURNAL)).unwrap(), before);
        assert!(!b.join(JOURNAL_STAGE).exists());
        assert!(!b.join("bootstrap-cache").exists());
        assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
    }
    #[cfg(windows)]
    #[test]
    fn torn_initial_atomic_journal_save_recovers_without_source_changes() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        fs::write(target.join(JOURNAL_STAGE), b"{\"schema\":").unwrap();
        assert!(!target.join(JOURNAL).exists());
        let mut recovered = Relocation::resume(&source, &target, &guard).unwrap();
        recovered.copy_data_inner(&python()).unwrap();
        assert!(!target.join(JOURNAL_STAGE).exists());
        assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
        assert_eq!(fs::read(target.join(".env")).unwrap(), b"synthetic-secret");
        let saved = fs::read_dir(target.join("bootstrap-cache/relocation-recovery")).unwrap()
            .collect::<std::io::Result<Vec<_>>>().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(fs::read(saved[0].path()).unwrap(), b"{\"schema\":");
    }
    #[cfg(windows)]
    #[test]
    fn interrupted_later_save_uses_live_journal_and_replays_owned_data_rename() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        let prior = Relocation::begin(&source, &target, &guard).unwrap();
        drop(prior);
        let live = fs::read(target.join(JOURNAL)).unwrap();
        fs::write(target.join(".env"), b"synthetic-secret").unwrap();
        fs::write(target.join(JOURNAL_STAGE), b"{\"partial\":").unwrap();
        let mut recovered = Relocation::resume(&source, &target, &guard).unwrap();
        assert_eq!(fs::read(target.join(JOURNAL)).unwrap(), live);
        recovered.copy_data_inner(&python()).unwrap();
        assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
        assert_eq!(fs::read(target.join(".env")).unwrap(), b"synthetic-secret");
        assert!(!target.join(JOURNAL_STAGE).exists());
        drop(recovered);
        let resumed = Relocation::resume(&source, &target, &guard).unwrap();
        assert!(resumed.data_ready());
    }


    #[cfg(windows)]
    #[test]
    fn first_save_recovery_refuses_a_complete_different_intent_and_existing_state() {
        let root = crate::update_coordination::relocation_test_fixture();
        let first = root.path().join("old-a");
        let other = root.path().join("old-b");
        let target = root.path().join("new");
        for path in [&first, &other, &target] { fs::create_dir(path).unwrap(); }
        fs::write(first.join(".env"), b"first").unwrap();
        fs::write(other.join(".env"), b"other").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        let original = Relocation::begin(&first, &target, &guard).unwrap();
        drop(original);
        fs::rename(target.join(JOURNAL), target.join(JOURNAL_STAGE)).unwrap();
        let before = fs::read(target.join(JOURNAL_STAGE)).unwrap();
        assert!(Relocation::resume(&other, &target, &guard).is_err());
        assert_eq!(fs::read(target.join(JOURNAL_STAGE)).unwrap(), before);
        assert!(!target.join("bootstrap-cache").exists());
        fs::write(target.join(JOURNAL_STAGE), b"{").unwrap();
        fs::write(target.join("unrelated.state"), b"keep").unwrap();
        assert!(Relocation::resume(&first, &target, &guard).is_err());
        assert_eq!(fs::read(target.join("unrelated.state")).unwrap(), b"keep");
        assert_eq!(fs::read(first.join(".env")).unwrap(), b"first");
    }
    #[cfg(windows)]
    #[test]
    fn interrupted_complete_later_stage_is_not_authority_over_the_live_journal() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        let original = Relocation::begin(&source, &target, &guard).unwrap();
        let mut next: Journal = serde_json::from_slice(&fs::read(target.join(JOURNAL)).unwrap()).unwrap();
        next.phase = "product-validated".into();
        fs::write(target.join(JOURNAL_STAGE), serde_json::to_vec(&next).unwrap()).unwrap();
        drop(original);
        let resumed = Relocation::resume(&source, &target, &guard).unwrap();
        assert!(!resumed.data_ready());
        assert!(!target.join(JOURNAL_STAGE).exists());
    }


    #[cfg(windows)]
    #[test]
    fn valid_active_journal_hardlinked_outside_target_is_refused_without_mutation() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        drop(Relocation::begin(&source, &target, &guard).unwrap());
        let outside = root.path().join("outside-journal");
        fs::rename(target.join(JOURNAL), &outside).unwrap();
        fs::hard_link(&outside, target.join(JOURNAL)).unwrap();
        let before = fs::read(&outside).unwrap();
        assert!(Relocation::resume(&source, &target, &guard).is_err());
        assert_eq!(fs::read(&outside).unwrap(), before);
        assert!(!target.join("bootstrap-cache").exists());
        assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
    }
    #[cfg(windows)]
    #[test]
    fn recovery_refuses_linked_stage_or_oversized_active_and_stage_journals() {
        for case in ["linked-stage", "oversized-live", "oversized-stage"] {
            let root = crate::update_coordination::relocation_test_fixture();
            let source = root.path().join("old");
            let target = root.path().join("new");
            fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
            fs::write(source.join(".env"), b"synthetic-secret").unwrap();
            let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
            drop(Relocation::begin(&source, &target, &guard).unwrap());
            if case == "linked-stage" {
                let outside = root.path().join("outside-stage");
                fs::write(&outside, b"{\"schema\":").unwrap();
                fs::hard_link(&outside, target.join(JOURNAL_STAGE)).unwrap();
            } else {
                let path = target.join(if case == "oversized-live" { JOURNAL } else { JOURNAL_STAGE });
                let file = OpenOptions::new().write(true).create(true).truncate(true).open(path).unwrap();
                file.set_len(16777217).unwrap();
            }
            assert!(Relocation::resume(&source, &target, &guard).is_err(), "{case}");
            assert!(!target.join("bootstrap-cache").exists(), "{case}");
            assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
        }
    }
    #[cfg(windows)]
    #[test]
    fn recovery_cache_or_nested_junction_cannot_write_outside_target() {
        for nested in [false, true] {
            let root = crate::update_coordination::relocation_test_fixture();
            let source = root.path().join("old");
            let target = root.path().join("new");
            let outside = root.path().join("outside");
            for path in [&source, &target, &outside] { fs::create_dir(path).unwrap(); }
            fs::write(source.join(".env"), b"synthetic-secret").unwrap();
            fs::write(outside.join("keep"), b"outside-unchanged").unwrap();
            let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
            drop(Relocation::begin(&source, &target, &guard).unwrap());
            fs::write(target.join(JOURNAL_STAGE), b"{\"schema\":").unwrap();
            let cache = target.join("bootstrap-cache");
            let junction = if nested { fs::create_dir(&cache).unwrap(); cache.join("relocation-recovery") } else { cache };
            assert!(junction.starts_with(root.path()));
            assert!(outside.starts_with(root.path()));
            let status = Command::new("cmd.exe").args(["/C", "mklink", "/J"])
                .arg(&junction).arg(&outside).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
            assert!(status.success(), "synthetic junction creation must really succeed");
            let before = fs::read(target.join(JOURNAL)).unwrap();
            assert!(Relocation::resume(&source, &target, &guard).is_err());
            assert_eq!(fs::read(target.join(JOURNAL)).unwrap(), before);
            assert_eq!(fs::read(outside.join("keep")).unwrap(), b"outside-unchanged");
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
            assert_eq!(fs::read(source.join(".env")).unwrap(), b"synthetic-secret");
            assert!(target.join(JOURNAL_STAGE).exists());
        }
    }



    #[cfg(windows)]
    #[test]
    fn trusted_missing_defaults_are_journaled_while_custom_skill_and_config_stay_exact() {
        let root = crate::update_coordination::relocation_test_fixture();
        let source = root.path().join("old");
        let target = root.path().join("new");
        fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
        fs::create_dir_all(source.join("skills/custom")).unwrap();
        fs::write(source.join(".env"), b"synthetic-secret").unwrap();
        fs::write(source.join("config.yaml"), b"user-settings").unwrap();
        fs::write(source.join("skills/custom/SKILL.md"), b"custom-skill").unwrap();
        let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
        let mut data = Relocation::begin(&source, &target, &guard).unwrap();
        data.copy_data_inner(&python()).unwrap();
        let runtime = target.join("youtab-agent-runtime");
        fs::create_dir_all(runtime.join("skills/new-default")).unwrap();
        fs::write(runtime.join("skills/new-default/SKILL.md"), b"trusted-default").unwrap();
        let plan = SeedIntent { entries: vec![
            Entry { relative: "cron".into(), directory: true, source_hash: None, sqlite: false, copied_hash: None },
            Entry { relative: "skills/new-default".replace('/', "\\"), directory: true, source_hash: None, sqlite: false, copied_hash: None },
            Entry { relative: "skills/new-default/SKILL.md".replace('/', "\\"), directory: false, source_hash: Some(path_hash(&runtime.join("skills/new-default/SKILL.md")).unwrap()), sqlite: false, copied_hash: None },
            Entry { relative: "skills/.bundled_manifest".replace('/', "\\"), directory: false, source_hash: Some(format!("{:x}", Sha256::digest(b"new-default:origin\n"))), sqlite: false, copied_hash: None },
        ], files: BTreeMap::from([
            ("skills/new-default/SKILL.md".replace('/', "\\"), SeedFile { source: Some("skills/new-default/SKILL.md".replace('/', "\\")), content: None }),
            ("skills/.bundled_manifest".replace('/', "\\"), SeedFile { source: None, content: Some("new-default:origin\n".into()) }),
        ]) };
        data.record_seed_intent(plan, &runtime).unwrap();
        fs::create_dir_all(target.join("skills/new-default")).unwrap();
        fs::write(target.join("skills/new-default/SKILL.md"), b"trusted-default").unwrap();
        // Interruption after the first planned write resumes without unknown state.
        drop(data);
        let mut data = Relocation::resume(&source, &target, &guard).unwrap();
        fs::write(target.join("skills/.bundled_manifest"), b"new-default:origin\n").unwrap();
        fs::create_dir(target.join("cron")).unwrap();
        data.record_seeded_defaults(&runtime).unwrap();
        assert_eq!(fs::read(target.join(".env")).unwrap(), b"synthetic-secret");
        assert_eq!(fs::read(target.join("config.yaml")).unwrap(), b"user-settings");
        assert_eq!(fs::read(target.join("skills/custom/SKILL.md")).unwrap(), b"custom-skill");
        assert!(data.journal.trusted_defaults.iter().any(|e| e.relative.replace('\\', "/") == "skills/new-default/SKILL.md"));
        drop(data);
        let resumed = Relocation::resume(&source, &target, &guard).unwrap();
        resumed.verify_target_inventory().unwrap();
        assert_eq!(fs::read(source.join("skills/custom/SKILL.md")).unwrap(), b"custom-skill");
    }
    #[cfg(windows)]
    #[test]
    fn default_seeding_refuses_changed_custom_content_and_untrusted_new_skill_bytes() {
        for changed_custom in [true, false] {
            let root = crate::update_coordination::relocation_test_fixture();
            let source = root.path().join("old");
            let target = root.path().join("new");
            fs::create_dir(&source).unwrap(); fs::create_dir(&target).unwrap();
            fs::create_dir_all(source.join("skills/custom")).unwrap();
            fs::write(source.join("skills/custom/SKILL.md"), b"user-custom").unwrap();
            let guard = crate::update_coordination::admit_private_code_namespace(&target).unwrap();
            let mut data = Relocation::begin(&source, &target, &guard).unwrap();
            data.copy_data_inner(&python()).unwrap();
            let runtime = target.join("youtab-agent-runtime");
            fs::create_dir_all(runtime.join("skills/new-default")).unwrap();
            fs::write(runtime.join("skills/new-default/SKILL.md"), b"trusted-default").unwrap();
            let relative = "skills/new-default/SKILL.md".replace('/', "\\");
            let plan = SeedIntent { entries: vec![
                Entry { relative: "skills/new-default".replace('/', "\\"), directory: true, source_hash: None, sqlite: false, copied_hash: None },
                Entry { relative: relative.clone(), directory: false, source_hash: Some(path_hash(&runtime.join("skills/new-default/SKILL.md")).unwrap()), sqlite: false, copied_hash: None },
            ], files: BTreeMap::from([(relative.clone(), SeedFile { source: Some(relative), content: None })]) };
            data.record_seed_intent(plan, &runtime).unwrap();
            if changed_custom {
                fs::write(target.join("skills/custom/SKILL.md"), b"changed").unwrap();
            } else {
                fs::create_dir_all(target.join("skills/new-default")).unwrap();
                fs::write(target.join("skills/new-default/SKILL.md"), b"not-package-bytes").unwrap();
            }
            assert!(data.record_seeded_defaults(&runtime).is_err());
            assert_eq!(fs::read(source.join("skills/custom/SKILL.md")).unwrap(), b"user-custom");
        }
    }


    #[cfg(windows)]
    #[test]
    fn relocation_python_children_ignore_source_and_user_site_poison() {
        let root = crate::update_coordination::relocation_test_fixture();
        let poison = root.path().join("old-source-code");
        fs::create_dir(&poison).unwrap();
        let canary = root.path().join("source-code-executed");
        let payload = format!("from pathlib import Path; Path({:?}).write_text('executed'); raise RuntimeError('source poison')", canary.to_string_lossy());
        fs::write(poison.join("sitecustomize.py"), &payload).unwrap();
        fs::write(poison.join("usercustomize.py"), &payload).unwrap();
        fs::write(poison.join("relocation_source_poison.py"), &payload).unwrap();
        let names = ["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP", "VIRTUAL_ENV"];
        let previous: Vec<_> = names.iter().map(|name| std::env::var_os(name)).collect();
        for name in names { std::env::set_var(name, &poison); }
        let mut command = Command::new(python());
        command.args(["-I", "-S", "-B", "-c", "import importlib.util,os; assert not any(k.upper().startswith('PYTHON') or k=='VIRTUAL_ENV' for k in os.environ); assert importlib.util.find_spec('relocation_source_poison') is None"])
            .current_dir(&poison);
        isolate_std_child(&mut command);
        let output = command.output();
        for (name, value) in names.into_iter().zip(previous) {
            match value { Some(value) => std::env::set_var(name, value), None => std::env::remove_var(name) }
        }
        assert!(output.unwrap().status.success());
        assert!(!canary.exists());
    }

}
