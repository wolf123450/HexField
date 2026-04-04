use std::path::PathBuf;
use tauri::Manager;

const CHUNK_SIZE: usize = 256 * 1024; // 256 KB

// ── Helpers ───────────────────────────────────────────────────────────────────

fn attachments_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(base.join("attachments"))
}

/// Returns the full path for a complete attachment: attachments/{hash[0:2]}/{hash}.bin
fn bin_path(dir: &PathBuf, content_hash: &str) -> PathBuf {
    let prefix = &content_hash[..2.min(content_hash.len())];
    dir.join(prefix).join(format!("{}.bin", content_hash))
}

/// Returns the full path for an in-progress download: attachments/{hash[0:2]}/{hash}.part
fn part_path(dir: &PathBuf, content_hash: &str) -> PathBuf {
    let prefix = &content_hash[..2.min(content_hash.len())];
    dir.join(prefix).join(format!("{}.part", content_hash))
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

// ── Commands ──────────────────────────────────────────────────────────────────

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

/// Save a file as a complete attachment in one go (used by the sender after hashing).
/// Writes to a temp `.part` file then renames atomically to `.bin`.
#[tauri::command]
pub fn save_attachment(
    app_handle: tauri::AppHandle,
    content_hash: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let dir = attachments_dir(&app_handle)?;
    let prefix_dir = dir.join(&content_hash[..2.min(content_hash.len())]);
    ensure_dir(&prefix_dir)?;
    let bin = bin_path(&dir, &content_hash);
    if bin.exists() {
        return Ok(()); // already seeding
    }
    let tmp = bin.with_extension("tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &bin).map_err(|e| e.to_string())?;
    Ok(())
}

/// Write a single chunk into the `.part` buffer.
/// `chunk_index` is 0-based. `total_chunks` is the expected count.
/// When all chunks are received (bitfield saturated), renames `.part` → `.bin`.
#[tauri::command]
pub fn save_attachment_chunk(
    app_handle: tauri::AppHandle,
    content_hash: String,
    chunk_index: u32,
    total_chunks: u32,
    data: Vec<u8>,
) -> Result<bool, String> {
    if data.len() > CHUNK_SIZE {
        return Err(format!("chunk too large: {} bytes", data.len()));
    }
    let dir = attachments_dir(&app_handle)?;
    let prefix_dir = dir.join(&content_hash[..2.min(content_hash.len())]);
    ensure_dir(&prefix_dir)?;

    let bin = bin_path(&dir, &content_hash);
    if bin.exists() {
        return Ok(true); // already complete
    }

    let part = part_path(&dir, &content_hash);

    // Each .part file stores chunks concatenated at their natural byte offsets.
    // We also maintain a sidecar <hash>.bits bitfield for received-chunk tracking.
    let bits_path = dir
        .join(&content_hash[..2.min(content_hash.len())])
        .join(format!("{}.bits", content_hash));

    // Load or create bitfield (total_chunks bits, 1 byte per chunk for simplicity)
    let mut bitfield: Vec<u8> = if bits_path.exists() {
        std::fs::read(&bits_path).map_err(|e| e.to_string())?
    } else {
        vec![0u8; total_chunks as usize]
    };

    if bitfield.len() < total_chunks as usize {
        bitfield.resize(total_chunks as usize, 0);
    }

    if bitfield[chunk_index as usize] == 0 {
        // Write chunk bytes at offset chunk_index * CHUNK_SIZE into the part file.
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
        std::fs::write(&bits_path, &bitfield).map_err(|e| e.to_string())?;
    }

    let complete = bitfield.iter().all(|&b| b == 1);
    if complete {
        // Clean up the sidecar and rename .part → .bin
        let _ = std::fs::remove_file(&bits_path);
        std::fs::rename(&part, &bin).map_err(|e| e.to_string())?;
    }
    Ok(complete)
}

/// Read a chunk from a complete attachment for seeding to a requesting peer.
#[tauri::command]
pub fn read_attachment_chunk(
    app_handle: tauri::AppHandle,
    content_hash: String,
    chunk_index: u32,
) -> Result<Option<Vec<u8>>, String> {
    let dir = attachments_dir(&app_handle)?;
    let bin = bin_path(&dir, &content_hash);
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
        return Ok(None); // chunk_index out of range
    }
    buf.truncate(n);
    Ok(Some(buf))
}

/// Return which chunks (0-based indices) are already received for a partial download.
#[tauri::command]
pub fn get_received_chunks(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<Vec<u32>, String> {
    let dir = attachments_dir(&app_handle)?;
    if bin_path(&dir, &content_hash).exists() {
        // All complete — caller should not need chunk list, but return empty to indicate done
        return Ok(vec![]);
    }
    let bits_path = dir
        .join(&content_hash[..2.min(content_hash.len())])
        .join(format!("{}.bits", content_hash));
    if !bits_path.exists() {
        return Ok(vec![]);
    }
    let bitfield = std::fs::read(&bits_path).map_err(|e| e.to_string())?;
    Ok(bitfield
        .iter()
        .enumerate()
        .filter_map(|(i, &b)| if b == 1 { Some(i as u32) } else { None })
        .collect())
}

/// Hash raw bytes with BLAKE3, returning hex string (no prefix).
#[tauri::command]
pub fn blake3_hash(data: Vec<u8>) -> String {
    blake3::hash(&data).to_hex().to_string()
}

/// Delete an attachment and its sidecar files (for retention pruning).
#[tauri::command]
pub fn delete_attachment(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<(), String> {
    let dir = attachments_dir(&app_handle)?;
    let bin = bin_path(&dir, &content_hash);
    let part = part_path(&dir, &content_hash);
    let bits_path = dir
        .join(&content_hash[..2.min(content_hash.len())])
        .join(format!("{}.bits", content_hash));
    for p in [&bin, &part, &bits_path] {
        if p.exists() {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
