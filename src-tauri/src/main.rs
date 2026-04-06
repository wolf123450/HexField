// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
