/**
 * reset-db.mjs — Delete the database and attachment files for one or more dev instances.
 *
 * Usage:
 *   npm run reset:db                        # reset all (default, alice, bob)
 *   npm run reset:db -- alice               # reset just alice
 *   npm run reset:db -- alice bob           # reset alice and bob
 *   npm run reset:db -- default             # reset the default (production-path) instance
 *
 * What gets deleted per instance:
 *   hexfield.db          — the SQLite database (identity, messages, servers, …)
 *   attachments/         — CAS content-addressed attachment blobs
 */

import { rmSync, existsSync } from 'node:fs'
import { join }               from 'node:path'
import { homedir }            from 'node:os'
import { execSync }           from 'node:child_process'

// ---------------------------------------------------------------------------
// Resolve Windows AppData paths — works whether this script runs under
// Windows Node, WSL Node, or macOS/Linux Node.
// ---------------------------------------------------------------------------

function winEnv(varName) {
  // Native Windows or MSYS/Git-bash: env var is already set
  if (process.env[varName]) return process.env[varName]
  // WSL: ask cmd.exe for the value
  try {
    return execSync(`cmd.exe /c "echo %${varName}%"`, { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Translate a Windows path (C:\Users\…) into a WSL mount path (/mnt/c/Users/…). */
function toFsPath(winPath) {
  if (!winPath) return null
  if (process.platform !== 'linux') return winPath          // Windows — use as-is
  // WSL: C:\foo\bar → /mnt/c/foo/bar
  return winPath
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`)
}

const isWin     = process.platform === 'win32'
const isLinux   = process.platform === 'linux'
const isMac     = process.platform === 'darwin'

// Detect WSL: on Linux, check if we can reach cmd.exe
const isWSL = isLinux && (() => {
  try { execSync('cmd.exe /c ver', { stdio: 'ignore' }); return true } catch { return false }
})()

let APPDATA, LOCALDATA

if (isWin) {
  APPDATA   = process.env.APPDATA      ?? join(homedir(), 'AppData', 'Roaming')
  LOCALDATA = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
} else if (isWSL) {
  APPDATA   = toFsPath(winEnv('APPDATA'))
  LOCALDATA = toFsPath(winEnv('LOCALAPPDATA'))
} else if (isMac) {
  APPDATA   = join(homedir(), 'Library', 'Application Support')
  LOCALDATA = APPDATA
} else {
  // bare Linux
  APPDATA   = join(homedir(), '.config')
  LOCALDATA = APPDATA
}

/** Returns the root data directory for a given instance name. */
function dataDir(name) {
  if (name === 'default') {
    // Tauri's default app_data_dir for identifier "com.hexfield.app"
    if (isWin || isWSL)  return join(APPDATA,   'com.hexfield.app')
    if (isMac)           return join(APPDATA,   'com.hexfield.app')
    return join(APPDATA, 'com.hexfield.app')  // Linux
  }
  // Named dev instance (alice, bob, …): matches HEXFIELD_DATA_DIR in dev-tauri.mjs
  const base = (isWin || isWSL)
    ? join(LOCALDATA, 'HexField-dev')
    : join(homedir(), '.hexfield-dev')
  return join(base, name)
}

// ---------------------------------------------------------------------------
// Items to wipe inside a data directory
// ---------------------------------------------------------------------------

const WIPE_TARGETS = [
  'hexfield.db',
  'hexfield.db-wal',
  'hexfield.db-shm',
  'attachments',
]

function resetInstance(name) {
  const dir = dataDir(name)
  if (!existsSync(dir)) {
    console.log(`[reset:db]  ${name.padEnd(10)} — directory not found, skipping (${dir})`)
    return
  }

  let wiped = 0
  for (const target of WIPE_TARGETS) {
    const full = join(dir, target)
    if (existsSync(full)) {
      rmSync(full, { recursive: true, force: true })
      console.log(`[reset:db]  ${name.padEnd(10)} — deleted ${target}`)
      wiped++
    }
  }

  if (wiped === 0) {
    console.log(`[reset:db]  ${name.padEnd(10)} — already clean, nothing to delete`)
  }
}

// ---------------------------------------------------------------------------
// Resolve which instances to reset
// ---------------------------------------------------------------------------

const ALL_INSTANCES = ['default', 'alice', 'bob']

const args = process.argv.slice(2).filter(a => a !== '--')

if (args.length === 0) {
  // No arguments — reset all known instances
  console.log(`[reset:db] Resetting all instances: ${ALL_INSTANCES.join(', ')}`)
  for (const name of ALL_INSTANCES) resetInstance(name)
} else {
  // Validate each supplied name
  for (const name of args) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      console.error(`[reset:db] Invalid instance name "${name}" — use letters, numbers, hyphens, or underscores only`)
      process.exit(1)
    }
  }
  for (const name of args) resetInstance(name)
}

console.log('[reset:db] Done.')
