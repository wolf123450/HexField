/**
 * dev-tauri.mjs  Multi-instance Tauri dev launcher
 *
 * Usage:
 *   npm run dev:tauri                   default instance (runs tauri dev as normal)
 *   npm run dev:tauri -- alice          isolated "alice" dev instance
 *   npm run dev:tauri -- bob            isolated "bob" dev instance
 *
 * Each named instance gets its own isolated SQLite database and identity,
 * stored in a namespace-specific directory:
 *   Windows:  %LOCALAPPDATA%\HexField-dev\<namespace>
 *   macOS:    ~/.hexfield-dev/<namespace>
 *   Linux:    ~/.hexfield-dev/<namespace>
 *
 * Re-using the same namespace picks up the existing identity  it does NOT
 * create a fresh user. To start clean, delete the namespace directory.
 *
 * Named instances launch the compiled debug binary directly rather than
 * running `tauri dev` (which would try to start a second Vite server on
 * port 1420 and fail). The script waits for Vite to be ready before
 * opening the WebView so the browser does not land on chrome-error://.
 *
 * Prerequisite: run `npm run dev:tauri` at least once so the binary exists.
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
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'HexField-dev')
    : join(homedir(), '.hexfield-dev')

  const dataDir = join(base, namespace)
  mkdirSync(dataDir, { recursive: true })

  env.HEXFIELD_DATA_DIR = dataDir

  console.log(`[dev:tauri] Namespace : ${namespace}`)
  console.log(`[dev:tauri] Data dir  : ${dataDir}`)
} else {
  console.log('[dev:tauri] Default instance (no namespace)')
}

// ---------------------------------------------------------------------------
// Choose launch strategy
//
// Default instance (no namespace):
//   Use tauri dev -- starts Vite + compiles + runs Rust. Normal workflow.
//
// Named instance (namespace given):
//   NEVER use tauri dev -- it always spawns beforeDevCommand which tries to
//   bind Vite on port 1420 a second time and fails.  Instead:
//     1. cargo build if the binary does not exist yet
//     2. Wait for the Vite dev server to be ready on port 1420
//        (so the WebView does not land on chrome-error://)
//     3. Launch the compiled debug binary directly
// ---------------------------------------------------------------------------
const binaryName = process.platform === 'win32' ? 'hexfield.exe' : 'hexfield'
const binaryPath = join(ROOT, 'src-tauri', 'target', 'debug', binaryName)

let child

if (!namespace) {
  child = spawn('npx', ['tauri', 'dev'], { stdio: 'inherit', env, shell: true })
} else {
  if (!existsSync(binaryPath)) {
    console.log('[dev:tauri] Debug binary not found - running cargo build first...')
    console.log('[dev:tauri] (Make sure `npm run dev:tauri` is running in another terminal)')
    const build = spawn(
      'cargo', ['build', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml')],
      { stdio: 'inherit', shell: true }
    )
    const buildCode = await new Promise(resolve => build.on('close', resolve))
    if (buildCode !== 0) {
      console.error('[dev:tauri] cargo build failed - cannot launch instance')
      process.exit(buildCode ?? 1)
    }
  }

  await waitForPort(1420, 60)

  console.log(`[dev:tauri] Launching binary: ${binaryPath}`)
  child = spawn(binaryPath, [], { stdio: 'inherit', env })
}

child.on('close', code => process.exit(code ?? 0))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForPort (port, timeoutSecs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutSecs * 1000
    // Try both IPv4 and IPv6 loopback — on Windows, Node/Vite can bind to
    // either '127.0.0.1' or '::1' depending on how 'localhost' resolves.
    const hosts = ['127.0.0.1', '::1']
    let hostIdx = 0
    let dots = 0

    function attempt () {
      const host = hosts[hostIdx % hosts.length]
      hostIdx++
      const sock = createConnection({ port, host })
      sock.on('connect', () => {
        sock.destroy()
        process.stdout.write('\n')
        console.log(`[dev:tauri] Vite ready on port ${port} (${host})`)
        resolve()
      })
      sock.on('error',   retry)
      sock.setTimeout(300, () => { sock.destroy(); retry() })
    }

    function retry () {
      if (Date.now() > deadline) {
        process.stdout.write('\n')
        reject(new Error(
          `[dev:tauri] Timed out waiting for Vite on port ${port}.\n` +
          `[dev:tauri] Make sure 'npm run dev:tauri' is running in another terminal.`
        ))
        return
      }
      if (dots % 3 === 0) process.stdout.write('.')
      dots++
      setTimeout(attempt, 500)
    }

    process.stdout.write(`[dev:tauri] Waiting for Vite on port ${port} `)
    attempt()
  })
}
