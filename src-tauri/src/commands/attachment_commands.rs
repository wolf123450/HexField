use std::path::PathBuf;
use tauri::Manager;

pub(crate) const CHUNK_SIZE: usize = 256 * 1024; // 256 KB

//  Path helpers 

fn attachments_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(base.join("attachments"))
}

/// Returns the full path for a complete attachment: attachments/{hash[0:2]}/{hash}.bin
pub(crate) fn bin_path(dir: &PathBuf, content_hash: &str) -> PathBuf {
    let prefix = &content_hash[..2.min(content_hash.len())];
    dir.join(prefix).join(format!("{}.bin", content_hash))
}

/// Returns the full path for an in-progress download: attachments/{hash[0:2]}/{hash}.part
pub(crate) fn part_path(dir: &PathBuf, content_hash: &str) -> PathBuf {
    let prefix = &content_hash[..2.min(content_hash.len())];
    dir.join(prefix).join(format!("{}.part", content_hash))
}

fn bits_path(dir: &PathBuf, content_hash: &str) -> PathBuf {
    dir.join(&content_hash[..2.min(content_hash.len())])
        .join(format!("{}.bits", content_hash))
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

//  Core logic (testable without AppHandle) 

/// Save a complete attachment in one shot (sender path).
pub(crate) fn save_attachment_to(
    dir: &PathBuf,
    content_hash: &str,
    data: &[u8],
) -> Result<(), String> {
    let prefix_dir = dir.join(&content_hash[..2.min(content_hash.len())]);
    ensure_dir(&prefix_dir)?;
    let bin = bin_path(dir, content_hash);
    if bin.exists() {
        return Ok(()); // already seeding
    }
    let tmp = bin.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &bin).map_err(|e| e.to_string())?;
    Ok(())
}

/// Write a single chunk into the `.part` buffer. Returns `true` when all chunks are received.
///
/// When all chunks arrive the assembled file's BLAKE3 is verified against `content_hash`.
/// If integrity fails, the `.part` file is deleted and an error is returned.
pub(crate) fn save_chunk_to(
    dir: &PathBuf,
    content_hash: &str,
    chunk_index: u32,
    total_chunks: u32,
    data: Vec<u8>,
) -> Result<bool, String> {
    if data.len() > CHUNK_SIZE {
        return Err(format!("chunk too large: {} bytes", data.len()));
    }
    let prefix_dir = dir.join(&content_hash[..2.min(content_hash.len())]);
    ensure_dir(&prefix_dir)?;

    let bin = bin_path(dir, content_hash);
    if bin.exists() {
        return Ok(true); // already complete
    }

    let part = part_path(dir, content_hash);
    let bits = bits_path(dir, content_hash);

    let mut bitfield: Vec<u8> = if bits.exists() {
        std::fs::read(&bits).map_err(|e| e.to_string())?
    } else {
        vec![0u8; total_chunks as usize]
    };

    if bitfield.len() < total_chunks as usize {
        bitfield.resize(total_chunks as usize, 0);
    }

    if bitfield[chunk_index as usize] == 0 {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&part)
            .map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(chunk_index as u64 * CHUNK_SIZE as u64))
            .map_err(|e| e.to_string())?;
        f.write_all(&data).map_err(|e| e.to_string())?;
        bitfield[chunk_index as usize] = 1;
        std::fs::write(&bits, &bitfield).map_err(|e| e.to_string())?;
    }

    let complete = bitfield.iter().all(|&b| b == 1);
    if complete {
        let _ = std::fs::remove_file(&bits);
        // Verify BLAKE3 integrity before finalizing
        let assembled = std::fs::read(&part).map_err(|e| e.to_string())?;
        let actual_hash = blake3::hash(&assembled).to_hex().to_string();
        if actual_hash != content_hash {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "integrity check failed: expected {}, got {}",
                content_hash, actual_hash
            ));
        }
        std::fs::rename(&part, &bin).map_err(|e| e.to_string())?;
    }
    Ok(complete)
}

/// Read a chunk from a complete attachment for seeding to a requesting peer.
pub(crate) fn read_chunk_from(
    dir: &PathBuf,
    content_hash: &str,
    chunk_index: u32,
) -> Result<Option<Vec<u8>>, String> {
    let bin = bin_path(dir, content_hash);
    if !bin.exists() {
        return Ok(None);
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&bin).map_err(|e| e.to_string())?;
    let offset = chunk_index as u64 * CHUNK_SIZE as u64;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK_SIZE];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(None);
    }
    buf.truncate(n);
    Ok(Some(buf))
}

