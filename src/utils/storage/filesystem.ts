/**
 * File System Utilities — thin wrapper over Tauri plugin-fs.
 *
 * All relative paths resolve under BaseDirectory.AppData.
 */

import {
  readTextFile,
  writeTextFile,
  writeFile,
  mkdir,
  readDir,
  exists,
  remove,
  rename,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { logger } from '../logger';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const BASE = BaseDirectory.AppData;

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { baseDir: BASE, recursive: true });
}

export async function readFile(filePath: string): Promise<string | null> {
  try {
    if (!(await exists(filePath, { baseDir: BASE }))) return null;
    return await readTextFile(filePath, { baseDir: BASE });
  } catch (error) {
    logger.error('FS', 'Error reading file:', filePath, error);
    return null;
  }
}

/**
 * Atomically write a text file (write to .tmp, then rename).
 */
export async function writeFileContent(filePath: string, content: string): Promise<void> {
  const parts = filePath.split("/");
  if (parts.length > 1) await ensureDir(parts.slice(0, -1).join("/"));
  const tmpPath = filePath + '.tmp';
  await writeTextFile(tmpPath, content, { baseDir: BASE });
  await rename(tmpPath, filePath, { oldPathBaseDir: BASE, newPathBaseDir: BASE });
}

export async function pathExists(filePath: string): Promise<boolean> {
  return exists(filePath, { baseDir: BASE });
}

export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  try {
    if (!(await exists(dirPath, { baseDir: BASE }))) return [];
    const entries = await readDir(dirPath, { baseDir: BASE });
    return entries.map(e => ({
      name: e.name ?? "",
      path: `${dirPath}/${e.name}`,
      isDir: e.isDirectory ?? false,
    }));
  } catch (error) {
    logger.error('FS', 'Error listing directory:', dirPath, error);
    return [];
  }
}

export async function deleteFile(filePath: string): Promise<void> {
  try {
    if (await exists(filePath, { baseDir: BASE })) {
      await remove(filePath, { baseDir: BASE });
    }
  } catch (error) {
    logger.error('FS', 'Error deleting file:', filePath, error);
  }
}

export async function openFileDialog(
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  try {
    const selected = await open({
      multiple: false,
      filters: filters ?? [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    return selected as string | null;
  } catch (error) {
    logger.error('FS', 'Error opening file dialog:', error);
    return null;
  }
}

export async function saveFileDialog(
  filename: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<string | null> {
  try {
    const selected = await save({
      filters: filters ?? [
        { name: "Text", extensions: ["txt"] },
      ],
      defaultPath: filename,
    });
    return selected as string | null;
  } catch (error) {
    logger.error('FS', 'Error saving file dialog:', error);
    return null;
  }
}

export async function writeAbsoluteFile(absolutePath: string, content: string): Promise<void> {
  await writeTextFile(absolutePath, content);
}

export async function readAbsoluteFile(absolutePath: string): Promise<string | null> {
  try { return await readTextFile(absolutePath); } catch { return null; }
}

export async function writeBinaryAbsolute(absolutePath: string, data: Uint8Array): Promise<void> {
  await writeFile(absolutePath, data);
}
