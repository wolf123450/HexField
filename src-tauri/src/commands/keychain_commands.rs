use keyring::{Entry, Error as KeyringError};

/// Save a secret to the OS-native credential store (Windows Credential Manager,
/// macOS Keychain, or libsecret on Linux). The `service` and `account` pair is
/// used to identify the credential; both must be non-empty.
#[tauri::command]
pub fn keychain_save(service: String, account: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

/// Load a secret from the OS-native credential store.
/// Returns `None` if no credential exists for the given service + account pair.
#[tauri::command]
pub fn keychain_load(service: String, account: String) -> Result<Option<String>, String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a credential from the OS-native credential store.
/// Returns `true` if the credential was deleted, `false` if it did not exist.
#[tauri::command]
pub fn keychain_delete(service: String, account: String) -> Result<bool, String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
