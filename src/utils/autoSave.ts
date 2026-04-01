/**
 * Auto-Save System — debounced saving for any named entity.
 */

import { logger } from './logger'

export interface AutoSaveConfig {
  interval: number
}

const DEFAULT_CONFIG: AutoSaveConfig = { interval: 10000 }

class AutoSaveManager {
  private config: AutoSaveConfig
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private lastSaveTime: Map<string, number> = new Map()
  private saveCallbacks: Map<string, () => Promise<void>> = new Map()

  constructor(config: Partial<AutoSaveConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  registerSaveCallback(entityId: string, callback: () => Promise<void>) {
    this.saveCallbacks.set(entityId, callback)
  }

  unregisterSaveCallback(entityId: string) {
    this.saveCallbacks.delete(entityId)
    this.cancelAutoSave(entityId)
  }

  triggerAutoSave(entityId: string) {
    if (this.timers.has(entityId)) clearTimeout(this.timers.get(entityId))
    const timeoutId = setTimeout(async () => {
      await this.executeSave(entityId)
    }, this.config.interval)
    this.timers.set(entityId, timeoutId)
  }

  async executeSave(entityId: string) {
    const callback = this.saveCallbacks.get(entityId)
    if (!callback) return
    try {
      await callback()
      this.lastSaveTime.set(entityId, Date.now())
      logger.info('AutoSave', `Saved ${entityId}`)
    } catch (error) {
      logger.error('AutoSave', `Failed to save ${entityId}:`, error)
    }
  }

  cancelAutoSave(entityId: string) {
    const timerId = this.timers.get(entityId)
    if (timerId) { clearTimeout(timerId); this.timers.delete(entityId) }
  }

  async saveAll() {
    const promises = Array.from(this.saveCallbacks.keys()).map(id => this.executeSave(id))
    await Promise.all(promises)
  }

  getLastSaveTime(entityId: string): number | null {
    return this.lastSaveTime.get(entityId) || null
  }

  hasUnsavedChanges(entityId: string): boolean {
    return this.timers.has(entityId)
  }

  clear() {
    this.timers.forEach(t => clearTimeout(t))
    this.timers.clear()
    this.lastSaveTime.clear()
    this.saveCallbacks.clear()
  }

  updateConfig(config: Partial<AutoSaveConfig>) {
    this.config = { ...this.config, ...config }
  }
}

export const autoSaveManager = new AutoSaveManager()
