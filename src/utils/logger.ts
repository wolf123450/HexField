/**
 * Structured logger — replaces scattered console.log/warn/error calls.
 *
 * In production Tauri builds, log calls are also written to the OS log file
 * via @tauri-apps/plugin-log.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug:  0,
  info:   1,
  warn:   2,
  error:  3,
  silent: 4,
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type PluginLog = {
  debug: (msg: string) => Promise<void>
  info:  (msg: string) => Promise<void>
  warn:  (msg: string) => Promise<void>
  error: (msg: string) => Promise<void>
}

let _plugin: PluginLog | null = null

if (!import.meta.env.DEV && isTauri) {
  import('@tauri-apps/plugin-log')
    .then(p => { _plugin = p as unknown as PluginLog })
    .catch(() => {})
}

function serialize(tag: string, args: unknown[]): string {
  return `[${tag}] ` + args.map(a =>
    a instanceof Error      ? (a.stack ?? a.message) :
    typeof a === 'object' && a !== null ? JSON.stringify(a) :
    String(a)
  ).join(' ')
}

class Logger {
  level: LogLevel = import.meta.env.DEV ? 'debug' : 'info'

  debug(tag: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] > LEVEL_ORDER.debug) return
    console.debug(`[${tag}]`, ...args)
    _plugin?.debug(serialize(tag, args)).catch(() => {})
  }

  info(tag: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] > LEVEL_ORDER.info) return
    console.log(`[${tag}]`, ...args)
    _plugin?.info(serialize(tag, args)).catch(() => {})
  }

  warn(tag: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] > LEVEL_ORDER.warn) return
    console.warn(`[${tag}]`, ...args)
    _plugin?.warn(serialize(tag, args)).catch(() => {})
  }

  error(tag: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[this.level] > LEVEL_ORDER.error) return
    console.error(`[${tag}]`, ...args)
    _plugin?.error(serialize(tag, args)).catch(() => {})
  }
}

export const logger = new Logger()
