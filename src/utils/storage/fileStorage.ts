/**
 * File-Based Storage Adapter
 *
 * Generic adapter for persisting items to the file system via Tauri plugin-fs.
 * Items are stored under AppData as:
 *
 *   {basePath}/{itemId}.json
 *
 * Replace {basePath} via the constructor. The default is 'items'.
 */

import {
  readFile,
  writeFileContent,
  pathExists,
  listDirectory,
} from './filesystem'
import { remove, BaseDirectory } from '@tauri-apps/plugin-fs'
import { logger } from '../logger'

export class FileStorageAdapter<T extends Record<string, unknown>> {
  constructor(private readonly basePath: string = 'items') {}

  private itemPath(id: string) {
    return `${this.basePath}/${id}.json`
  }

  async saveItem(id: string, data: T): Promise<boolean> {
    try {
      const payload = { ...data, lastSaved: new Date().toISOString() }
      await writeFileContent(this.itemPath(id), JSON.stringify(payload, null, 2))
      logger.info('FileStorage', `Saved item: ${id}`)
      return true
    } catch (error) {
      logger.error('FileStorage', 'Error saving item:', id, error)
      return false
    }
  }

  async loadItem(id: string): Promise<T | null> {
    try {
      const json = await readFile(this.itemPath(id))
      if (!json) return null
      const { lastSaved: _lastSaved, ...rest } = JSON.parse(json)
      logger.info('FileStorage', `Loaded item: ${id}`)
      return rest as T
    } catch (error) {
      logger.error('FileStorage', 'Error loading item:', id, error)
      return null
    }
  }

  async deleteItem(id: string): Promise<boolean> {
    try {
      const path = this.itemPath(id)
      if (await pathExists(path)) {
        await remove(path, { baseDir: BaseDirectory.AppData })
      }
      logger.info('FileStorage', `Deleted item: ${id}`)
      return true
    } catch (error) {
      logger.error('FileStorage', 'Error deleting item:', id, error)
      return false
    }
  }

  async listItems(): Promise<Array<{ id: string; lastSaved?: string }>> {
    try {
      if (!(await pathExists(this.basePath))) return []
      const entries = await listDirectory(this.basePath)
      const results: Array<{ id: string; lastSaved?: string }> = []

      for (const entry of entries) {
        if (entry.isDir || !entry.name.endsWith('.json')) continue
        const id = entry.name.replace(/\.json$/, '')
        try {
          const json = await readFile(this.itemPath(id))
          if (json) {
            const parsed = JSON.parse(json)
            results.push({ id, lastSaved: parsed.lastSaved })
          }
        } catch {
          // Skip corrupted entries
        }
      }

      return results
    } catch (error) {
      logger.error('FileStorage', 'Error listing items:', error)
      return []
    }
  }
}
