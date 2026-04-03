/**
 * inspect-dbs.mjs — dump key tables from all dev instance databases
 * Usage:  node scripts/inspect-dbs.mjs
 */
import { createRequire } from 'node:module'
import { join }          from 'node:path'
import { existsSync }    from 'node:fs'
import { homedir }       from 'node:os'

const require = createRequire(import.meta.url)

let Database
try {
  Database = require('better-sqlite3')
} catch {
  console.error('better-sqlite3 not installed — run: npm install --save-dev better-sqlite3')
  process.exit(1)
}

const local  = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const roaming = process.env.APPDATA    ?? join(homedir(), 'AppData', 'Roaming')

const instances = {
  merlin: join(roaming, 'com.gamechat.app', 'gamechat.db'),
  alice:  join(local, 'GameChat-dev', 'alice', 'gamechat.db'),
  bob:    join(local, 'GameChat-dev', 'bob',   'gamechat.db'),
}

for (const [name, dbPath] of Object.entries(instances)) {
  if (!existsSync(dbPath)) {
    console.log(`\n=== ${name.toUpperCase()} : NOT FOUND (${dbPath})\n`)
    continue
  }
  const db = new Database(dbPath, { readonly: true })
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${name.toUpperCase()}  —  ${dbPath}`)
  console.log(`${'═'.repeat(60)}`)

  // Servers
  const servers = db.prepare('SELECT id, name, owner_id FROM servers').all()
  console.log(`\nSERVERS (${servers.length}):`)
  servers.forEach(r => console.log(`  ${r.id.slice(0,8)}  "${r.name}"  owner:${r.owner_id.slice(0,8)}`))

  // Members
  const members = db.prepare(`
    SELECT user_id, server_id, display_name,
           length(public_sign_key) sk_len,
           length(public_dh_key)   dh_len,
           online_status
    FROM members`).all()
  console.log(`\nMEMBERS (${members.length}):`)
  members.forEach(r => console.log(
    `  uid:${r.user_id.slice(0,8)}  srv:${r.server_id.slice(0,8)}  ` +
    `"${r.display_name}"  sk:${r.sk_len??0}  dh:${r.dh_len??0}  ${r.online_status}`
  ))

  // Messages — last 10 with plaintext content (stored unencrypted locally)
  const msgs = db.prepare(`
    SELECT m.id, m.channel_id, m.author_id, m.content, m.verified, m.logical_ts
    FROM messages m
    ORDER BY m.logical_ts DESC LIMIT 10`).all()
  console.log(`\nMESSAGES — last ${msgs.length} (newest first):`)
  msgs.forEach(r => console.log(
    `  ${r.logical_ts}  aid:${r.author_id.slice(0,8)}  ` +
    `v:${r.verified}  "${(r.content??'').slice(0,60)}"`
  ))

  // Key store — show key IDs only, not values
  const keys = db.prepare('SELECT key_id, key_type FROM key_store ORDER BY created_at').all()
  console.log(`\nKEY_STORE (${keys.length} entries):`)
  keys.forEach(r => console.log(`  ${r.key_type.padEnd(20)} ${r.key_id}`))

  db.close()
}