/// Return chunk indices already received for a partial download.
pub(crate) fn get_received_chunks_from(
    dir: &PathBuf,
    content_hash: &str,
) -> Result<Vec<u32>, String> {
    if bin_path(dir, content_hash).exists() {
        return Ok(vec![]);
    }
    let bits = bits_path(dir, content_hash);
    if !bits.exists() {
        return Ok(vec![]);
    }
    let bitfield = std::fs::read(&bits).map_err(|e| e.to_string())?;
    Ok(bitfield
        .iter()
        .enumerate()
        .filter_map(|(i, &b)| if b == 1 { Some(i as u32) } else { None })
        .collect())
}

/// Delete an attachment and its sidecar files (for retention pruning).
pub(crate) fn delete_attachment_from(
    dir: &PathBuf,
    content_hash: &str,
) -> Result<(), String> {
    for p in [
        bin_path(dir, content_hash),
        part_path(dir, content_hash),
        bits_path(dir, content_hash),
    ] {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Walk the attachments directory and return total bytes consumed by `.bin` files.
pub(crate) fn total_attachment_bytes(dir: &PathBuf) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let prefix_dir = entry.path();
        if !prefix_dir.is_dir() { continue; }
        for file_entry in std::fs::read_dir(&prefix_dir).into_iter().flatten().flatten() {
            let path = file_entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("bin") {
                total += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

/// Prune oldest `.bin` attachments until total usage is under `limit_bytes`.
/// Returns content hashes of pruned files.
pub(crate) fn prune_to_limit(dir: &PathBuf, limit_bytes: u64) -> Result<Vec<String>, String> {
    // Collect (mtime, hash, size) for all .bin files, sorted oldest-first
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };

    let mut files: Vec<(std::time::SystemTime, String, u64)> = Vec::new();
    for entry in entries.flatten() {
        let prefix = entry.path();
        if !prefix.is_dir() { continue; }
        for f in std::fs::read_dir(&prefix).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().and_then(|s| s.to_str()) != Some("bin") { continue; }
            let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            let size  = meta.len();
            if let Some(hash) = p.file_stem().and_then(|s| s.to_str()).map(String::from) {
                files.push((mtime, hash, size));
            }
        }
    }
    files.sort_by_key(|(t, _, _)| *t); // oldest first

    let mut total: u64 = files.iter().map(|(_, _, s)| s).sum();
    let mut pruned = Vec::new();
    for (_, hash, size) in &files {
        if total <= limit_bytes { break; }
        delete_attachment_from(dir, hash)?;
        pruned.push(hash.clone());
        total = total.saturating_sub(*size);
    }
    Ok(pruned)
}

/// Prune `.bin` attachments whose mtime is older than `max_age_secs` seconds.
/// Returns the content hashes of pruned files.
pub(crate) fn prune_old_attachments(
    dir: &PathBuf,
    max_age_secs: u64,
) -> Result<Vec<String>, String> {
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(max_age_secs))
        .ok_or_else(|| "duration overflow".to_string())?;

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]), // no attachments dir yet
    };

    let mut pruned = Vec::new();
    for entry in entries {
        let prefix_dir = entry.map_err(|e| e.to_string())?.path();
        if !prefix_dir.is_dir() {
            continue;
        }
        for file_entry in std::fs::read_dir(&prefix_dir).map_err(|e| e.to_string())? {
            let file_entry = file_entry.map_err(|e| e.to_string())?;
            let path = file_entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("bin") {
                continue;
            }
            let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            let modified = meta.modified().map_err(|e| e.to_string())?;
            if modified < cutoff {
                if let Some(hash) = path.file_stem().and_then(|s| s.to_str()) {
                    let hash = hash.to_string();
                    delete_attachment_from(dir, &hash)?;
                    pruned.push(hash);
                }
            }
        }
    }
    Ok(pruned)
}

//  Tauri commands (thin wrappers) 

