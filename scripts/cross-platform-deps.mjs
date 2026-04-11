#!/usr/bin/env node
/**
 * cross-platform-deps.mjs
 *
 * npm refuses to install optional dependencies whose package.json "os" field
 * doesn't match the current platform. When developing on Windows+WSL with a
 * shared node_modules on an NTFS mount, this means Vite's rollup native binary
 * is only installed for whichever OS ran `npm install` last.
 *
 * This postinstall script detects which rollup platform binary is missing and
 * manually downloads + extracts it so both PowerShell and WSL can build.
 */
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const nmDir = join(root, 'node_modules', '@rollup');

// Read rollup version from the installed package
let rollupVersion;
try {
  const rollupPkg = join(root, 'node_modules', 'rollup', 'package.json');
  const pkg = JSON.parse((await import('fs')).readFileSync(rollupPkg, 'utf8'));
  rollupVersion = pkg.version;
} catch {
  // rollup not installed yet — nothing to patch
  process.exit(0);
}

const needed = [
  { pkg: '@rollup/rollup-win32-x64-msvc', dir: 'rollup-win32-x64-msvc' },
  { pkg: '@rollup/rollup-linux-x64-gnu',  dir: 'rollup-linux-x64-gnu' },
];

for (const { pkg, dir } of needed) {
  const target = join(nmDir, dir);
  if (existsSync(target)) {
    continue;
  }

  console.log(`[cross-platform-deps] Installing ${pkg}@${rollupVersion} for cross-platform support...`);
  try {
    // npm pack downloads the tarball without checking the os field
    const tgz = execSync(`npm pack ${pkg}@${rollupVersion} --pack-destination="${root}"`, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim().split('\n').pop();

    const tgzPath = join(root, tgz);

    // Create target directory and extract
    mkdirSync(target, { recursive: true });
    execSync(`tar xzf "${tgzPath}" --strip-components=1 -C "${target}"`, {
      cwd: root,
      stdio: 'pipe',
    });

    // Clean up tarball
    (await import('fs')).unlinkSync(tgzPath);
    console.log(`[cross-platform-deps] ✓ ${pkg}@${rollupVersion} installed`);
  } catch (err) {
    console.warn(`[cross-platform-deps] ⚠ Failed to install ${pkg}: ${err.message}`);
    // Non-fatal — the build will still work on the current platform
  }
}
