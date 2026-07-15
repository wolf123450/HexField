#!/usr/bin/env node
// Runs browser-mode E2E tests headed with slow motion for demos.
// Usage:
//   npm run e2e:demo                                    -- all tests, 800ms slowMo
//   npm run e2e:demo -- e2e/tests/governance.spec.ts   -- specific file
//   PLAYWRIGHT_SLOW_MO=400 npm run e2e:demo            -- custom speed
import { spawnSync } from 'child_process'

process.env.PLAYWRIGHT_SLOW_MO ??= '800'

const result = spawnSync(
  process.execPath,
  [
    'node_modules/playwright/cli.js',
    'test',
    '--project=browser',
    '--config', 'e2e/playwright.config.ts',
    '--headed',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env: process.env }
)

process.exit(result.status ?? 0)
