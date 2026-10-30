//! Ensure a missing WebView2 Runtime is provisioned before Tauri creates a webview.
//!
//! Microsoft's Evergreen x64 standalone installer is embedded in the one
//! Youtab-Setup.exe. It runs only when the runtime is absent.

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
const WEBVIEW_STANDALONE: &[u8] = include_bytes!("../assets/MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
#[cfg(windows)]
const STANDALONE_SHA256: &str =
    "f9d45cf7bef9576d6df50c7a7525e0bc8c26b6c3bc2c667b494aafb062a35b6f";
#[cfg(windows)]
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
#[cfg(windows)]
const REGISTRY_SETTLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[cfg(windows)]
const WEBVIEW_CLIENT: &str =
    "Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn installed_version(
    root: windows_sys::Win32::System::Registry::HKEY,
    path: &str,
) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_SZ,
    };

    let mut key: HKEY = std::ptr::null_mut();
    let path = wide(path);
    // SAFETY: All pointers reference live, NUL-terminated buffers and key is
    // closed before the function returns.
    if unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return None;
    }
    let name = wide("pv");
    let mut kind = 0;
    let mut length = 0u32;
    let query = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut length,
        )
    };
    if query != 0 || kind != REG_SZ || length == 0 || length > 512 || length % 2 != 0 {
        unsafe { RegCloseKey(key) };
        return None;
    }
    let mut value = vec![0u16; length as usize / 2];
    let read = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            value.as_mut_ptr().cast::<u8>(),
            &mut length,
        )
    };
    unsafe { RegCloseKey(key) };
    if read != 0 || kind != REG_SZ {
        return None;
    }
    let end = value.iter().position(|c| *c == 0).unwrap_or(value.len());
    let version = String::from_utf16(&value[..end]).ok()?;
    if valid_version(&version) {
        Some(version)
    } else {
        None
    }
}

#[cfg(windows)]
fn valid_version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
        && parts.iter().any(|part| part.bytes().any(|c| c != b'0'))
}

#[cfg(windows)]
fn runtime_installed() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let user = format!("Software\\{WEBVIEW_CLIENT}");
    let machine = format!("SOFTWARE\\WOW6432Node\\{WEBVIEW_CLIENT}");
    installed_version(HKEY_CURRENT_USER, &user).is_some()
        || installed_version(HKEY_LOCAL_MACHINE, &machine).is_some()
}

#[cfg(windows)]
fn standalone_integrity() -> bool {
    expected_standalone_hash(WEBVIEW_STANDALONE)
}

#[cfg(windows)]
fn expected_standalone_hash(bytes: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes)) == STANDALONE_SHA256
}

#[cfg(windows)]
fn install_runtime() -> Result<(), &'static str> {
    use std::io::Read;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    if !standalone_integrity() {
        return Err("The bundled Microsoft WebView2 prerequisite failed its integrity check.");
    }
    // Never stage executable code in %TEMP%: a caller can redirect it to a
    // shared location. The existing private-namespace admission checks the
    // profile owner, DACL, ancestor identities and reparse points.
    let profile = dirs::home_dir().ok_or("Setup could not identify a private user profile.")?;
    let profile_guard = crate::update_coordination::admit_private_code_namespace(&profile)
        .map_err(|_| "Setup could not verify a private prerequisite location.")?;
    let directory = tempfile::Builder::new()
        .prefix(".youtab-webview-")
        .tempdir_in(&profile)
        .map_err(|_| "Setup could not create a private prerequisite directory.")?;
    let directory_guard =
        crate::update_coordination::admit_private_code_namespace(directory.path())
            .map_err(|_| "Setup could not verify the prerequisite directory.")?;
    let path = directory.path().join("MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
    std::fs::write(&path, WEBVIEW_STANDALONE)
        .map_err(|_| "Setup could not prepare the Microsoft WebView2 prerequisite.")?;
    // Admit the extracted file's identity and effective ACL, then hold an
    // exclusive-against-write/delete handle until the launched process exits.
    let file_guard = directory_guard
        .admit_existing_code_tree(&path)
        .map_err(|_| "Setup could not admit the Microsoft prerequisite file.")?
        .ok_or("Setup could not find the Microsoft prerequisite file.")?;
    let mut pinned = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|_| "Setup could not pin the Microsoft prerequisite file.")?;
    if pinned
        .metadata()
        .map_err(|_| "Setup could not inspect the Microsoft prerequisite file.")?
        .len()
        != WEBVIEW_STANDALONE.len() as u64
    {
        return Err("The Microsoft WebView2 prerequisite size changed before installation.");
    }
    // Hash the pinned file in bounded chunks. The embedded runtime is over
    // 200 MiB; duplicating it in a Vec would waste customer memory.
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    let mut block = [0u8; 1024 * 1024];
    loop {
        let count = pinned.read(&mut block)
            .map_err(|_| "Setup could not verify the Microsoft WebView2 prerequisite.")?;
        if count == 0 { break; }
        digest.update(&block[..count]);
    }
    if format!("{:x}", digest.finalize()) != STANDALONE_SHA256 {
        return Err("The Microsoft WebView2 prerequisite changed before installation.");
    }
    file_guard
        .revalidate()
        .map_err(|_| "The Microsoft WebView2 prerequisite location changed.")?;
    directory_guard
        .revalidate()
        .map_err(|_| "The Microsoft WebView2 prerequisite directory changed.")?;
    profile_guard
        .revalidate()
        .map_err(|_| "The Windows user profile changed during prerequisite setup.")?;
    let mut child = std::process::Command::new(&path)
        .args(["/silent", "/install"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|_| "Setup could not start the Microsoft WebView2 prerequisite.")?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                if runtime_installed() {
                    return Ok(());
                }
                return Err("Microsoft WebView2 installation failed. Contact your IT administrator or install WebView2 from Microsoft, then retry Youtab Setup.");
            }
            Ok(None) if start.elapsed() < INSTALL_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(250))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Microsoft WebView2 installation timed out and may still be finishing in the background. Wait for it to finish, then retry Youtab Setup.");
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Setup could not confirm the Microsoft WebView2 prerequisite result.");
            }
        }
    }
    let settle = Instant::now();
    while settle.elapsed() < REGISTRY_SETTLE_TIMEOUT {
        if runtime_installed() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("Microsoft WebView2 did not become available. It may still be installing in the background. Wait, then retry Youtab Setup or contact your IT administrator.")
}

