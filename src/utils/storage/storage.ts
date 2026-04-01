/**
 * Local Storage Manager — generic key/value item persistence.
 *
 * Replace the STORAGE_PREFIX and rename saveItem/loadItem/deleteItem methods
 * to match your domain once you know what you're building.
 */

import { errorHandler, ErrorType } from '../error'
import { logger } from '../logger'
import { APP_STORAGE_PREFIX } from '@/appConfig'

const STORAGE_PREFIX   = APP_STORAGE_PREFIX + 'item_'
const PROJECTS_LIST_KEY = APP_STORAGE_PREFIX + 'projects_list'

export interface StorageInfo {
  size: number
  keys: string[]
  available: boolean
}

class StorageManager {
  private isAvailable: boolean = false

  constructor() {
    this.checkAvailability()
  }

  private checkAvailability() {
    try {
      const test = '__storage_test__'
      localStorage.setItem(test, test)
      localStorage.removeItem(test)
      this.isAvailable = true
    } catch (error) {
      this.isAvailable = false
      errorHandler.logError(ErrorType.FILE_ERROR, 'localStorage not available', error as Error)
    }
  }

  async saveItem(itemId: string, data: Record<string, unknown>, name?: string): Promise<boolean> {
    if (!this.isAvailable) { errorHandler.handleFileError('Storage not available'); return false }

    try {
      const key = `${STORAGE_PREFIX}${itemId}`
      const payload = { id: itemId, ...data, lastSaved: new Date().toISOString() }
      localStorage.setItem(key, JSON.stringify(payload))
      this.addToProjectsList(itemId, name ?? itemId)
      logger.info('Storage', `Saved item: ${itemId}`)
      return true
    } catch (error) {
      errorHandler.handleFileError(`Failed to save item: ${itemId}`, error as Error)
      return false
    }
  }

  async loadItem(itemId: string): Promise<Record<string, unknown> | null> {
    if (!this.isAvailable) { errorHandler.handleFileError('Storage not available'); return null }

    try {
      const key = `${STORAGE_PREFIX}${itemId}`
      const data = localStorage.getItem(key)
      if (!data) { logger.warn('Storage', `Item not found: ${itemId}`); return null }
      const { id: _id, lastSaved: _lastSaved, ...rest } = JSON.parse(data)
      logger.info('Storage', `Loaded item: ${itemId}`)
      return rest
    } catch (error) {
      errorHandler.handleFileError(`Failed to load item: ${itemId}`, error as Error)
      return null
    }
  }

  async deleteItem(itemId: string): Promise<boolean> {
    if (!this.isAvailable) return false
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}${itemId}`)
      this.removeFromProjectsList(itemId)
      logger.info('Storage', `Deleted item: ${itemId}`)
      return true
    } catch (error) {
      errorHandler.handleFileError(`Failed to delete item: ${itemId}`, error as Error)
      return false
    }
  }

  getProjectsList(): Array<{ id: string; name: string; lastModified: string }> {
    try {
      const data = localStorage.getItem(PROJECTS_LIST_KEY)
      return data ? JSON.parse(data) : []
    } catch { return [] }
  }

  addToProjectsList(id: string, name: string) {
    try {
      const projects = this.getProjectsList()
      const existing = projects.findIndex(p => p.id === id)
      const entry = { id, name, lastModified: new Date().toISOString() }
      if (existing >= 0) projects[existing] = entry
      else projects.push(entry)
      localStorage.setItem(PROJECTS_LIST_KEY, JSON.stringify(projects))
    } catch (error) {
      logger.error('Storage', 'Failed to update projects list:', error)
    }
  }

  private removeFromProjectsList(id: string) {
    try {
      const projects = this.getProjectsList().filter(p => p.id !== id)
      localStorage.setItem(PROJECTS_LIST_KEY, JSON.stringify(projects))
    } catch (error) {
      logger.error('Storage', 'Failed to remove from projects list:', error)
    }
  }

  getStorageInfo(): StorageInfo {
    const keys: string[] = []
    let size = 0
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(STORAGE_PREFIX)) {
          keys.push(key)
          const value = localStorage.getItem(key)
          if (value) size += value.length
        }
      }
    } catch {}
    return { size, keys, available: this.isAvailable }
  }

  async clearAll(): Promise<boolean> {
    try {
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
      }
      keys.forEach(key => localStorage.removeItem(key))
      localStorage.removeItem(PROJECTS_LIST_KEY)
      logger.info('Storage', 'Cleared all data')
      return true
    } catch (error) {
      errorHandler.handleFileError('Failed to clear storage', error as Error)
      return false
    }
  }
}

export const storageManager = new StorageManager()
