/**
 * dev-tauri.mjs — Multi-instance Tauri dev launcher
 *
 * Usage:
 *   npm run dev:tauri                  → default instance (runs tauri dev as normal)
 *   npm run dev:tauri -- alice         → isolated "alice" dev instance
 *   npm run dev:tauri -- bob           → isolated "bob" dev instance
 *
 * Each named instance gets its own isolated SQLite database and identity,
 * stored in a namespace-specific directory:
 *   Windows:  %LOCALAPPDATA%\GameChat-dev\<namespace>
 *   macOS:    ~/.gamechat-dev/<namespace>
 *   Linux:    ~/.gamechat-dev/<namespace>
 *
 * Re-using the same namespace picks up the existing identity — it does NOT
 * create a fresh user. To start clean, delete the namespace directory.
 *
 * If the Vite dev server (port 1420) is already running when a named instance
 * is launched, the compiled debug binary is started directly rather than
 * running `tauri dev` again (which would fail due to strictPort: true).
 * This means you must have run `npm run dev:tauri` at least once so the
 * binary exists before launching additional named instances.
 */

import { spawn }                 from 'node:child_process'
import { homedir }               from 'node:os'
import { join }                  from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { createConnection }      from 'node:net'
import { fileURLToPath }         from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// Namespace argument
// ---------------------------------------------------------------------------
const namespace = process.argv[2]

if (namespace && !/^[a-zA-Z0-9_-]+$/.test(namespace)) {
  console.error(
    `[dev:tauri] Invalid namespace "${namespace}".` +
    ` Use only letters, numbers, hyphens, or underscores.`
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Build env with optional data-dir override
// ---------------------------------------------------------------------------
const env = { ...process.env }

if (namespace) {
  const base = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'GameChat-dev')
    : join(homedir(), '.gamechat-dev')

  const dataDir = join(base, namespace)
  mkdirSync(dataDir, { recursive: true })

  env.GAMECHAT_DATA_DIR = dataDir

  console.log(`[dev:tauri] Namespace : ${namespace}`)
  console.log(`[dev:tauri] Data dir  : ${dataDir}`)
} else {
  console.log('[dev:tauri] Default instance (no namespace)')
}

// ---------------------------------------------------------------------------
// Detect whether Vite is already running on port 1420
// ---------------------------------------------------------------------------
function isPortOpen (port) {
  return new Promise(resolve => {
    const sock = createConnection({ port, host: '127.0.0.1' })
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error',   () => resolve(false))
    sock.setTimeout(400, () => { sock.destroy(); resolve(false) })
  })
}

const viteRunning = await isPortOpen(1420)

// ---------------------------------------------------------------------------
// Choose launch strategy
// ---------------------------------------------------------------------------
const binaryName = process.platform === 'win32' ? 'gamechat.exe' : 'gamechat'
const binaryPath = join(ROOT, 'src-tauri', 'target', 'debug', binaryName)
const binaryExists = existsSync(binaryPath)

let child

if (viteRunning && binaryExists) {
  // Vite already up — launch just the native binary so we don't try to
  // start a second Vite server (which would fail with strictPort: true).
  console.log('[dev:tauri] Vite already running → launching debug binary directly')
  child = spawn(binaryPath, [], { stdio: 'inherit', env })
} else {
  if (viteRunning && !binaryExists) {
    console.warn(
      '[dev:tauri] Vite is running but the debug binary was not found.\n' +
      `[dev:tauri] Expected: ${binaryPath}\n` +
      '[dev:tauri] Falling back to `tauri dev` — this will (re)compile the binary first.'
    )
  }
  // Normal full launch: Tauri CLI starts Vite and compiles/runs Rust.
  child = spawn('npx', ['tauri', 'dev'], { stdio: 'inherit', env, shell: true })
}

child.on('close', code => process.exit(code ?? 0))