#[cfg(windows)]
pub(crate) fn ensure_before_tauri() -> bool {
    if runtime_installed() {
        return true;
    }
    tracing::info!("Microsoft WebView2 Runtime missing; installing bundled offline prerequisite");
    match install_with_status() {
        Ok(()) => true,
        Err(message) => {
            tracing::error!("WebView2 prerequisite failed: {message}");
            show_error(message);
            false
        }
    }
}

#[cfg(windows)]
fn install_with_status() -> Result<(), &'static str> {
    use std::sync::mpsc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, EnableMenuItem, GetSystemMenu,
        GetSystemMetrics, PeekMessageW, ShowWindow, TranslateMessage, MF_BYCOMMAND, MF_GRAYED, MSG,
        PM_REMOVE, SC_CLOSE, SM_CXSCREEN, SM_CYSCREEN, SW_SHOW, WS_CAPTION, WS_CHILD,
        WS_EX_TOPMOST, WS_OVERLAPPED, WS_SYSMENU, WS_VISIBLE,
    };

    const WIDTH: i32 = 520;
    const HEIGHT: i32 = 155;
    let class = wide("STATIC");
    let title = wide("Youtab Setup - preparing Windows");
    let details =
        wide("Installing Microsoft WebView2. Please wait; this can take several minutes.");
    // SAFETY: STATIC is a built-in Windows window class. All strings are
    // NUL-terminated and remain alive through CreateWindowExW calls.
    let status = unsafe {
        let x = (GetSystemMetrics(SM_CXSCREEN) - WIDTH) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - HEIGHT) / 2;
        let window = CreateWindowExW(
            WS_EX_TOPMOST,
            class.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
            x,
            y,
            WIDTH,
            HEIGHT,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        if !window.is_null() {
            let _text = CreateWindowExW(
                0,
                class.as_ptr(),
                details.as_ptr(),
                WS_CHILD | WS_VISIBLE,
                24,
                38,
                WIDTH - 48,
                55,
                window,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            let menu = GetSystemMenu(window, 0);
            if !menu.is_null() {
                EnableMenuItem(menu, SC_CLOSE, MF_BYCOMMAND | MF_GRAYED);
            }
            ShowWindow(window, SW_SHOW);
        }
        window
    };
    if status.is_null() {
        return Err("Setup could not display prerequisite progress. Please retry Youtab Setup.");
    }
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = tx.send(install_runtime());
    });
    let result = loop {
        match rx.try_recv() {
            Ok(result) => break result,
            Err(mpsc::TryRecvError::Disconnected) => {
                break Err("Microsoft WebView2 prerequisite stopped unexpectedly.")
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        // Keep the native status window responsive until the prerequisite
        // succeeds or fails.  This path runs only when WebView2 is missing.
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = worker.join();
    if !status.is_null() {
        unsafe { DestroyWindow(status) };
    }
    result
}

#[cfg(windows)]
pub(crate) fn show_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title = wide("Youtab Setup could not start");
    let message = wide(message);
    // SAFETY: Both buffers are NUL-terminated and live for the duration of the call.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_ICONERROR | MB_OK,
        )
    };
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn version_must_be_nonzero_four_part_numeric() {
        for valid in ["1.0.0.0", "155.0.4283.45"] {
            assert!(valid_version(valid));
        }
        for invalid in ["", "0.0.0.0", "0", "1.2.3", "1.2.3.4.5", "1.2.3.x"] {
            assert!(!valid_version(invalid));
        }
    }

    #[test]
    fn embedded_microsoft_standalone_has_expected_hash() {
        assert!(standalone_integrity());
        assert!(!expected_standalone_hash(&WEBVIEW_STANDALONE[1..]));
    }
}
