/**
 * e2e-integration.mjs — Automated integration test orchestrator
 *
 * Kills any existing alice/bob instances, resets their databases,
 * relaunches them, waits for CDP ports, then runs Playwright tests.
 *
 * Usage:
 *   npm run e2e:fresh          # full reset + relaunch + test
 *
 * Prerequisites:
 *   - Vite dev server running on port 1420 (e.g. via `npm run dev:tauri`)
 *   - Debug binary built (`src-tauri/target/debug/hexfield.exe`)
 */

import { spawn, execSync }      from 'node:child_process'
import { join }                  from 'node:path'
import { homedir }               from 'node:os'
import { mkdirSync, existsSync } from 'node:fs'
import { createConnection }      from 'node:net'
import { fileURLToPath }         from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const isWin = process.platform === 'win32'

const CDP_PORTS = { alice: 9222, bob: 9223 }
const VITE_PORT = 1420

const binaryName = isWin ? 'hexfield.exe' : 'hexfield'
const binaryPath = join(ROOT, 'src-tauri', 'target', 'debug', binaryName)

// ---------------------------------------------------------------------------
// 1. Kill processes on CDP ports
// ---------------------------------------------------------------------------

function findPidOnPort(port) {
  if (!isWin) return null
  try {
    const out = execSync(
      `netstat -ano | findstr ":${port}.*LISTENING"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    )
    // Each line: "  TCP    127.0.0.1:9222    0.0.0.0:0    LISTENING    12345"
    const lines = out.trim().split('\n')
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[parts.length - 1], 10)
      if (pid > 0) return pid
    }
  } catch {
    // netstat found nothing — port is free
  }
  return null
}

function killPid(pid) {
  if (!pid) return
  try {
    if (isWin) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
    }
    console.log(`[e2e] Killed PID ${pid}`)
  } catch {
    // Process already exited
  }
}

function killInstancesOnCDP() {
  for (const [name, port] of Object.entries(CDP_PORTS)) {
    const pid = findPidOnPort(port)
    if (pid) {
      console.log(`[e2e] Found ${name} on port ${port} (PID ${pid}) — killing…`)
      killPid(pid)
    } else {
      console.log(`[e2e] No process on port ${port} (${name})`)
    }
  }

  // Also kill any remaining hexfield processes by name (catches orphans)
  if (isWin) {
    try {
      execSync('taskkill /IM hexfield.exe /F', { stdio: ['pipe', 'pipe', 'pipe'] })
      console.log('[e2e] Killed remaining hexfield.exe processes')
    } catch {
      // No hexfield processes — expected if port-based kill already got them
    }
  } else {
    try {
      execSync('pkill -9 hexfield', { stdio: 'ignore' })
    } catch {
      // No processes to kill
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Reset databases
// ---------------------------------------------------------------------------

async function resetDatabases(retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[e2e] Resetting databases for alice and bob… (attempt ${attempt})`)
      execSync('node scripts/reset-db.mjs alice bob', {
        cwd: ROOT,
        stdio: 'inherit',
      })
      return
    } catch (err) {
      if (attempt < retries) {
        console.warn(`[e2e] Reset failed (file locked?), retrying in 2s…`)
        await new Promise(r => setTimeout(r, 2_000))
      } else {
        throw err
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Launch instances
// ---------------------------------------------------------------------------

function buildEnv(namespace) {
  const env = { ...process.env }

  const base = isWin
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'HexField-dev')
    : join(homedir(), '.hexfield-dev')

  const dataDir = join(base, namespace)
  mkdirSync(dataDir, { recursive: true })

  env.HEXFIELD_DATA_DIR = dataDir
  env.HEXFIELD_MULTI_INSTANCE = '1'

  if (isWin && namespace in CDP_PORTS) {
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${CDP_PORTS[namespace]}`
  }

  // Strip snap-injected vars on Linux
  if (process.platform === 'linux') {
    delete env.GIO_MODULE_DIR
    delete env.GTK_PATH
    delete env.GTK_EXE_PREFIX
    delete env.GTK_IM_MODULE_FILE
    delete env.GSETTINGS_SCHEMA_DIR
    delete env.LOCPATH
  }

  return env
}

function launchInstance(namespace) {
  console.log(`[e2e] Launching ${namespace}…`)
  const env = buildEnv(namespace)
  const child = spawn(binaryPath, [], {
    stdio: 'ignore',
    detached: true,
    env,
  })
  child.unref()
  return child
}

// ---------------------------------------------------------------------------
// 4. Wait for port
// ---------------------------------------------------------------------------

function waitForPort(port, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const hosts = ['127.0.0.1', '::1']
    let hostIdx = 0

    function attempt() {
      if (Date.now() > deadline) {
        reject(new Error(`[e2e] Timed out waiting for ${label} on port ${port}`))
        return
      }

      const host = hosts[hostIdx % hosts.length]
      hostIdx++
      const sock = createConnection({ port, host })
      sock.on('connect', () => {
        sock.destroy()
        console.log(`[e2e] ${label} ready on port ${port}`)
        resolve()
      })
      sock.on('error', () => setTimeout(attempt, 500))
      sock.setTimeout(300, () => { sock.destroy(); setTimeout(attempt, 500) })
    }

    attempt()
  })
}

// ---------------------------------------------------------------------------
// 5. Run playwright
// ---------------------------------------------------------------------------

function runPlaywright() {
  return new Promise((resolve) => {
    console.log('[e2e] Running Playwright integration tests…')
    const pw = spawn(
      'npx',
      ['playwright', 'test', '--project=integration', '--config', 'e2e/playwright.config.ts'],
      { cwd: ROOT, stdio: 'inherit', shell: true }
    )
    pw.on('close', (code) => resolve(code ?? 1))
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Check binary exists
  if (!existsSync(binaryPath)) {
    console.error(`[e2e] Debug binary not found at: ${binaryPath}`)
    console.error('[e2e] Run "npm run dev:tauri" at least once to build it.')
    process.exit(1)
  }

  // Kill existing instances
  killInstancesOnCDP()

  // Brief pause for port + file handle release on Windows
  await new Promise(r => setTimeout(r, 3_000))

  // Reset DBs
  await resetDatabases()

  // Check Vite is running, start it if not
  let viteStarted = false
  try {
    await waitForPort(VITE_PORT, 'Vite', 3_000)
    console.log('[e2e] Vite already running on port 1420')
  } catch {
    console.log('[e2e] Starting Vite dev server…')
    const vite = spawn('npx', ['vite', '--port', '1420'], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
      shell: true,
    })
    vite.unref()
    viteStarted = true
    await waitForPort(VITE_PORT, 'Vite', 15_000)
  }

  // Launch alice and bob (staggered to avoid WebView2 init conflicts)
  launchInstance('alice')
  await new Promise(r => setTimeout(r, 2_000))
  launchInstance('bob')

  // Wait for both CDP ports
  console.log('[e2e] Waiting for CDP ports…')
  await Promise.all([
    waitForPort(CDP_PORTS.alice, 'alice', 30_000),
    waitForPort(CDP_PORTS.bob, 'bob', 30_000),
  ])

  // Extra settle time for app initialization (libsodium, identity, etc.)
  console.log('[e2e] Instances ready, waiting for app init…')
  await new Promise(r => setTimeout(r, 3_000))

  // Run tests
  const exitCode = await runPlaywright()
  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
