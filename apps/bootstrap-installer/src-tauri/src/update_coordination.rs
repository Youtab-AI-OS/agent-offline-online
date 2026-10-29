//! Bounded headless coordination in the common Setup. The caller owns the
//! process timeout; this module never starts Tauri, logging, a shell or a child.
use std::{ffi::OsString, path::PathBuf};

const FLAG: &str = "--update-coordination-v1";
pub const UPDATE_COORDINATION_PE_MARKER: &str = "youtab.update-coordination";
/// A retained, versioned capability identifier for immutable artifact validation.
/// It is not proof of runtime behavior or trust in a mutable installation.
pub const UPDATE_COORDINATION_PE_VERSION: &str = "youtab.update-coordination/version1";
pub const SETUP_HANDOFF_PE_VERSION: &str = "youtab.setup-handoff/version2";

/// Keep directory identities and their no-delete-share handles alive throughout
/// Setup promotion/build. Admission never changes permissions on a legacy home.
pub struct PrivateCodeNamespace {
    #[cfg(windows)]
    ids: native::Identities,
    #[cfg(windows)]
    namespace: native::Namespace,
}

pub fn admit_private_code_namespace(
    path: &std::path::Path,
) -> Result<PrivateCodeNamespace, &'static str> {
    #[cfg(windows)]
    {
        let ids = native::identities()?;
        let namespace = native::Namespace::open_private(path, &ids)?;
        namespace.revalidate(&ids)?;
        Ok(PrivateCodeNamespace { ids, namespace })
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(PrivateCodeNamespace {})
    }
}

pub struct PrivateCodeTree {
    #[cfg(windows)]
    tree: native::CodeTree,
}

impl PrivateCodeTree {
    pub fn revalidate(&self) -> Result<(), &'static str> {
        #[cfg(windows)]
        {
            self.tree.revalidate()
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
}

impl PrivateCodeNamespace {
    /// Read the original path spelling owned by this retained namespace.
    /// Code admission's exact selected-prefix contract is deliberately unchanged.
    pub(crate) fn selected_home(&self) -> Result<&std::path::Path, &'static str> {
        #[cfg(windows)]
        { self.namespace.revalidate(&self.ids)?; Ok(self.namespace.selected_home()) }
        #[cfg(not(windows))]
        { Err("namespace-unverifiable") }
    }

    /// Bind an already retained namespace to the exact selected native home.
    /// This performs no ACL repair and is required before relocation journal IO.
    pub fn require_home(&self, selected: &std::path::Path) -> Result<(), &'static str> {
        #[cfg(windows)]
        { self.namespace.require_home(selected, &self.ids) }
        #[cfg(not(windows))]
        { let _ = selected; Err("namespace-unverifiable") }
    }
    /// Check only a caller-selected code subtree within the admitted home.
    /// Missing paths are normal before creation; unsafe existing objects close.
    pub fn admit_existing_code_tree(
        &self,
        path: &std::path::Path,
    ) -> Result<Option<PrivateCodeTree>, &'static str> {
        #[cfg(windows)]
        {
            native::open_code_tree(&self.namespace, &self.ids, path)
                .map(|tree| tree.map(|tree| PrivateCodeTree { tree }))
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Ok(None)
        }
    }

    pub fn revalidate(&self) -> Result<(), &'static str> {
        #[cfg(windows)]
        {
            self.namespace.revalidate(&self.ids)
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }
}

#[derive(serde::Serialize)]
struct Outcome {
    protocol: &'static str,
    version: u8,
    status: &'static str,
    reason: &'static str,
}

fn outcome(status: &'static str, reason: &'static str) -> Outcome {
    // black_box keeps the exact version marker in the real executable even
    // under LTO; the JSON protocol contract remains unchanged.
    let _ = std::hint::black_box(UPDATE_COORDINATION_PE_VERSION);
    Outcome {
        protocol: UPDATE_COORDINATION_PE_MARKER,
        version: 1,
        status,
        reason,
    }
}

enum Request {
    Capability,
    Inspect(PathBuf),
    Publish {
        home: PathBuf,
        pid: u32,
        created_at: u64,
        instance: String,
    },
}

fn positive_integer(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok().filter(|value| *value > 0)
}

fn valid_instance(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

fn parse(args: &[OsString]) -> Option<Request> {
    let text = args
        .iter()
        .map(|value| value.to_str())
        .collect::<Option<Vec<_>>>()?;
    match text.as_slice() {
        [flag, "capability"] if *flag == FLAG => Some(Request::Capability),
        [flag, "inspect", "--home", home] if *flag == FLAG && PathBuf::from(home).is_absolute() => {
            Some(Request::Inspect(PathBuf::from(home)))
        }
        [flag, "publish", "--home", home, "--pid", pid, "--created-at", created_at, "--instance", instance]
            if *flag == FLAG && PathBuf::from(home).is_absolute() && valid_instance(instance) =>
        {
            Some(Request::Publish {
                home: PathBuf::from(home),
                pid: u32::try_from(positive_integer(pid)?).ok()?,
                created_at: positive_integer(created_at)?,
                instance: instance.to_string(),
            })
        }
        _ => None,
    }
}

/// Intercept the reserved family even when malformed. Unknown options in this
/// family must not accidentally open the graphical installer.
pub fn run_headless_if_requested() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.iter().any(|arg| arg.to_str().is_some_and(|text| text.starts_with("--setup-handoff-v2"))) {
        return Some(handoff_v2::run_broker(&args));
    }
    if !args.iter().any(|arg| {
        arg.to_str()
            .is_some_and(|text| text.starts_with("--update-coordination-"))
    }) {
        return None;
    }
    let result = match parse(&args) {
        Some(Request::Capability) => outcome("supported", "capability"),
        Some(request) => run(request),
        None => outcome("blocked", "invalid-request"),
    };
    // stdout can be an inherited pipe even for a Windows-subsystem executable.
    // Native release-binary pipe proof is a required adoption gate.
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    let bytes = serde_json::to_vec(&result).expect("fixed outcome serializes");
    if stdout
        .write_all(&bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .is_err()
    {
        return Some(2);
    }
    Some(if result.status == "blocked" { 2 } else { 0 })
}

/// A staged Setup process holds this lease for its complete GUI lifetime.
/// The broker never holds the install lock needed by that process.
pub use handoff_v2::StageLease;

pub fn claim_stage_child_if_requested() -> Result<Option<StageLease>, &'static str> {
    handoff_v2::claim_child_if_requested()
}

#[cfg(windows)]
use native::handoff_v2;

#[cfg(not(windows))]
mod handoff_v2 {
    use super::*;
    pub struct StageLease;
    pub fn run_broker(_args: &[OsString]) -> i32 { 2 }
    pub fn claim_child_if_requested() -> Result<Option<StageLease>, &'static str> {
        if std::env::args().any(|arg| arg == "--setup-handoff-child-v2") {
            Err("unsupported-platform")
        } else {
            Ok(None)
        }
    }
}

#[cfg(not(windows))]
fn run(_request: Request) -> Outcome {
    outcome("blocked", "unsupported-platform")
}

