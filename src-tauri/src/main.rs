// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// In dev mode on Windows the app has no Start Menu registration, so the OS
/// attributes toast notifications to the parent process (PowerShell/cmd).
/// This function sets the AUMID on the current process and writes a minimal
/// registry entry so notifications show "HexField" as the sender.
#[cfg(all(debug_assertions, target_os = "windows"))]
fn register_dev_aumid() {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    const AUMID: &str = "com.hexfield.app";
    const APP_NAME: &str = "HexField";

    unsafe {
        // Mark this process as our app so WinRT ToastNotification uses our identity.
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID));

        // Register the AUMID in HKCU with a friendly display name.
        // Without this entry Windows can't resolve the display name and shows
        // the raw identifier string instead of "HexField".
        let key_path = format!("Software\\Classes\\AppUserModelId\\{AUMID}");
        let mut hkey = HKEY::default();
        if RegCreateKeyW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key_path.as_str()),
            &mut hkey,
        )
        .is_ok()
        {
            let name_utf16: Vec<u16> =
                APP_NAME.encode_utf16().chain(std::iter::once(0)).collect();
            let _ = RegSetValueExW(
                hkey,
                &HSTRING::from("DisplayName"),
                None,
                REG_SZ,
                Some(std::slice::from_raw_parts(
                    name_utf16.as_ptr() as *const u8,
                    name_utf16.len() * 2,
                )),
            );
            let _ = RegCloseKey(hkey);
        }
    }
}

fn main() {
    #[cfg(all(debug_assertions, target_os = "windows"))]
    register_dev_aumid();

    // Capture panics to a crash file so release builds leave evidence.
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        let path = std::env::var("APPDATA")
            .map(|d| std::path::PathBuf::from(d).join("com.hexfield.app").join("crash.txt"))
            .unwrap_or_else(|_| std::path::PathBuf::from("hexfield_crash.txt"));
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(&path, &msg);
        eprintln!("PANIC: {msg}");
    }));

    hexfield_lib::run()
}
