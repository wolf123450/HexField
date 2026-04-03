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
// Choose launch strategy
//
// Default instance (no namespace):
//   Use `tauri dev` — starts Vite + compiles + runs Rust. Normal workflow.
//
// Named instance (namespace given):
//   NEVER use `tauri dev` — it always spawns beforeDevCommand which tries to
//   bind Vite on port 1420 a second time and fails.  Instead, launch the
//   compiled debug binary directly.  If the binary doesn't exist yet we run
//   `cargo build` first (compiles without starting Vite).
// ---------------------------------------------------------------------------
const binaryName = process.platform === 'win32' ? 'gamechat.exe' : 'gamechat'
const binaryPath = join(ROOT, 'src-tauri', 'target', 'debug', binaryName)

let child

if (!namespace) {
  // ── Default: full tauri dev (starts Vite + Rust) ────────────────────────
  child = spawn('npx', ['tauri', 'dev'], { stdio: 'inherit', env, shell: true })
} else {
  // ── Named instance: binary only ─────────────────────────────────────────
  if (!existsSync(binaryPath)) {
    console.log('[dev:tauri] Debug binary not found — running cargo build first...')
    console.log('[dev:tauri] (Make sure `npm run dev:tauri` is running in another terminal)')
    const build = spawn(
      'cargo', ['build', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml')],
      { stdio: 'inherit', shell: true }
    )
    const buildCode = await new Promise(resolve => build.on('close', resolve))
    if (buildCode !== 0) {
      console.error('[dev:tauri] cargo build failed — cannot launch instance')
      process.exit(buildCode ?? 1)
    }
  }

  console.log(`[dev:tauri] Launching binary: ${binaryPath}`)
  child = spawn(binaryPath, [], { stdio: 'inherit', env })
}

child.on('close', code => process.exit(code ?? 0))
