import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'

/**
 * One-time backfill: creates member_join and channel_create mutations for
 * existing data that predates the mutation-based sync system.
 * Safe to call multiple times — uses a marker key to skip if already done.
 */
export async function backfillMutations(): Promise<number> {
  let count = 0

  // Check if backfill has already run
  const marker = await invoke<string | null>('db_load_key', { keyId: 'mutation_backfill_v1' })
    .catch(() => null)
  if (marker) return 0

  // Backfill member_join for all existing members
  const servers = await invoke<any[]>('db_load_servers').catch(() => [])
  for (const serverRow of servers) {
    const serverId = serverRow.id
    const members = await invoke<any[]>('db_load_members', { serverId }).catch(() => [])
    for (const m of members) {
      const mutation = {
        id:           uuidv7(),
        type:         'member_join',
        target_id:    m.user_id,
        channel_id:   '__server__',
        author_id:    m.user_id,
        new_content:  JSON.stringify({
          userId: m.user_id,
          serverId,
          displayName: m.display_name,
          publicSignKey: m.public_sign_key,
          publicDHKey: m.public_dh_key,
          roles: JSON.parse(m.roles || '["member"]'),
          joinedAt: m.joined_at,
        }),
        logical_ts:   m.joined_at,
        created_at:   m.joined_at,
        verified:     true,
      }
      await invoke('db_save_mutation', { mutation }).catch(() => {})
      count++

      // If member has avatar_hash, also create member_profile_update
      if (m.avatar_hash) {
        const profileMut = {
          id:           uuidv7(),
          type:         'member_profile_update',
          target_id:    m.user_id,
          channel_id:   '__server__',
          author_id:    m.user_id,
          new_content:  JSON.stringify({
            serverId,
            avatarHash: m.avatar_hash,
            displayName: m.display_name,
            bio: m.bio,
            bannerColor: m.banner_color,
            bannerHash: m.banner_hash,
          }),
          logical_ts:   new Date().toISOString(),
          created_at:   new Date().toISOString(),
          verified:     true,
        }
        await invoke('db_save_mutation', { mutation: profileMut }).catch(() => {})
        count++
      }
    }

    // Backfill channel_create for all existing channels
    const channels = await invoke<any[]>('db_load_channels', { serverId }).catch(() => [])
    for (const ch of channels) {
      const mutation = {
        id:           uuidv7(),
        type:         'channel_create',
        target_id:    ch.id,
        channel_id:   '__server__',
        author_id:    serverRow.owner_id,
        new_content:  JSON.stringify({
          id: ch.id,
          serverId,
          name: ch.name,
          type: ch.type,
          position: ch.position,
          topic: ch.topic,
        }),
        logical_ts:   ch.created_at,
        created_at:   ch.created_at,
        verified:     true,
      }
      await invoke('db_save_mutation', { mutation }).catch(() => {})
      count++
    }
  }

  // Mark backfill as complete
  await invoke('db_save_key', { keyId: 'mutation_backfill_v1', keyType: 'system', keyData: new Date().toISOString() })
    .catch(() => {})

  return count
}