#[cfg(windows)]
fn run(request: Request) -> Outcome {
    match native::coordinate(request) {
        Ok(result) => result,
        Err(reason) => outcome("blocked", reason),
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{
        fs::{File, OpenOptions},
        io::{Read, Write},
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        path::Path,
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Security::{
            self,
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
        },
        Storage::FileSystem::*,
        System::Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    type Result<T> = std::result::Result<T, &'static str>;
    const MARKER: &str = ".youtab-agent-runtime-update-in-progress";
    // Win32 generic and standard rights; directory create-child rights are
    // intentionally excluded for ancestors, where they cannot replace a held
    // existing directory. Home/leaf rights include all entry/content mutation.
    const COMMON_MUTATION: u32 = DELETE
        | WRITE_DAC
        | WRITE_OWNER
        | FILE_DELETE_CHILD
        | FILE_WRITE_ATTRIBUTES
        | FILE_WRITE_EA
        | 0x10000000
        | 0x40000000;
    fn mutation_mask(home_or_leaf: bool) -> u32 {
        COMMON_MUTATION
            | if home_or_leaf {
                FILE_WRITE_DATA | FILE_APPEND_DATA
            } else {
                0
            }
    }

    struct Descriptor(Security::PSECURITY_DESCRIPTOR);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0 as _);
            }
        }
    }

    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    // u64 storage provides native SID/TOKEN_USER alignment, unlike Vec<u8>.
    #[derive(Clone)]
    pub(super) struct Identities {
        current: Vec<u64>,
        system: Vec<u64>,
        admins: Vec<u64>,
        installer: Vec<u64>,
    }
    fn pointer(bytes: &[u64]) -> Security::PSID {
        bytes.as_ptr() as _
    }

    fn known_sid(kind: Security::WELL_KNOWN_SID_TYPE) -> Result<Vec<u64>> {
        let mut bytes = vec![0u64; 9];
        let mut length = (bytes.len() * 8) as u32;
        if unsafe {
            Security::CreateWellKnownSid(
                kind,
                ptr::null_mut(),
                bytes.as_mut_ptr() as _,
                &mut length,
            )
        } == 0
        {
            return Err("identity-unverifiable");
        }
        Ok(bytes)
    }

    pub(super) fn identities() -> Result<Identities> {
        unsafe {
            let mut raw = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), Security::TOKEN_QUERY, &mut raw) == 0 {
                return Err("identity-unverifiable");
            }
            let token = Token(raw);
            let mut needed = 0;
            Security::GetTokenInformation(
                token.0,
                Security::TokenUser,
                ptr::null_mut(),
                0,
                &mut needed,
            );
            if needed == 0 || needed > 65536 {
                return Err("identity-unverifiable");
            }
            let mut data = vec![0u64; (needed as usize + 7) / 8];
            if Security::GetTokenInformation(
                token.0,
                Security::TokenUser,
                data.as_mut_ptr() as _,
                needed,
                &mut needed,
            ) == 0
            {
                return Err("identity-unverifiable");
            }
            let user = &*(data.as_ptr() as *const Security::TOKEN_USER);
            if Security::IsValidSid(user.User.Sid) == 0 {
                return Err("identity-unverifiable");
            }
            let length = Security::GetLengthSid(user.User.Sid);
            let mut current = vec![0u64; (length as usize + 7) / 8];
            if Security::CopySid(length, current.as_mut_ptr() as _, user.User.Sid) == 0 {
                return Err("identity-unverifiable");
            }
            // Fixed Windows service SID for TrustedInstaller. Only ancestors,
            // including the volume root, may use this administrative principal.
            let value: Vec<u16> = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut service = ptr::null_mut();
            if Security::Authorization::ConvertStringSidToSidW(value.as_ptr(), &mut service) == 0 {
                return Err("identity-unverifiable");
            }
            let length = Security::GetLengthSid(service);
            let mut installer = vec![0u64; (length as usize + 7) / 8];
            let copied = Security::CopySid(length, installer.as_mut_ptr() as _, service);
            LocalFree(service as _);
            if copied == 0 {
                return Err("identity-unverifiable");
            }
            Ok(Identities {
                current,
                system: known_sid(Security::WinLocalSystemSid)?,
                admins: known_sid(Security::WinBuiltinAdministratorsSid)?,
                installer,
            })
        }
    }

    fn trusted(sid: Security::PSID, ids: &Identities, ancestor: bool) -> bool {
        [&ids.current, &ids.system, &ids.admins]
            .into_iter()
            .any(|identity| unsafe { Security::EqualSid(sid, pointer(identity)) != 0 })
            || (ancestor && unsafe { Security::EqualSid(sid, pointer(&ids.installer)) != 0 })
    }

    fn admit(file: &File, ids: &Identities, home_or_leaf: bool) -> Result<()> {
        admit_policy(file, ids, home_or_leaf, false)
    }

    fn admit_policy(
        file: &File,
        ids: &Identities,
        home_or_leaf: bool,
        code_children: bool,
    ) -> Result<()> {
        unsafe {
            let mut owner = ptr::null_mut();
            let mut acl = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            let status = GetSecurityInfo(
                file.as_raw_handle() as _,
                SE_FILE_OBJECT,
                Security::OWNER_SECURITY_INFORMATION | Security::DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut acl,
                ptr::null_mut(),
                &mut descriptor,
            );
            if status != 0 {
                return Err("namespace-unverifiable");
            }
            let _descriptor = Descriptor(descriptor);
            if descriptor.is_null()
                || owner.is_null()
                || acl.is_null()
                || Security::IsValidSecurityDescriptor(descriptor) == 0
                || Security::IsValidSid(owner) == 0
                || Security::IsValidAcl(acl) == 0
                || !trusted(owner, ids, !home_or_leaf)
            {
                return Err("unsafe-home");
            }
            for index in 0..(*acl).AceCount as u32 {
                let mut raw = ptr::null_mut();
                if Security::GetAce(acl, index, &mut raw) == 0 {
                    return Err("namespace-unverifiable");
                }
                let header = &*(raw as *const Security::ACE_HEADER);
                // INHERIT_ONLY does not grant authority on this opened object.
                if header.AceFlags & 8 != 0 && !(code_children && header.AceFlags & 3 != 0) {
                    continue;
                }
                match header.AceType {
                    1 => continue, // ACCESS_DENIED cannot grant mutation.
                    0 => {
                        if header.AceSize < 16 {
                            return Err("namespace-unverifiable");
                        }
                        let allow = &*(raw as *const Security::ACCESS_ALLOWED_ACE);
                        let sid = (&allow.SidStart as *const u32) as Security::PSID;
                        let sid_bytes = std::slice::from_raw_parts(
                            sid as *const u8,
                            header.AceSize as usize - 8,
                        );
                        let sid_length = 8 + usize::from(sid_bytes[1]) * 4;
                        if sid_length > sid_bytes.len() || Security::IsValidSid(sid) == 0 {
                            return Err("namespace-unverifiable");
                        }
                        // Undocumented/reserved grant bits (including a
                        // MAXIMUM_ALLOWED ACE) are not classified as read-only.
                        const KNOWN_FILE_RIGHTS: u32 = 0xf0000000 | 0x001f01ff | 0x01000000;
                        if allow.Mask & !KNOWN_FILE_RIGHTS != 0 {
                            return Err("namespace-unverifiable");
                        }
                        if allow.Mask & mutation_mask(home_or_leaf) != 0
                            && !trusted(sid, ids, !home_or_leaf)
                        {
                            return Err("unsafe-home");
                        }
                    }
                    // Conditional/object/unknown grant semantics require an
                    // explicit future policy; never assume them harmless.
                    _ => return Err("namespace-unverifiable"),
                }
            }
            Ok(())
        }
    }

    #[derive(PartialEq, Eq, Clone, Copy)]
    struct Identity(u32, u64);
    fn identity(file: &File, directory: bool, alias: bool) -> Result<Identity> {
        identity_policy(file, directory, alias, true)
    }
    // Code aliases share one owner/DACL. Read-only identity/ACL admission
    // denies foreign content/attribute/permission mutation through any alias.
    // Marker reads retain their distinct single-link/victim-preservation rule.
    fn code_identity(file: &File, directory: bool) -> Result<Identity> {
        identity_policy(file, directory, false, false)
    }
    fn identity_policy(
        file: &File,
        directory: bool,
        alias: bool,
        single_link: bool,
    ) -> Result<Identity> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err("namespace-unverifiable");
        }
        if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
            || (!alias && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            || (single_link && !directory && info.nNumberOfLinks != 1)
        {
            return Err("unsafe-object");
        }
        Ok(Identity(
            info.dwVolumeSerialNumber,
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }

    fn open_directory(path: &Path, follow: bool) -> Result<File> {
        // Metadata-only opens do not participate in read/write/delete sharing.
        // Directory data-read access makes no-share-delete pin its namespace.
        OpenOptions::new()
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(
                FILE_FLAG_BACKUP_SEMANTICS
                    | if follow {
                        0
                    } else {
                        FILE_FLAG_OPEN_REPARSE_POINT
                    },
            )
            .open(path)
            .map_err(|_| "namespace-unverifiable")
    }

    pub(super) struct Namespace {
        home: PathBuf,
        selected: PathBuf,
        identity: Identity,
        held: Vec<(File, bool)>,
        code_children: bool,
    }
    impl Namespace {
        pub(super) fn selected_home(&self) -> &Path { &self.selected }

        pub(super) fn open(selected: &Path, ids: &Identities) -> Result<Self> {
            Self::open_with_policy(selected, ids, false)
        }
        pub(super) fn open_private(selected: &Path, ids: &Identities) -> Result<Self> {
            Self::open_with_policy(selected, ids, true)
        }
        fn open_with_policy(
            selected: &Path,
            ids: &Identities,
            code_children: bool,
        ) -> Result<Self> {
            let followed = open_directory(selected, true)?;
            let selected_identity = identity(&followed, true, false)?;
            let home = std::fs::canonicalize(selected).map_err(|_| "namespace-unverifiable")?;
            // Only local volume paths have the reviewed ancestor semantics.
            let text = home.to_str().ok_or("namespace-unverifiable")?;
            if !text.starts_with("\\\\?\\") || text.starts_with("\\\\?\\UNC\\") {
                return Err("namespace-unverifiable");
            }
            let mut held = vec![(followed, true)];
            for chain in [&home, selected] {
                for (index, path) in chain.ancestors().enumerate() {
                    let file = open_directory(path, false)?;
                    identity(&file, true, chain == selected && index == 0)?;
                    admit_policy(&file, ids, index == 0, code_children && index == 0)?;
                    held.push((file, index == 0));
                }
            }
            let canonical = open_directory(&home, false)?;
            if identity(&canonical, true, false)? != selected_identity {
                return Err("namespace-changed");
            }
            held.push((canonical, true));
            Ok(Self {
                home,
                selected: selected.to_owned(),
                identity: selected_identity,
                held,
                code_children,
            })
        }
        pub(super) fn require_home(&self, selected: &Path, ids: &Identities) -> Result<()> {
            self.revalidate(ids)?;
            let leaf = open_directory(selected, false)?;
            if identity(&leaf, true, false)? != self.identity ||
                std::fs::canonicalize(selected).map_err(|_| "namespace-unverifiable")? != self.home {
                return Err("code-scope-unverifiable");
            }
            Ok(())
        }
        pub(super) fn revalidate(&self, ids: &Identities) -> Result<()> {
            let current = open_directory(&self.selected, true)?;
            if identity(&current, true, false)? != self.identity {
                return Err("namespace-changed");
            }
            for (file, home_or_leaf) in &self.held {
                admit_policy(
                    file,
                    ids,
                    *home_or_leaf,
                    self.code_children && *home_or_leaf,
                )?;
            }
            Ok(())
        }
    }

    pub(super) struct CodeTree {
        ids: Identities,
        namespace: Namespace,
        held: Vec<(File, bool)>,
    }
    impl CodeTree {
        pub(super) fn revalidate(&self) -> Result<()> {
            self.namespace.revalidate(&self.ids)?;
            for (file, directory) in &self.held {
                code_identity(file, *directory)?;
                admit_policy(file, &self.ids, true, *directory)?;
            }
            Ok(())
        }
    }

    pub(super) fn open_code_tree(
        home: &Namespace,
        ids: &Identities,
        selected: &Path,
    ) -> Result<Option<CodeTree>> {
        home.revalidate(ids)?;
        let relative = selected
            .strip_prefix(&home.selected)
            .map_err(|_| "code-scope-unverifiable")?;
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("code-scope-unverifiable");
        }
        let parts: Vec<_> = relative.components().collect();
        let mut parent = home.home.clone();
        let mut held = Vec::new();
        // Validate every existing descendant parent before resolving the leaf.
        // No intermediate junction may redirect admission outside this home.
        for part in &parts[..parts.len() - 1] {
            parent.push(part.as_os_str());
            let file = match OpenOptions::new()
                .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&parent)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("namespace-unverifiable"),
            };
            identity(&file, true, false)?;
            admit_policy(&file, ids, true, true)?;
            held.push((file, true));
        }
        let namespace = Namespace::open_private(&parent, ids)?;
        if !namespace.home.starts_with(&home.home) {
            return Err("code-scope-unverifiable");
        }
        let root = parent.join(parts.last().ok_or("code-scope-unverifiable")?.as_os_str());
        let metadata = match std::fs::symlink_metadata(&root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("namespace-unverifiable"),
        };
        let mut pending = vec![(root, metadata.is_dir())];
        let mut checked_entries = 0usize;
        while let Some((path, directory)) = pending.pop() {
            checked_entries += 1;
            if checked_entries > 1048576 || held.len() >= 32768 {
                return Err("code-scope-limit");
            }
            let file = if directory {
                open_directory(&path, false)?
            } else {
                OpenOptions::new()
                    .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&path)
                    .map_err(|_| "namespace-unverifiable")?
            };
            code_identity(&file, directory)?;
            admit_policy(&file, ids, true, directory)?;
            // Effective file owner/DACL denies foreign object mutation and
            // WRITE_DAC. Keep directory authority/identity handles; stream
            // leaf checks instead of retaining tens of thousands of handles.
            if directory {
                held.push((file, true));
                for entry in std::fs::read_dir(&path).map_err(|_| "namespace-unverifiable")? {
                    let entry = entry.map_err(|_| "namespace-unverifiable")?;
                    let kind = entry.file_type().map_err(|_| "namespace-unverifiable")?;
                    if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
                        return Err("unsafe-object");
                    }
                    if checked_entries + pending.len() >= 1048576 {
                        return Err("code-scope-limit");
                    }
                    pending.push((entry.path(), kind.is_dir()));
                }
            }
        }
        let tree = CodeTree {
            ids: ids.clone(),
            namespace,
            held,
        };
        tree.revalidate()?;
        home.revalidate(ids)?;
        Ok(Some(tree))
    }

    fn optional_leaf(path: &Path, ids: &Identities) -> Result<Option<File>> {
        let mut options = OpenOptions::new();
        options
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        match options.open(path) {
            Ok(file) => {
                identity(&file, false, false)?;
                admit(&file, ids, true)?;
                Ok(Some(file))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("coordination-unavailable"),
        }
    }

    fn alive(pid: u32) -> Result<bool> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return if std::io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_INVALID_PARAMETER as i32)
                {
                    Ok(false)
                } else {
                    Err("marker-unverifiable")
                };
            }
            let process = Token(handle);
            match WaitForSingleObject(process.0, 0) {
                WAIT_TIMEOUT => Ok(true),
                WAIT_OBJECT_0 => Ok(false),
                _ => Err("marker-unverifiable"),
            }
        }
    }

    fn hint(file: Option<File>, publication_pid: Option<u32>, now: u64) -> Result<()> {
        let Some(file) = file else {
            return Ok(());
        };
        let before = file.metadata().map_err(|_| "marker-unverifiable")?;
        if before.len() > 4096 {
            return Err("marker-unverifiable");
        }
        let mut bytes = Vec::new();
        (&file)
            .take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| "marker-unverifiable")?;
        let after = file.metadata().map_err(|_| "marker-unverifiable")?;
        if bytes.len() > 4096
            || after.len() != before.len()
            || before.modified().ok() != after.modified().ok()
        {
            return Err("marker-unverifiable");
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| "marker-unverifiable")?;
        let mut lines = text.split('\n').map(str::trim);
        let pid = u32::try_from(
            positive_integer(lines.next().unwrap_or("")).ok_or("marker-unverifiable")?,
        )
        .map_err(|_| "marker-unverifiable")?;
        if !alive(pid)? {
            return Ok(());
        }
        let started = positive_integer(lines.next().unwrap_or("")).ok_or("marker-unverifiable")?;
        if lines.any(|line| !line.is_empty()) || started > now {
            return Err("marker-unverifiable");
        }
        if now - started <= 1200 && publication_pid != Some(pid) {
            return Err("update-active");
        }
        Ok(())
    }

    pub(super) fn coordinate(request: Request) -> Result<Outcome> {
        let (home, publication) = match request {
            Request::Inspect(home) => (home, None),
            Request::Publish {
                home,
                pid,
                created_at,
                instance,
            } => (home, Some((pid, created_at, instance))),
            Request::Capability => return Ok(outcome("supported", "capability")),
        };
        let ids = identities()?;
        let namespace = Namespace::open(&home, &ids)?;
        let marker = namespace.home.join(MARKER);
        // This is a read-only contention probe, not a competing mutation lock.
        // Close its handle before publication/GUI handoff. Neither mode creates,
        // renames or deletes the stable sidecar. The marker remains only a hint;
        // readers always honor Setup's OS-held sidecar before inspecting it.
        drop(optional_leaf(&marker.with_extension("install-lock"), &ids)?);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "clock-unverifiable")?
            .as_secs();
        hint(
            optional_leaf(&marker, &ids)?,
            publication.as_ref().map(|item| item.0),
            now,
        )?;
        namespace.revalidate(&ids)?;
        if let Some((pid, created_at, instance)) = publication {
            if created_at / 1000 > now || created_at / 1000 == 0 || !alive(pid)? {
                return Err("invalid-publication");
            }
            let mut stage = tempfile::Builder::new()
                .prefix(&format!(".youtab-update-{instance}-"))
                .suffix(".tmp")
                .tempfile_in(&namespace.home)
                .map_err(|_| "publication-unavailable")?;
            identity(stage.as_file(), false, false)?;
            admit(stage.as_file(), &ids, true)?;
            write!(stage, "{pid}\n{}\n", created_at / 1000)
                .map_err(|_| "publication-unavailable")?;
            stage
                .as_file()
                .sync_all()
                .map_err(|_| "publication-unavailable")?;
            namespace.revalidate(&ids)?;
            stage
                .persist(&marker)
                .map_err(|_| "publication-unavailable")?;
            Ok(outcome("published", "handoff-published"))
        } else {
            Ok(outcome("clear", "no-active-update"))
        }
    }

    /// The broker runs from the installed common Setup and exits before the
    /// staged child is allowed to replace it. The child's lease survives the
    /// broker's exit; the install lock remains owned only by the child.
    pub(super) mod handoff_v2 {
        use super::*;
        use sha2::{Digest, Sha256};
        use std::{
            io::{BufRead, BufReader, Seek, SeekFrom},
            os::windows::io::{AsRawHandle, FromRawHandle},
            process::{Command, Stdio},
            sync::mpsc,
            time::Duration,
        };
        use windows_sys::Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, FILETIME, INVALID_HANDLE_VALUE},
            System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };

        const PROTOCOL: &str = "youtab.setup-handoff";
        const MAX_SETUP: u64 = 256 * 1024 * 1024;
        const MAX_ENTRIES: usize = 4;
        const MAX_CACHE: u64 = 4 * MAX_SETUP;
        // Legacy Desktop stages have no durable lease. Never delete or count
        // them as v2-owned entries; tolerate a bounded existing population.
        const MAX_DIRECTORY_SCAN: usize = 4096;
        const MAX_V2_FILES: usize = 128;
        const LOCK_NAME: &str = ".setup-stage-v2.lock";
        const JOURNAL_SLOT: usize = 4096;

        #[derive(serde::Serialize)]
        struct Reply<'a> {
            protocol: &'static str,
            version: u8,
            status: &'a str,
            reason: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            pid: Option<u32>,
            #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
            created_at: Option<String>,
            #[serde(rename = "stageId", skip_serializing_if = "Option::is_none")]
            stage_id: Option<String>,
        }

        fn reply(status: &'static str, reason: &'static str) -> Reply<'static> {
            let _ = std::hint::black_box(SETUP_HANDOFF_PE_VERSION);
            Reply { protocol: PROTOCOL, version: 2, status, reason, pid: None, created_at: None, stage_id: None }
        }

        fn public_reason(reason: &'static str) -> &'static str {
            match reason {
                "invalid-request" | "unsafe-home" | "cache-unavailable" | "cache-full"
                | "input-invalid" | "integrity-failed" | "stage-unavailable"
                | "launch-unconfirmed" | "lease-unconfirmed" | "process-unverifiable" => reason,
                "namespace-unverifiable" | "namespace-changed" | "unsafe-object" => "unsafe-home",
                _ => "cache-unavailable",
            }
        }

        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        enum StageMode { Update, Repair }

        impl StageMode {
            fn child_flag(self) -> &'static str {
                match self { Self::Update => "--update", Self::Repair => "--repair" }
            }
        }

        #[derive(Clone)]
        struct StageRequest {
            home: PathBuf,
            sha256: String,
            size: u64,
            channel: String,
            source_sha: String,
            id: String,
            mode: StageMode,
        }

        enum BrokerRequest { Capability, Stage(StageRequest), Reap(PathBuf) }

        fn parse_child(args: &[OsString]) -> Option<(String, PathBuf, String, StageMode)> {
            let text = args.iter().map(|arg| arg.to_str()).collect::<Option<Vec<_>>>()?;
            let ["--setup-handoff-child-v2", "--lease-token", id, "--home", home,
                 mode_flag, "--channel", channel] = text.as_slice() else { return None; };
            let mode = match *mode_flag {
                "--update" => StageMode::Update,
                "--repair" => StageMode::Repair,
                _ => return None,
            };
            if !valid_instance(id) || !Path::new(home).is_absolute()
                || !matches!(*channel, "pilot" | "stable") { return None; }
            Some((id.to_string(), PathBuf::from(home), channel.to_string(), mode))
        }

        fn lowercase_hex(value: &str, len: usize) -> bool {
            value.len() == len && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }

        fn parse_broker(args: &[OsString]) -> Option<BrokerRequest> {
            let text = args.iter().map(|arg| arg.to_str()).collect::<Option<Vec<_>>>()?;
            match text.as_slice() {
                ["--setup-handoff-v2", "capability"] => Some(BrokerRequest::Capability),
                ["--setup-handoff-v2", "--reap", "--home", home]
                    if Path::new(home).is_absolute() => Some(BrokerRequest::Reap(PathBuf::from(home))),
                ["--setup-handoff-v2", "--home", home, "--sha256", sha, "--size", size,
                 "--channel", channel, "--source-sha", source, "--request-id", id, rest @ ..]
                    if Path::new(home).is_absolute()
                        && lowercase_hex(sha, 64)
                        && lowercase_hex(source, 40)
                        && matches!(*channel, "pilot" | "stable")
                        && valid_instance(id) => {
                    // Existing exact Stage argv remains Update. Repair is an
                    // explicit, strictly ordered suffix; no caller-supplied
                    // executable flags are forwarded to the staged child.
                    let mode = match rest {
                        [] => StageMode::Update,
                        ["--mode", "repair"] => StageMode::Repair,
                        _ => return None,
                    };
                    let size = positive_integer(size)?;
                    if size > MAX_SETUP { return None; }
                    Some(BrokerRequest::Stage(StageRequest {
                        home: PathBuf::from(home), sha256: sha.to_string(), size,
                        channel: channel.to_string(), source_sha: source.to_string(), id: id.to_string(), mode,
                    }))
                }
                _ => None,
            }
        }

        #[derive(Clone, serde::Serialize, serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Journal {
            stage_id: String,
            sha256: String,
            source_sha: String,
            size: u64,
            state: String,
            pid: Option<u32>,
            created_at: Option<String>,
            volume: u32,
            file_index: u64,
        }

        #[derive(serde::Serialize, serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SequencedJournal { sequence: u64, value: Journal }

        fn read_record(file: &File) -> Result<Option<(u64, Journal)>> {
            let length = file.metadata().map_err(|_| "cache-unavailable")?.len();
            if length == 0 { return Ok(None); }
            if length > (2 * JOURNAL_SLOT) as u64 { return Err("cache-unavailable"); }
            let mut bytes = vec![0u8; length as usize];
            let mut reader = file;
            reader.seek(SeekFrom::Start(0)).map_err(|_| "cache-unavailable")?;
            reader.read_exact(&mut bytes).map_err(|_| "cache-unavailable")?;
            let mut best: Option<(u64, Journal)> = None;
            for slot in bytes.chunks_exact(JOURNAL_SLOT) {
                let size = u32::from_le_bytes(slot[..4].try_into().map_err(|_| "cache-unavailable")?) as usize;
                if size == 0 || size > JOURNAL_SLOT - 36 || slot[36 + size..].iter().any(|b| *b != 0) {
                    continue;
                }
                let payload = &slot[36..36 + size];
                if Sha256::digest(payload).as_slice() != &slot[4..36] { continue; }
                let Ok(record) = serde_json::from_slice::<SequencedJournal>(payload) else { continue; };
                if record.sequence == 0 { continue; }
                if best.as_ref().is_none_or(|(sequence, _)| record.sequence > *sequence) {
                    best = Some((record.sequence, record.value));
                }
            }
            Ok(best)
        }

        fn write_journal(file: &mut File, journal: &Journal) -> Result<()> {
            let length = file.metadata().map_err(|_| "stage-unavailable")?.len();
            let previous = read_record(file).map_err(|_| "stage-unavailable")?;
            if length != 0 && previous.is_none() { return Err("stage-unavailable"); }
            let sequence = previous.map_or(1, |(value, _)| value.checked_add(1).unwrap_or(0));
            if sequence == 0 { return Err("stage-unavailable"); }
            let payload = serde_json::to_vec(&SequencedJournal { sequence, value: journal.clone() })
                .map_err(|_| "stage-unavailable")?;
            if payload.len() > JOURNAL_SLOT - 36 { return Err("stage-unavailable"); }
            let mut slot = [0u8; JOURNAL_SLOT];
            slot[..4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
            slot[4..36].copy_from_slice(&Sha256::digest(&payload));
            slot[36..36 + payload.len()].copy_from_slice(&payload);
            let index = (sequence - 1) % 2;
            file.seek(SeekFrom::Start(index * JOURNAL_SLOT as u64)).map_err(|_| "stage-unavailable")?;
            file.write_all(&slot).map_err(|_| "stage-unavailable")?;
            file.sync_all().map_err(|_| "stage-unavailable")
        }

        fn read_journal(file: &File) -> Result<Journal> {
            read_record(file)?.map(|(_, value)| value).ok_or("cache-unavailable")
        }

        fn open_cache(home: &Path, ids: &Identities) -> Result<(Namespace, Namespace, File)> {
            let home_namespace = Namespace::open_private(home, ids)?;
            let cache = home.join("update-cache");
            match std::fs::create_dir(&cache) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err("cache-unavailable"),
            }
            let cache_namespace = Namespace::open_private(&cache, ids)?;
            if !cache_namespace.home.starts_with(&home_namespace.home) {
                return Err("unsafe-home");
            }
            let lock_path = cache.join(LOCK_NAME);
            let lock = OpenOptions::new().read(true).write(true).create(true)
                .share_mode(0).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(lock_path).map_err(|_| "cache-unavailable")?;
            identity(&lock, false, false)?;
            admit(&lock, ids, true)?;
            home_namespace.revalidate(ids)?;
            cache_namespace.revalidate(ids)?;
            Ok((home_namespace, cache_namespace, lock))
        }

        fn read_exact_input(size: u64, sha: &str) -> Result<Vec<u8>> {
            let mut data = Vec::with_capacity(size as usize);
            let mut input = std::io::stdin().lock().take(size + 1);
            input.read_to_end(&mut data).map_err(|_| "input-invalid")?;
            if data.len() as u64 != size { return Err("input-invalid"); }
            if format!("{:x}", Sha256::digest(&data)) != sha { return Err("integrity-failed"); }
            if data.len() < 64 || &data[..2] != b"MZ" { return Err("integrity-failed"); }
            let offset = u32::from_le_bytes(data[0x3c..0x40].try_into().map_err(|_| "integrity-failed")?) as usize;
            if offset.checked_add(6).map_or(true, |end| end > data.len())
                || &data[offset..offset + 4] != b"PE\0\0"
                || u16::from_le_bytes([data[offset + 4], data[offset + 5]]) != 0x8664 {
                return Err("integrity-failed");
            }
            Ok(data)
        }

        fn process_created_at(handle: HANDLE) -> Result<String> {
            let mut created = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let mut exited = created;
            let mut kernel = created;
            let mut user = created;
            if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
                return Err("process-unverifiable");
            }
            Ok(((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)).to_string())
        }

        fn process_gone(pid: u32, created_at: &str) -> Result<bool> {
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
                if handle.is_null() {
                    return if std::io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                        Ok(true)
                    } else { Err("process-unverifiable") };
                }
                let guard = Token(handle);
                if process_created_at(guard.0)? != created_at { return Ok(true); }
                match WaitForSingleObject(guard.0, 0) {
                    WAIT_OBJECT_0 => Ok(true),
                    WAIT_TIMEOUT => Ok(false),
                    _ => Err("process-unverifiable"),
                }
            }
        }

        fn stage_paths(cache: &Path, id: &str) -> (PathBuf, PathBuf) {
            (cache.join(format!("setup-v2-{id}.exe")), cache.join(format!("setup-v2-{id}.json")))
        }

        fn open_owned_leaf(path: &Path, ids: &Identities) -> Result<File> {
            let file = OpenOptions::new().read(true).write(true).share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(|_| "cache-unavailable")?;
            identity(&file, false, false)?;
            admit(&file, ids, true)?;
            Ok(file)
        }

        fn reopen_read_only(source: &File, share: FILE_SHARE_MODE) -> Result<File> {
            let raw = unsafe { ReOpenFile(source.as_raw_handle() as _,
                FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL,
                share, FILE_FLAG_OPEN_REPARSE_POINT) };
            if raw == INVALID_HANDLE_VALUE { return Err("stage-unavailable"); }
            Ok(unsafe { File::from_raw_handle(raw as _) })
        }

        fn pin_staged_executable(mut writable: File, expected: Identity, expected_sha: &str,
            ids: &Identities) -> Result<File> {
            writable.flush().map_err(|_| "stage-unavailable")?;
            writable.sync_all().map_err(|_| "stage-unavailable")?;
            // ReOpenFile binds the same object by handle. The intermediate
            // read-only handle permits the writable handle to close; the
            // final handle denies new writers/deleters through child exit.
            let intermediate = reopen_read_only(&writable, FILE_SHARE_READ | FILE_SHARE_WRITE)?;
            drop(writable);
            let mut pinned = reopen_read_only(&intermediate, FILE_SHARE_READ)?;
            drop(intermediate);
            if identity(&pinned, false, false)? != expected { return Err("stage-unavailable"); }
            admit(&pinned, ids, true)?;
            pinned.seek(SeekFrom::Start(0)).map_err(|_| "stage-unavailable")?;
            let mut hash = Sha256::new();
            let mut block = [0u8; 65536];
            loop {
                let n = pinned.read(&mut block).map_err(|_| "stage-unavailable")?;
                if n == 0 { break; }
                hash.update(&block[..n]);
            }
            if format!("{:x}", hash.finalize()) != expected_sha { return Err("integrity-failed"); }
            Ok(pinned)
        }

        fn open_owned_for_delete(path: &Path, ids: &Identities) -> Result<File> {
            let file = OpenOptions::new().access_mode(READ_CONTROL | FILE_READ_DATA | FILE_READ_ATTRIBUTES | DELETE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(|_| "cache-unavailable")?;
            identity(&file, false, false)?;
            admit(&file, ids, true)?;
            Ok(file)
        }

        fn delete_by_handle(file: &File) -> Result<()> {
            let info = FILE_DISPOSITION_INFO_EX {
                Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_ON_CLOSE,
            };
            if unsafe { SetFileInformationByHandle(file.as_raw_handle() as _, FileDispositionInfoEx,
                &info as *const _ as _, std::mem::size_of_val(&info) as u32) } != 0 {
                return Ok(());
            }
            // Some supported Windows volumes reject the extended disposition
            // class. The legacy class still marks this already verified handle
            // for deletion and never reopens an attacker-controlled pathname.
            if std::io::Error::last_os_error().raw_os_error() != Some(50) {
                return Err("cache-unavailable");
            }
            let legacy = FILE_DISPOSITION_INFO { DeleteFile: 1 };
            if unsafe { SetFileInformationByHandle(file.as_raw_handle() as _, FileDispositionInfo,
                &legacy as *const _ as _, std::mem::size_of_val(&legacy) as u32) } == 0 {
                return Err("cache-unavailable");
            }
            Ok(())
        }

        fn reap(cache: &Namespace, ids: &Identities) -> Result<(usize, u64)> {
            let mut count = 0usize;
            let mut bytes = 0u64;
            let mut v2_files = 0usize;
            let mut journal_ids = std::collections::HashSet::new();
            let mut executable_ids = std::collections::HashSet::new();
            let directory_entries = std::fs::read_dir(&cache.home).map_err(|_| "cache-unavailable")?
                .take(MAX_DIRECTORY_SCAN + 1).collect::<std::io::Result<Vec<_>>>().map_err(|_| "cache-unavailable")?;
            if directory_entries.len() > MAX_DIRECTORY_SCAN { return Err("cache-full"); }
            for entry in &directory_entries {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { return Err("cache-unavailable"); };
                if !name.starts_with("setup-v2-") { continue; }
                v2_files += 1;
                if v2_files > MAX_V2_FILES { return Err("cache-full"); }
                if name.starts_with("setup-v2-") && name.ends_with(".exe") {
                    let id = &name[9..name.len() - 4];
                    if !valid_instance(id) { return Err("cache-unavailable"); }
                    executable_ids.insert(id.to_owned());
                }
                if !name.starts_with("setup-v2-") || !name.ends_with(".json") { continue; }
                let id = &name[9..name.len() - 5];
                if !valid_instance(id) { return Err("cache-unavailable"); }
                journal_ids.insert(id.to_owned());
                let (stage_path, journal_path) = stage_paths(&cache.home, id);
                let journal_file = match open_owned_for_delete(&journal_path, ids) {
                    Ok(file) => file,
                    // An active child holds this lease exclusively.
                    Err(_) => {
                        count += 1;
                        bytes = bytes.checked_add(MAX_SETUP).ok_or("cache-full")?;
                        continue;
                    }
                };
                let journal = match read_journal(&journal_file) {
                    Ok(value) => value,
                    Err(_) if !stage_path.exists() => {
                        cache.revalidate(ids)?;
                        delete_by_handle(&journal_file)?;
                        drop(journal_file);
                        continue;
                    }
                    Err(reason) => return Err(reason),
                };
                if journal.stage_id != id || !lowercase_hex(&journal.sha256, 64)
                    || journal.size == 0 || journal.size > MAX_SETUP { return Err("cache-unavailable"); }
                let completed = if matches!(journal.state.as_str(), "allocating" | "staged") { true }
                    else if matches!(journal.state.as_str(), "launching" | "active" | "complete") {
                        match (journal.pid, journal.created_at.as_deref()) {
                            (Some(pid), Some(start)) => process_gone(pid, start)?,
                            _ => false,
                        }
                    } else { false };
                if !completed {
                    count += 1;
                    bytes = bytes.checked_add(journal.size).ok_or("cache-full")?;
                    continue;
                }
                if !stage_path.exists() {
                    cache.revalidate(ids)?;
                    delete_by_handle(&journal_file)?;
                    drop(journal_file);
                    continue;
                }
                let mut stage = open_owned_for_delete(&stage_path, ids)?;
                let stage_identity = identity(&stage, false, false)?;
                if journal.state != "allocating" {
                    if stage_identity.0 != journal.volume || stage_identity.1 != journal.file_index
                        || stage.metadata().map_err(|_| "cache-unavailable")?.len() != journal.size {
                        return Err("cache-unavailable");
                    }
                    let mut hash = Sha256::new();
                    let mut block = [0u8; 65536];
                    loop {
                        let n = stage.read(&mut block).map_err(|_| "cache-unavailable")?;
                        if n == 0 { break; }
                        hash.update(&block[..n]);
                    }
                    if format!("{:x}", hash.finalize()) != journal.sha256 { return Err("cache-unavailable"); }
                }
                cache.revalidate(ids)?;
                // Disposition applies to these exact verified handles. Never
                // close and then unlink a pathname that could be substituted.
                delete_by_handle(&stage)?;
                drop(stage);
                delete_by_handle(&journal_file)?;
                drop(journal_file);
            }
            if !executable_ids.is_subset(&journal_ids) { return Err("cache-unavailable"); }
            cache.revalidate(ids)?;
            Ok((count, bytes))
        }

        fn stage(request: StageRequest) -> Result<Reply<'static>> {
            // A malicious or broken caller cannot create cache files before
            // the complete bounded stream, hash and PE header are verified.
            let data = read_exact_input(request.size, &request.sha256)?;
            let ids = identities()?;
            let (home, cache, _cache_lock) = open_cache(&request.home, &ids)?;
            let (count, bytes) = reap(&cache, &ids)?;
            if count >= MAX_ENTRIES || bytes.checked_add(request.size).map_or(true, |total| total > MAX_CACHE) {
                return Err("cache-full");
            }
            let (stage_path, journal_path) = stage_paths(&cache.home, &request.id);
            // The durable allocating record precedes the executable. A crash
            // during staging can therefore be reaped without guessing whether
            // an updater child was ever started.
            let mut lease = OpenOptions::new().read(true).write(true).create_new(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&journal_path).map_err(|_| "stage-unavailable")?;
            identity(&lease, false, false)?;
            admit(&lease, &ids, true)?;
            let mut journal = Journal {
                stage_id: request.id.clone(), sha256: request.sha256, source_sha: request.source_sha,
                size: request.size, state: "allocating".into(), pid: None, created_at: None,
                volume: 0, file_index: 0,
            };
            write_journal(&mut lease, &journal)?;
            let mut executable = OpenOptions::new().read(true).write(true).create_new(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&stage_path).map_err(|_| "stage-unavailable")?;
            executable.write_all(&data).map_err(|_| "stage-unavailable")?;
            executable.sync_all().map_err(|_| "stage-unavailable")?;
            let file_id = identity(&executable, false, false)?;
            admit(&executable, &ids, true)?;
            let executable = pin_staged_executable(executable, file_id, &journal.sha256, &ids)?;
            journal.volume = file_id.0;
            journal.file_index = file_id.1;
            journal.state = "staged".into();
            write_journal(&mut lease, &journal)?;
            home.revalidate(&ids)?;
            cache.revalidate(&ids)?;
            // Keep the durable record `staged` until CreateProcess returns and
            // its exact PID and creation time can be committed together. The
            // child blocks on stdin before touching the install. If this
            // broker dies before that commit, EOF aborts the child and the
            // staged record remains safely recoverable by the next broker.
            let spawned = Command::new(&stage_path)
                .args(["--setup-handoff-child-v2", "--lease-token", &request.id, "--home"])
                .arg(&request.home)
                .args([request.mode.child_flag(), "--channel", &request.channel])
                .env("YOUTAB_AGENT_HOME", &request.home)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
                .spawn();
            let mut child = match spawned {
                Ok(value) => value,
                Err(_) => return Err("launch-unconfirmed"),
            };
            let pid = child.id();
            let created_at = process_created_at(child.as_raw_handle() as HANDLE)?;
            // The cache lock remains held; no reaper can act before this
            // identity commit. Only then may the child receive its S gate.
            journal.state = "launching".into();
            journal.pid = Some(pid);
            journal.created_at = Some(created_at.clone());
            write_journal(&mut lease, &journal)?;
            drop(lease);
            child.stdin.as_mut().ok_or("lease-unconfirmed")?.write_all(b"S").map_err(|_| "lease-unconfirmed")?;
            let output = child.stdout.take().ok_or("lease-unconfirmed")?;
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(output).take(1025).read_line(&mut line).map(|_| line);
                let _ = sender.send(result);
            });
            let line = receiver.recv_timeout(Duration::from_secs(30)).map_err(|_| "lease-unconfirmed")?
                .map_err(|_| "lease-unconfirmed")?;
            if line.len() > 1024 { return Err("lease-unconfirmed"); }
            let ack: serde_json::Value = serde_json::from_str(&line).map_err(|_| "lease-unconfirmed")?;
            if ack.get("protocol").and_then(|v| v.as_str()) != Some(PROTOCOL)
                || ack.get("version").and_then(|v| v.as_u64()) != Some(2)
                || ack.get("status").and_then(|v| v.as_str()) != Some("lease-held")
                || ack.get("stageId").and_then(|v| v.as_str()) != Some(&request.id)
                || ack.get("pid").and_then(|v| v.as_u64()) != Some(u64::from(pid))
                || ack.get("createdAt").and_then(|v| v.as_str()) != Some(&created_at) {
                return Err("lease-unconfirmed");
            }
            // Child waits for this single byte before entering the updater UI.
            child.stdin.take().ok_or("lease-unconfirmed")?.write_all(b"G").map_err(|_| "lease-unconfirmed")?;
            cache.revalidate(&ids)?;
            drop(executable);
            Ok(Reply { protocol: PROTOCOL, version: 2, status: "started", reason: "lease-held",
                pid: Some(pid), created_at: Some(created_at), stage_id: Some(request.id) })
        }

        pub fn run_broker(args: &[OsString]) -> i32 {
            let result = match parse_broker(args) {
                Some(BrokerRequest::Capability) => Ok(reply("supported", "capability")),
                Some(BrokerRequest::Reap(home)) => (|| {
                    let ids = identities()?;
                    let (_home, cache, _lock) = open_cache(&home, &ids)?;
                    reap(&cache, &ids)?;
                    Ok(reply("clear", "reaped"))
                })(),
                Some(BrokerRequest::Stage(request)) => stage(request),
                None => Err("invalid-request"),
            };
            let response = match result { Ok(value) => value, Err(reason) => reply("blocked", public_reason(reason)) };
            let bytes = serde_json::to_vec(&response).expect("bounded outcome serializes");
            if bytes.len() > 4096 { return 2; }
            let mut stdout = std::io::stdout().lock();
            if stdout.write_all(&bytes).and_then(|_| stdout.write_all(b"\n")).and_then(|_| stdout.flush()).is_err() {
                return 2;
            }
            if response.status == "blocked" { 2 } else { 0 }
        }

        pub struct StageLease {
            journal: File,
            stage: File,
            cache: Namespace,
            ids: Identities,
            record: Journal,
        }

        impl Drop for StageLease {
            fn drop(&mut self) {
                // Normal exit makes the stage eligible for the next bounded
                // reap; abrupt exit remains an identity-checkable active PID.
                self.record.state = "complete".into();
                let _ = write_journal(&mut self.journal, &self.record);
                let _ = self.cache.revalidate(&self.ids);
                let _ = &self.stage;
                crate::update::release_staged_child_install_lock();
            }
        }

        pub fn claim_child_if_requested() -> Result<Option<StageLease>> {
            let args: Vec<_> = std::env::args_os().skip(1).collect();
            if !args.iter().any(|arg| arg.to_str().is_some_and(|text| text.starts_with("--setup-handoff-child-v2"))) { return Ok(None); }
            let (id, home, _channel, _mode) = parse_child(&args).ok_or("invalid-request")?;
            // The parent persists our PID/creation time before releasing the
            // child to claim its exclusive lease. EOF blocks before Tauri.
            let mut start = [0u8; 1];
            std::io::stdin().read_exact(&mut start).map_err(|_| "lease-unconfirmed")?;
            if start != [b'S'] { return Err("lease-unconfirmed"); }
            let ids = identities()?;
            let home_namespace = Namespace::open_private(&home, &ids)?;
            let cache = Namespace::open_private(&home_namespace.home.join("update-cache"), &ids)?;
            if !cache.home.starts_with(&home_namespace.home) { return Err("unsafe-home"); }
            let (stage_path, journal_path) = stage_paths(&cache.home, &id);
            let current = std::env::current_exe().map_err(|_| "lease-unconfirmed")?;
            let stage = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(&stage_path).map_err(|_| "lease-unconfirmed")?;
            let own = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(current).map_err(|_| "lease-unconfirmed")?;
            if identity(&stage, false, false)? != identity(&own, false, false)? { return Err("lease-unconfirmed"); }
            admit(&stage, &ids, true)?;
            let mut journal = open_owned_leaf(&journal_path, &ids)?;
            let mut record = read_journal(&journal)?;
            let stage_id = identity(&stage, false, false)?;
            if record.stage_id != id || record.state != "launching"
                || record.volume != stage_id.0 || record.file_index != stage_id.1
                || record.size != stage.metadata().map_err(|_| "lease-unconfirmed")?.len() {
                return Err("lease-unconfirmed");
            }
            let pid = std::process::id();
            let created_at = process_created_at(unsafe { GetCurrentProcess() })?;
            record.pid = Some(pid);
            record.created_at = Some(created_at.clone());
            record.state = "active".into();
            write_journal(&mut journal, &record)?;
            cache.revalidate(&ids)?;
            crate::update::hold_staged_child_install_lock(&home)
                .map_err(|_| "lease-unconfirmed")?;
            let ack = serde_json::json!({"protocol":PROTOCOL,"version":2,"status":"lease-held",
                "stageId":id,"pid":pid,"createdAt":created_at});
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "{ack}").map_err(|_| "lease-unconfirmed")?;
            stdout.flush().map_err(|_| "lease-unconfirmed")?;
            // The broker must validate this ACK and explicitly release the
            // child. EOF or any other byte aborts before Tauri/updating.
            let mut go = [0u8; 1];
            std::io::stdin().read_exact(&mut go).map_err(|_| "lease-unconfirmed")?;
            if go != [b'G'] { return Err("lease-unconfirmed"); }
            Ok(Some(StageLease { journal, stage, cache, ids, record }))
        }

        #[cfg(test)]
        mod tests {
            use super::*;
            fn argv(text: &[&str]) -> Vec<OsString> { text.iter().map(OsString::from).collect() }
            #[test]
            fn broker_accepts_only_exact_bounded_contract() {
                let id = "12345678-1234-1234-1234-123456789abc";
                let sha = "a".repeat(64);
                let source = "b".repeat(40);
                let size = MAX_SETUP.to_string();
                let base = ["--setup-handoff-v2", "--home", "C:\\Users\\owner\\youtab", "--sha256", &sha,
                    "--size", &size, "--channel", "pilot", "--source-sha", &source, "--request-id", id];
                assert!(matches!(parse_broker(&argv(&base)),
                    Some(BrokerRequest::Stage(StageRequest { mode: StageMode::Update, .. }))));
                let mut repair = base.to_vec();
                repair.extend(["--mode", "repair"]);
                assert!(matches!(parse_broker(&argv(&repair)),
                    Some(BrokerRequest::Stage(StageRequest { mode: StageMode::Repair, .. }))));
                for suffix in [
                    vec!["--mode"], vec!["--mode", "update"],
                    vec!["--mode", "repair", "--update"],
                    vec!["--repair"], vec!["--mode", "repair", "--channel", "stable"],
                ] {
                    let mut malformed = base.to_vec();
                    malformed.extend(suffix);
                    assert!(parse_broker(&argv(&malformed)).is_none());
                }
                let mut reordered_repair = repair.clone();
                reordered_repair.swap(12, 13);
                assert!(parse_broker(&argv(&reordered_repair)).is_none());
                let mut oversized = base;
                oversized[6] = "268435457";
                assert!(parse_broker(&argv(&oversized)).is_none());
                let mut bad_channel = base;
                bad_channel[8] = "production";
                assert!(parse_broker(&argv(&bad_channel)).is_none());
                let mut bad_home = base;
                bad_home[2] = "..\\relative";
                assert!(parse_broker(&argv(&bad_home)).is_none());
                assert!(parse_broker(&argv(&["--setup-handoff-v2", "capability", "--update"])).is_none());
            }

            #[test]
            fn child_rejects_extra_and_reordered_arguments() {
                let id = "12345678-1234-1234-1234-123456789abc";
                let args = ["--setup-handoff-child-v2", "--lease-token", id, "--home",
                    "C:\\Users\\owner\\youtab", "--update", "--channel", "pilot"];
                assert_eq!(parse_child(&argv(&args)).unwrap().3, StageMode::Update);
                assert_eq!(StageMode::Update.child_flag(), "--update");
                let mut repair = args;
                repair[5] = "--repair";
                assert_eq!(parse_child(&argv(&repair)).unwrap().3, StageMode::Repair);
                assert_eq!(StageMode::Repair.child_flag(), "--repair");
                let mut extra = args.to_vec();
                extra.push("--migrate-legacy");
                assert!(parse_child(&argv(&extra)).is_none());
                let mut mixed = repair.to_vec();
                mixed.push("--update");
                assert!(parse_child(&argv(&mixed)).is_none());
                let mut reordered = args;
                reordered.swap(5, 6);
                assert!(parse_child(&argv(&reordered)).is_none());
                for malformed in ["--reinstall", "--mode", "--repair=1"] {
                    let mut child = repair;
                    child[5] = malformed;
                    assert!(parse_child(&argv(&child)).is_none());
                }
            }

            #[test]
            fn exit_259_child_helper() {
                if std::env::var_os("YOUTAB_TEST_EXIT_259_CHILD").as_deref() == Some(std::ffi::OsStr::new("1")) {
                    std::process::exit(259);
                }
            }

            #[test]
            fn exited_process_with_code_259_is_not_a_live_owner() {
                let mut child = Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "update_coordination::native::handoff_v2::tests::exit_259_child_helper"])
                    .env("YOUTAB_TEST_EXIT_259_CHILD", "1")
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                    .spawn().unwrap();
                let pid = child.id();
                let created = process_created_at(child.as_raw_handle() as HANDLE).unwrap();
                assert_eq!(child.wait().unwrap().code(), Some(259));
                // Retaining Child keeps its process handle queryable after exit.
                assert_eq!(super::super::alive(pid), Ok(false));
                assert_eq!(process_gone(pid, &created), Ok(true));
            }

            #[test]
            fn journal_recovers_previous_durable_record_after_torn_slot() {
                let fixture = super::super::tests::relocation_fixture();
                let path = fixture.path().join("journal-fixture");
                let mut file = OpenOptions::new().read(true).write(true).create_new(true)
                    .open(path).unwrap();
                let mut journal = Journal { stage_id: "12345678-1234-1234-1234-123456789abc".into(),
                    sha256: "a".repeat(64), source_sha: "b".repeat(40), size: 10,
                    state: "allocating".into(), pid: None, created_at: None, volume: 0, file_index: 0 };
                write_journal(&mut file, &journal).unwrap();
                file.seek(SeekFrom::Start(JOURNAL_SLOT as u64)).unwrap();
                file.write_all(b"torn-next-slot").unwrap();
                file.sync_all().unwrap();
                assert_eq!(read_journal(&file).unwrap().state, "allocating");
                journal.state = "staged".into();
                write_journal(&mut file, &journal).unwrap();
                assert_eq!(read_journal(&file).unwrap().state, "staged");
            }

            #[test]
            fn reap_removes_only_identity_matched_completed_stage() {
                let fixture = super::super::tests::relocation_fixture();
                let ids = identities().unwrap();
                let (_home, cache, _lock) = open_cache(fixture.path(), &ids).unwrap();
                let id = "12345678-1234-1234-1234-123456789abc";
                let (stage_path, journal_path) = stage_paths(&cache.home, id);
                let body = b"disposable-stage-fixture";
                std::fs::write(&stage_path, body).unwrap();
                let stage = open_owned_for_delete(&stage_path, &ids).unwrap();
                let stage_identity = identity(&stage, false, false).unwrap();
                drop(stage);
                let mut journal_file = OpenOptions::new().read(true).write(true).create_new(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&journal_path).unwrap();
                let journal = Journal { stage_id: id.into(), sha256: format!("{:x}", Sha256::digest(body)),
                    source_sha: "a".repeat(40), size: body.len() as u64, state: "staged".into(),
                    pid: None, created_at: None, volume: stage_identity.0, file_index: stage_identity.1 };
                write_journal(&mut journal_file, &journal).unwrap();
                drop(journal_file);
                assert_eq!(reap(&cache, &ids).unwrap(), (0, 0));
                assert!(!stage_path.exists());
                assert!(!journal_path.exists());

                let tampered_id = "12345678-1234-1234-1234-123456789abd";
                let (tampered_stage, tampered_journal) = stage_paths(&cache.home, tampered_id);
                std::fs::write(&tampered_stage, body).unwrap();
                let stage = open_owned_for_delete(&tampered_stage, &ids).unwrap();
                let changed_identity = identity(&stage, false, false).unwrap();
                drop(stage);
                let mut record = OpenOptions::new().read(true).write(true).create_new(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&tampered_journal).unwrap();
                let bad = Journal { stage_id: tampered_id.into(), sha256: "0".repeat(64),
                    source_sha: "a".repeat(40), size: body.len() as u64, state: "staged".into(),
                    pid: None, created_at: None, volume: changed_identity.0,
                    file_index: changed_identity.1 };
                write_journal(&mut record, &bad).unwrap();
                drop(record);
                assert_eq!(reap(&cache, &ids), Err("cache-unavailable"));
                assert!(tampered_stage.exists());
                assert!(tampered_journal.exists());
            }

            #[test]
            fn legacy_cache_does_not_block_v2_or_get_deleted_without_ownership() {
                let fixture = super::super::tests::relocation_fixture();
                let ids = identities().unwrap();
                let (_home, cache, _lock) = open_cache(fixture.path(), &ids).unwrap();
                for index in 0..130 {
                    let legacy = cache.home.join(format!("Youtab-Setup-{}-{index:032x}.exe", "a".repeat(40)));
                    std::fs::write(legacy, b"legacy-file-without-lease").unwrap();
                }
                assert_eq!(reap(&cache, &ids).unwrap(), (0, 0));
                assert_eq!(std::fs::read_dir(&cache.home).unwrap().count(), 131);
            }

            #[test]
            fn cache_lock_and_child_lease_prevent_concurrent_reaping() {
                let fixture = super::super::tests::relocation_fixture();
                let ids = identities().unwrap();
                let (_home, cache, cache_lock) = open_cache(fixture.path(), &ids).unwrap();
                assert!(open_cache(fixture.path(), &ids).is_err());
                assert!(open_cache(fixture.path(), &ids).is_err());

                let id = "12345678-1234-1234-1234-123456789abc";
                let (stage_path, journal_path) = stage_paths(&cache.home, id);
                let body = b"held-stage-fixture";
                std::fs::write(&stage_path, body).unwrap();
                let stage = open_owned_for_delete(&stage_path, &ids).unwrap();
                let stage_identity = identity(&stage, false, false).unwrap();
                drop(stage);
                let mut lease = OpenOptions::new().read(true).write(true).create_new(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&journal_path).unwrap();
                write_journal(&mut lease, &Journal {
                    stage_id: id.into(), sha256: format!("{:x}", Sha256::digest(body)),
                    source_sha: "a".repeat(40), size: body.len() as u64,
                    state: "staged".into(), pid: None, created_at: None,
                    volume: stage_identity.0, file_index: stage_identity.1,
                }).unwrap();
                assert_eq!(reap(&cache, &ids).unwrap(), (1, MAX_SETUP));
                assert!(stage_path.exists());
                drop(lease);
                assert_eq!(reap(&cache, &ids).unwrap(), (0, 0));
                assert!(!stage_path.exists());
                drop(cache_lock);
                assert!(open_cache(fixture.path(), &ids).is_ok());
            }

            #[test]
            fn crashed_launch_without_confirmed_child_identity_is_retained() {
                let fixture = super::super::tests::relocation_fixture();
                let ids = identities().unwrap();
                let (_home, cache, _lock) = open_cache(fixture.path(), &ids).unwrap();
                let id = "12345678-1234-1234-1234-123456789abc";
                let (stage_path, journal_path) = stage_paths(&cache.home, id);
                let body = b"unconfirmed-child-fixture";
                std::fs::write(&stage_path, body).unwrap();
                let stage = open_owned_for_delete(&stage_path, &ids).unwrap();
                let stage_identity = identity(&stage, false, false).unwrap();
                drop(stage);
                let mut journal = OpenOptions::new().read(true).write(true).create_new(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&journal_path).unwrap();
                write_journal(&mut journal, &Journal {
                    stage_id: id.into(), sha256: format!("{:x}", Sha256::digest(body)),
                    source_sha: "a".repeat(40), size: body.len() as u64,
                    state: "launching".into(), pid: None, created_at: None,
                    volume: stage_identity.0, file_index: stage_identity.1,
                }).unwrap();
                drop(journal);
                assert_eq!(reap(&cache, &ids).unwrap(), (1, body.len() as u64));
                assert!(stage_path.exists());
                assert!(journal_path.exists());
            }

            #[test]
            fn linked_stage_is_rejected_without_deleting_other_link() {
                let fixture = super::super::tests::relocation_fixture();
                let ids = identities().unwrap();
                let (_home, cache, _lock) = open_cache(fixture.path(), &ids).unwrap();
                let id = "12345678-1234-1234-1234-123456789abc";
                let (stage_path, journal_path) = stage_paths(&cache.home, id);
                let other = cache.home.join("other-owned-file");
                let body = b"linked-stage-fixture";
                std::fs::write(&other, body).unwrap();
                std::fs::hard_link(&other, &stage_path).unwrap();
                let mut journal = OpenOptions::new().read(true).write(true).create_new(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&journal_path).unwrap();
                write_journal(&mut journal, &Journal {
                    stage_id: id.into(), sha256: format!("{:x}", Sha256::digest(body)),
                    source_sha: "a".repeat(40), size: body.len() as u64,
                    state: "staged".into(), pid: None, created_at: None,
                    volume: 0, file_index: 0,
                }).unwrap();
                drop(journal);
                assert!(reap(&cache, &ids).is_err());
                assert_eq!(std::fs::read(&other).unwrap(), body);
                assert!(stage_path.exists());
                assert!(journal_path.exists());
            }
        }
    }

    #[cfg(test)]
    pub(crate) mod tests {
        use super::*;
        // These tests change only a fresh owned fixture's DACL. Production
        // coordinate/inspect never calls SetSecurityInfo or changes any ACL.
        fn fixture_acl(path: &Path, ids: &Identities, additional: &str) -> File {
            use Security::Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SetSecurityInfo, SDDL_REVISION_1,
            };
            let file = OpenOptions::new()
                .access_mode(READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .unwrap();
            unsafe {
                let mut sid_text = ptr::null_mut();
                assert_ne!(
                    ConvertSidToStringSidW(pointer(&ids.current), &mut sid_text),
                    0
                );
                let mut length = 0;
                while *sid_text.add(length) != 0 {
                    length += 1;
                }
                let sid = String::from_utf16(std::slice::from_raw_parts(sid_text, length)).unwrap();
                LocalFree(sid_text as _);
                let sddl =
                    format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA){additional}");
                let text: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
                let mut raw = ptr::null_mut();
                assert_ne!(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        text.as_ptr(),
                        SDDL_REVISION_1,
                        &mut raw,
                        ptr::null_mut()
                    ),
                    0
                );
                let descriptor = Descriptor(raw);
                let mut present = 0;
                let mut defaulted = 0;
                let mut acl = ptr::null_mut();
                assert_ne!(
                    Security::GetSecurityDescriptorDacl(
                        descriptor.0,
                        &mut present,
                        &mut acl,
                        &mut defaulted
                    ),
                    0
                );
                assert_eq!(
                    SetSecurityInfo(
                        file.as_raw_handle() as _,
                        SE_FILE_OBJECT,
                        Security::DACL_SECURITY_INFORMATION
                            | Security::PROTECTED_DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        acl,
                        ptr::null()
                    ),
                    0
                );
            }
            file
        }

        pub(crate) fn relocation_fixture() -> tempfile::TempDir {
            let qa_root = std::env::var_os("YOUTAB_NATIVE_PRIVATE_QA_ROOT")
                .map(PathBuf::from).expect("explicit qualified disposable QA parent required");
            let qa_root = qa_root.canonicalize().unwrap();
            assert!(!std::fs::symlink_metadata(&qa_root).unwrap().file_type().is_symlink());
            let prefix = format!("relocation-{}-", uuid::Uuid::new_v4());
            let root = tempfile::Builder::new().prefix(&prefix).tempdir_in(&qa_root).unwrap();
            assert_eq!(root.path().canonicalize().unwrap().parent().unwrap(), qa_root);
            drop(fixture_acl(root.path(), &identities().unwrap(), ""));
            root
        }

        fn code_fixture() -> tempfile::TempDir {
            let qa_root = std::env::var_os("YOUTAB_NATIVE_PRIVATE_QA_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let root = tempfile::Builder::new()
                .prefix("code-admission-")
                .tempdir_in(qa_root)
                .unwrap();
            drop(fixture_acl(root.path(), &identities().unwrap(), ""));
            root
        }

        fn packaged_desktop_fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
            let root = code_fixture();
            let desktop = root.path().join("youtab-agent-runtime/apps/desktop/release/win-unpacked");
            let resources = desktop.join("resources");
            let stamp = resources.join("install-stamp.json");
            let addon = resources.join("app.asar.unpacked/dist/native/setup_lease.node");
            std::fs::create_dir_all(addon.parent().unwrap()).unwrap();
            std::fs::write(desktop.join("Youtab.exe"), b"synthetic executable; never launched").unwrap();
            std::fs::write(resources.join("app.asar"), b"synthetic archive").unwrap();
            std::fs::write(&stamp, b"synthetic stamp").unwrap();
            std::fs::write(&addon, b"synthetic native addon; never loaded").unwrap();
            (root, desktop, stamp, addon)
        }

        #[test]
        fn packaged_desktop_admission_covers_native_addon_and_install_stamp() {
            let (root, desktop, stamp, addon) = packaged_desktop_fixture();
            let ids = identities().unwrap();
            let namespace = crate::update_coordination::admit_private_code_namespace(root.path()).unwrap();
            assert!(namespace.admit_existing_code_tree(&desktop).unwrap().is_some());

            drop(fixture_acl(&addon, &ids, "(A;;FW;;;AU)"));
            assert!(matches!(namespace.admit_existing_code_tree(&desktop), Err("unsafe-home")),
                "foreign-writable native addon must block the entire Desktop tree");
            drop(fixture_acl(&addon, &ids, ""));
            assert!(namespace.admit_existing_code_tree(&desktop).unwrap().is_some());

            drop(fixture_acl(&stamp, &ids, "(A;;FW;;;AU)"));
            assert!(matches!(namespace.admit_existing_code_tree(&desktop), Err("unsafe-home")),
                "foreign-writable install stamp must block the entire Desktop tree");
        }

        #[test]
        fn packaged_desktop_rejects_inherit_only_foreign_write_on_resources() {
            let (root, desktop, _stamp, _addon) = packaged_desktop_fixture();
            let ids = identities().unwrap();
            let namespace = crate::update_coordination::admit_private_code_namespace(root.path()).unwrap();
            assert!(namespace.admit_existing_code_tree(&desktop).unwrap().is_some());

            let resources = desktop.join("resources");
            drop(fixture_acl(&resources, &ids, "(A;OICIIO;FW;;;AU)"));
            let inherited = resources.join("new-native-addon.node");
            std::fs::write(&inherited, b"synthetic newly inherited code").unwrap();
            assert!(matches!(optional_leaf(&inherited, &ids), Err("unsafe-home")),
                "test must verify that the child really inherited foreign mutation rights");
            assert!(matches!(namespace.admit_existing_code_tree(&desktop), Err("unsafe-home")),
                "inheritable foreign write below the Desktop executable must fail admission");
        }

        #[test]
        fn packaged_desktop_rejects_native_addon_junction() {
            use std::os::windows::fs::MetadataExt;
            use std::os::windows::process::CommandExt;
            let root = code_fixture();
            let desktop = root.path().join("youtab-agent-runtime/apps/desktop/release/win-unpacked");
            let resources = desktop.join("resources");
            let unpacked = resources.join("app.asar.unpacked");
            let outside = root.path().join("external-addon");
            std::fs::create_dir_all(&resources).unwrap();
            std::fs::create_dir_all(outside.join("dist/native")).unwrap();
            std::fs::write(desktop.join("Youtab.exe"), b"synthetic executable; never launched").unwrap();
            std::fs::write(resources.join("install-stamp.json"), b"synthetic stamp").unwrap();
            std::fs::write(outside.join("dist/native/setup_lease.node"), b"synthetic addon").unwrap();
            let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
            for path in [&unpacked, &outside] {
                assert!(!path.to_str().unwrap().chars().any(|c| "\"&|<>^%!\r\n".contains(c)));
            }
            let command = format!("\"mklink /J \"{}\" \"{}\"\"", unpacked.display(), outside.display());
            let output = std::process::Command::new(system.join(r"System32\cmd.exe"))
                .args(["/d", "/s", "/c"])
                .raw_arg(&command)
                .output().unwrap();
            assert!(output.status.success(), "owned fixture junction creation failed: {}",
                String::from_utf8_lossy(&output.stderr));
            assert_ne!(std::fs::symlink_metadata(&unpacked).unwrap().file_attributes()
                & FILE_ATTRIBUTE_REPARSE_POINT, 0);
            let namespace = crate::update_coordination::admit_private_code_namespace(root.path()).unwrap();
            assert!(matches!(namespace.admit_existing_code_tree(&desktop), Err("unsafe-object")),
                "native addon reparse path must not redirect Desktop tree admission");
        }

        #[test]
        fn existing_code_leaf_foreign_write_is_refused() {
            let root = code_fixture();
            let ids = identities().unwrap();
            let bin = root.path().join("bin");
            std::fs::create_dir(&bin).unwrap();
            let exe = bin.join("uv.exe");
            std::fs::write(&exe, b"synthetic-code").unwrap();
            let namespace =
                crate::update_coordination::admit_private_code_namespace(root.path()).unwrap();
            assert!(namespace.admit_existing_code_tree(&bin).unwrap().is_some());
            drop(fixture_acl(&exe, &ids, "(A;;FW;;;AU)"));
            assert!(matches!(
                namespace.admit_existing_code_tree(&bin),
                Err("unsafe-home")
            ));
        }

        #[test]
        fn admitted_code_aliases_share_permission_denial() {
            let root = code_fixture();
            let ids = identities().unwrap();
            let bin = root.path().join("bin");
            std::fs::create_dir(&bin).unwrap();
            let exe = bin.join("uv.exe");
            let alias = root.path().join("cache-alias.exe");
            std::fs::write(&exe, b"synthetic-code").unwrap();
            std::fs::hard_link(&exe, &alias).unwrap();
            let namespace =
                crate::update_coordination::admit_private_code_namespace(root.path()).unwrap();
            assert!(namespace.admit_existing_code_tree(&bin).unwrap().is_some());
            let original = File::open(&exe).unwrap();
            let cached = File::open(&alias).unwrap();
            assert!(
                code_identity(&original, false).unwrap() == code_identity(&cached, false).unwrap()
            );
            drop(fixture_acl(&alias, &ids, "(A;;FW;;;AU)"));
            assert!(matches!(
                namespace.admit_existing_code_tree(&bin),
                Err("unsafe-home")
            ));
        }

        #[test]
        fn private_namespace_pins_home_and_ancestor_without_descendant_files() {
            let root = code_fixture();
            let home = root.path().join("empty-home");
            let renamed_home = root.path().join("renamed-home");
            std::fs::create_dir(&home).unwrap();
            let root_parent = root.path().parent().unwrap();
            let renamed_root = root_parent.join(format!("{}.renamed", root.path().file_name().unwrap().to_string_lossy()));
            let namespace = crate::update_coordination::admit_private_code_namespace(&home).unwrap();
            assert!(std::fs::rename(&home, &renamed_home).is_err(), "actual home must remain pinned");
            assert!(std::fs::rename(root.path(), &renamed_root).is_err(), "actual ancestor must remain pinned");
            namespace.revalidate().unwrap();
            drop(namespace);
            std::fs::rename(&home, &renamed_home).unwrap();
            std::fs::rename(&renamed_home, &home).unwrap();
            std::fs::rename(root.path(), &renamed_root).unwrap();
            std::fs::rename(&renamed_root, root.path()).unwrap();
        }

        #[test]
        fn metadata_only_directory_handle_does_not_pin_rename() {
            let root = code_fixture();
            let staged = root.path().join("metadata-only");
            let renamed = root.path().join("metadata-only-renamed");
            std::fs::create_dir(&staged).unwrap();
            let metadata = OpenOptions::new()
                .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&staged)
                .unwrap();
            // Negative control for the reproduced metadata-only sharing defect.
            std::fs::rename(&staged, &renamed).unwrap();
            assert!(code_identity(&metadata, true).is_ok());
            assert!(renamed.is_dir());
        }

        #[test]
        fn code_directory_handles_are_released_before_authorized_promotion() {
            let root = code_fixture();
            let staged = root.path().join("staged");
            let promoted = root.path().join("promoted");
            std::fs::create_dir(&staged).unwrap();
            std::fs::write(staged.join("code.exe"), b"unchanged-code").unwrap();
            let namespace =
                crate::update_coordination::admit_private_code_namespace(root.path()).unwrap();
            let code = namespace
                .admit_existing_code_tree(&staged)
                .unwrap()
                .unwrap();
            assert!(std::fs::rename(&staged, &promoted).is_err());
            code.revalidate().unwrap();
            drop(code);
            namespace.revalidate().unwrap();
            std::fs::rename(&staged, &promoted).unwrap();
            assert_eq!(
                std::fs::read(promoted.join("code.exe")).unwrap(),
                b"unchanged-code"
            );
        }

        #[test]
        fn code_home_rejects_inherit_only_foreign_file_write() {
            let qa_root = std::env::var_os("YOUTAB_NATIVE_PRIVATE_QA_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let root = tempfile::Builder::new()
                .prefix("code-inheritance-")
                .tempdir_in(qa_root)
                .unwrap();
            let ids = identities().unwrap();
            drop(fixture_acl(root.path(), &ids, ""));
            assert!(
                crate::update_coordination::admit_private_code_namespace(root.path()).is_ok(),
                "fresh owned private fixture must be admitted before injecting foreign inheritance"
            );
            let directory = fixture_acl(root.path(), &ids, "(A;OIIO;FW;;;AU)");
            let child = root.path().join("code.exe");
            std::fs::write(&child, b"synthetic-code-bytes").unwrap();
            assert!(
                matches!(optional_leaf(&child, &ids), Err("unsafe-home")),
                "real inherited child ACL must actually grant foreign file mutation"
            );
            assert!(crate::update_coordination::admit_private_code_namespace(root.path()).is_err(),
                "private code home must refuse a policy that makes fresh executable children foreign-writable");
            drop(directory);
        }
        #[test]
        fn real_authenticated_users_modify_is_refused_and_read_is_accepted() {
            let root = tempfile::tempdir().unwrap();
            let ids = identities().unwrap();
            let read = fixture_acl(root.path(), &ids, "(A;;FRFX;;;AU)");
            assert!(admit(&read, &ids, true).is_ok());
            drop(read);
            let modify = fixture_acl(root.path(), &ids, "(A;;0x1301bf;;;AU)");
            assert!(matches!(admit(&modify, &ids, true), Err("unsafe-home")));
        }
        #[test]
        fn real_ancestor_create_child_is_allowed_but_delete_child_is_not() {
            let root = tempfile::tempdir().unwrap();
            let ids = identities().unwrap();
            let create = fixture_acl(root.path(), &ids, "(A;;0x4;;;AU)");
            assert!(admit(&create, &ids, false).is_ok());
            assert!(matches!(admit(&create, &ids, true), Err("unsafe-home")));
            drop(create);
            let replace = fixture_acl(root.path(), &ids, "(A;;0x40;;;AU)");
            assert!(matches!(admit(&replace, &ids, false), Err("unsafe-home")));
        }
        #[test]
        fn ancestor_create_rights_are_distinct_from_home_mutation() {
            assert_eq!(
                mutation_mask(false) & (FILE_WRITE_DATA | FILE_APPEND_DATA),
                0
            );
            assert_ne!(
                mutation_mask(true) & (FILE_WRITE_DATA | FILE_APPEND_DATA),
                0
            );
            assert_ne!(mutation_mask(false) & FILE_DELETE_CHILD, 0);
            assert_ne!(mutation_mask(false) & WRITE_DAC, 0);
        }
        #[test]
        fn hardlinked_hint_is_refused_without_reading_victim() {
            let root = tempfile::tempdir().unwrap();
            let victim = root.path().join("victim");
            let leaf = root.path().join("marker");
            std::fs::write(&victim, "private-content").unwrap();
            std::fs::hard_link(&victim, &leaf).unwrap();
            assert!(matches!(
                optional_leaf(&leaf, &identities().unwrap()),
                Err("unsafe-object")
            ));
            assert_eq!(std::fs::read_to_string(victim).unwrap(), "private-content");
        }
        #[test]
        fn inspect_never_creates_missing_coordination_file() {
            let root = tempfile::tempdir().unwrap();
            let leaf = root.path().join("absent.install-lock");
            assert!(optional_leaf(&leaf, &identities().unwrap())
                .unwrap()
                .is_none());
            assert!(!leaf.exists());
        }
        #[test]
        fn exclusive_sidecar_contention_is_closed_before_any_hint() {
            let root = tempfile::tempdir().unwrap();
            let leaf = root.path().join("lock");
            let held = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .share_mode(0)
                .open(&leaf)
                .unwrap();
            assert!(matches!(
                optional_leaf(&leaf, &identities().unwrap()),
                Err("coordination-unavailable")
            ));
            drop(held);
        }
        #[test]
        fn live_process_with_invalid_or_future_time_stays_closed() {
            let root = tempfile::tempdir().unwrap();
            for (index, time) in ["broken", "101", "100suffix"].iter().enumerate() {
                let path = root.path().join(index.to_string());
                std::fs::write(&path, format!("{}\n{time}\n", std::process::id())).unwrap();
                assert!(matches!(
                    hint(Some(File::open(path).unwrap()), None, 100),
                    Err("marker-unverifiable")
                ));
            }
        }
        #[test]
        fn oversize_hint_is_bounded_and_not_pruned() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("marker");
            std::fs::write(&path, vec![b'1'; 4097]).unwrap();
            assert!(matches!(
                hint(Some(File::open(&path).unwrap()), None, 100),
                Err("marker-unverifiable")
            ));
            assert_eq!(std::fs::metadata(path).unwrap().len(), 4097);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(text: &[&str]) -> Vec<OsString> {
        text.iter().map(OsString::from).collect()
    }
    #[test]
    fn numbers_require_complete_positive_decimal() {
        for value in [
            "",
            "0",
            "-1",
            "+1",
            "1suffix",
            "1.0",
            "18446744073709551616",
        ] {
            assert_eq!(positive_integer(value), None);
        }
        assert_eq!(positive_integer("42"), Some(42));
    }
    #[test]
    fn protocol_rejects_extra_missing_and_unrelated_arguments() {
        assert!(matches!(
            parse(&args(&[FLAG, "capability"])),
            Some(Request::Capability)
        ));
        assert!(parse(&args(&[FLAG, "capability", "--update"])).is_none());
        assert!(parse(&args(&[FLAG, "inspect", "--home", "relative"])).is_none());
        assert!(parse(&args(&[FLAG, "publish"])).is_none());
    }
    #[test]
    fn stage_identifier_cannot_inject_paths() {
        assert!(valid_instance("12345678-1234-1234-1234-123456789abc"));
        for value in [
            "../victim",
            "12345678-1234-1234-1234-123456789abC",
            "12345678/1234-1234-1234-123456789abc",
        ] {
            assert!(!valid_instance(value));
        }
    }
    #[test]
    fn public_outcome_contains_no_path_or_marker_body() {
        let json = serde_json::to_string(&outcome("blocked", "unsafe-home")).unwrap();
        assert_eq!(json, "{\"protocol\":\"youtab.update-coordination\",\"version\":1,\"status\":\"blocked\",\"reason\":\"unsafe-home\"}");
    }
}

#[cfg(all(test, windows))]
pub(crate) fn relocation_test_fixture() -> tempfile::TempDir {
    native::tests::relocation_fixture()
}