/// Returns the path to a complete attachment if present.
#[tauri::command]
pub fn get_attachment_path(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<Option<String>, String> {
    let dir = attachments_dir(&app_handle)?;
    let path = bin_path(&dir, &content_hash);
    if path.exists() {
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// Returns true if the complete file is locally available.
#[tauri::command]
pub fn has_attachment(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<bool, String> {
    let dir = attachments_dir(&app_handle)?;
    Ok(bin_path(&dir, &content_hash).exists())
}

/// Returns the total number of chunks for a file of `file_size` bytes.
#[tauri::command]
pub fn get_chunk_count(file_size: u64) -> u32 {
    ((file_size + CHUNK_SIZE as u64 - 1) / CHUNK_SIZE as u64) as u32
}

/// Save a file as a complete attachment in one go (sender path).
#[tauri::command]
pub fn save_attachment(
    app_handle: tauri::AppHandle,
    content_hash: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let dir = attachments_dir(&app_handle)?;
    save_attachment_to(&dir, &content_hash, &data)
}

/// Write a single chunk into `.part` buffer. Returns true when all chunks received.
#[tauri::command]
pub fn save_attachment_chunk(
    app_handle: tauri::AppHandle,
    content_hash: String,
    chunk_index: u32,
    total_chunks: u32,
    data: Vec<u8>,
) -> Result<bool, String> {
    let dir = attachments_dir(&app_handle)?;
    save_chunk_to(&dir, &content_hash, chunk_index, total_chunks, data)
}

/// Read a chunk from a complete attachment for seeding.
#[tauri::command]
pub fn read_attachment_chunk(
    app_handle: tauri::AppHandle,
    content_hash: String,
    chunk_index: u32,
) -> Result<Option<Vec<u8>>, String> {
    let dir = attachments_dir(&app_handle)?;
    read_chunk_from(&dir, &content_hash, chunk_index)
}

/// Return which chunks are already received for a partial download.
#[tauri::command]
pub fn get_received_chunks(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<Vec<u32>, String> {
    let dir = attachments_dir(&app_handle)?;
    get_received_chunks_from(&dir, &content_hash)
}

/// Hash raw bytes with BLAKE3, returning hex string (no prefix).
#[tauri::command]
pub fn blake3_hash(data: Vec<u8>) -> String {
    blake3::hash(&data).to_hex().to_string()
}

/// Delete an attachment and its sidecar files.
#[tauri::command]
pub fn delete_attachment(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<(), String> {
    let dir = attachments_dir(&app_handle)?;
    delete_attachment_from(&dir, &content_hash)
}

/// Prune `.bin` attachments older than `max_age_secs` seconds.
/// Returns the hashes of pruned files.
#[tauri::command]
pub fn prune_attachments(
    app_handle: tauri::AppHandle,
    max_age_secs: u64,
) -> Result<Vec<String>, String> {
    let dir = attachments_dir(&app_handle)?;
    prune_old_attachments(&dir, max_age_secs)
}

/// Return the total bytes used by completed attachment files (`.bin`).
#[tauri::command]
pub fn get_attachment_storage_bytes(app_handle: tauri::AppHandle) -> Result<u64, String> {
    let dir = attachments_dir(&app_handle)?;
    Ok(total_attachment_bytes(&dir))
}

/// Prune oldest attachments until under `limit_gb` gigabytes.
/// Returns the hashes of pruned files.
#[tauri::command]
pub fn enforce_storage_limit(
    app_handle: tauri::AppHandle,
    limit_gb: f64,
) -> Result<Vec<String>, String> {
    let dir   = attachments_dir(&app_handle)?;
    let limit = (limit_gb * 1_073_741_824.0) as u64;
    prune_to_limit(&dir, limit)
}

//  Tests 

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    //  Test helper: temporary directory cleaned up after each test 

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let ts = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("gamechat_test_{}", ts));
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    //  1. BLAKE3 hash is deterministic for same content 

    #[test]
    fn blake3_hash_is_deterministic() {
        let data = b"Hello, GameChat attachments!".to_vec();
        let h1 = blake3_hash(data.clone());
        let h2 = blake3_hash(data.clone());
        assert_eq!(h1, h2, "same data must produce same hash");
        assert_eq!(h1.len(), 64, "BLAKE3 hex output is 64 chars (32 bytes)");
        // Different data must produce a different hash
        let other = b"different content".to_vec();
        assert_ne!(blake3_hash(other), h1, "different data must produce different hash");
    }

    //  2. Chunk reassembly produces byte-identical file 

    #[test]
    fn chunk_reassembly_produces_byte_identical_file() {
        let dir = TempDir::new();
        let cs = CHUNK_SIZE;

        // Original data: 2 full chunks + a 1 KB partial third chunk.
        let original: Vec<u8> = (0u32..((cs * 2 + 1024) as u32))
            .map(|i| (i % 251) as u8)
            .collect();
        let content_hash = blake3_hash(original.clone());
        let total_chunks = 3u32; // ceil((cs*2 + 1024) / cs) == 3

        // Send chunks out of order: 2, 0, 1
        let r2 = save_chunk_to(
            &dir.0,
            &content_hash,
            2,
            total_chunks,
            original[cs * 2..].to_vec(),
        )
        .unwrap();
        assert!(!r2, "transfer must not be complete after chunk 2");

        let r0 = save_chunk_to(
            &dir.0,
            &content_hash,
            0,
            total_chunks,
            original[..cs].to_vec(),
        )
        .unwrap();
        assert!(!r0, "transfer must not be complete after chunk 0");

        let done = save_chunk_to(
            &dir.0,
            &content_hash,
            1,
            total_chunks,
            original[cs..cs * 2].to_vec(),
        )
        .unwrap();
        assert!(done, "final chunk should mark transfer as complete");

        let assembled = std::fs::read(bin_path(&dir.0, &content_hash)).unwrap();
        assert_eq!(assembled, original, "reassembled bytes must be identical to original");
    }

    //  3. Partial download resumes from correct chunk offset 

    #[test]
    fn partial_download_resumes_from_correct_offset() {
        let dir = TempDir::new();
        let cs = CHUNK_SIZE;

        let original: Vec<u8> = vec![0xABu8; cs * 3];
        let content_hash = blake3_hash(original.clone());

        // Save chunks 0 and 2; deliberately skip chunk 1.
        save_chunk_to(&dir.0, &content_hash, 0, 3, original[..cs].to_vec()).unwrap();
        save_chunk_to(&dir.0, &content_hash, 2, 3, original[cs * 2..].to_vec()).unwrap();

        // The bitfield must record exactly chunks 0 and 2 as received.
        let mut received = get_received_chunks_from(&dir.0, &content_hash).unwrap();
        received.sort_unstable();
        assert_eq!(received, vec![0u32, 2u32], "only chunks 0 and 2 should be marked received");

        // Transfer is incomplete  .bin must not exist yet.
        assert!(
            !bin_path(&dir.0, &content_hash).exists(),
            ".bin must not exist while transfer is partial"
        );

        // Resume: supply the missing chunk 1.
        let done =
            save_chunk_to(&dir.0, &content_hash, 1, 3, original[cs..cs * 2].to_vec()).unwrap();
        assert!(done, "supplying the last missing chunk should complete the transfer");
        assert!(
            bin_path(&dir.0, &content_hash).exists(),
            ".bin must exist after all chunks received"
        );
    }

    //  4. Chunk integrity: corrupted chunk is rejected 
    //
    // TDD RED: this test was written before the BLAKE3 integrity check existed in
    // save_chunk_to.  Without integrity verification, save_chunk_to returns Ok(true)
    // when all chunks arrive  this test would then fail because `result.is_err()`
    // would be false.
    //
    // TDD GREEN: the integrity check in save_chunk_to (after the bitfield saturates)
    // computes blake3 of the assembled .part, compares to content_hash, deletes .part
    // on mismatch and returns Err  passing this test.

    #[test]
    fn corrupted_chunk_is_rejected() {
        let dir = TempDir::new();
        // Real data and its correct hash.
        let real_data = vec![0x11u8; 1000];
        let correct_hash = blake3_hash(real_data);

        // Attempt to complete the download with corrupted data (wrong bytes, same length).
        let corrupted = vec![0x22u8; 1000];
        let result = save_chunk_to(&dir.0, &correct_hash, 0, 1, corrupted);

        assert!(result.is_err(), "a chunk whose assembled hash doesn't match must be rejected");
        assert!(
            !bin_path(&dir.0, &correct_hash).exists(),
            ".bin must not exist after integrity failure"
        );
        assert!(
            !part_path(&dir.0, &correct_hash).exists(),
            ".part must be cleaned up after integrity failure"
        );
    }

    //  5. Retention pruning removes old files, keeps new ones 
    //
    // TDD RED: this test was written before prune_old_attachments existed.
    // TDD GREEN: prune_old_attachments walks the dir, checks mtime, deletes old .bin.

    #[test]
    fn prune_removes_old_files_keeps_new() {
        let dir = TempDir::new();

        // Create the "old" attachment.
        let old_data = b"old content to prune".to_vec();
        let old_hash = blake3_hash(old_data.clone());
        save_attachment_to(&dir.0, &old_hash, &old_data).unwrap();

        // Backdate the old .bin mtime to 40 days ago using std::fs::FileTimes (stable Rust 1.75+).
        let forty_days_ago = SystemTime::now()
            .checked_sub(Duration::from_secs(40 * 24 * 3600))
            .expect("system time underflow");
        std::fs::OpenOptions::new()
            .write(true)
            .open(bin_path(&dir.0, &old_hash))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(forty_days_ago))
            .unwrap();

        // Create the "new" attachment (mtime is right now).
        let new_data = b"new content to keep".to_vec();
        let new_hash = blake3_hash(new_data.clone());
        save_attachment_to(&dir.0, &new_hash, &new_data).unwrap();

        // Prune anything older than 30 days.
        let pruned = prune_old_attachments(&dir.0, 30 * 24 * 3600).unwrap();

        assert_eq!(pruned.len(), 1, "only the old attachment should be pruned");
        assert_eq!(pruned[0], old_hash);
        assert!(
            !bin_path(&dir.0, &old_hash).exists(),
            "old attachment must be deleted"
        );
        assert!(
            bin_path(&dir.0, &new_hash).exists(),
            "new attachment must survive pruning"
        );
    }
}
