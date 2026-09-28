import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import { signMutation, mutationToRow } from '@/services/mutationAuth'

/**
 * One-time backfill: creates member_join, member_profile_update and
 * channel_create mutations for existing data that predates the mutation-based
 * sync system. Mutations are signed (spec 08 §5), so only data authored by the
 * local user is backfilled — we cannot sign on behalf of other members.
 * Safe to call multiple times — uses a marker key to skip if already done.
 */
export async function backfillMutations(): Promise<number> {
  let count = 0

  // Check if backfill has already run
  const marker = await invoke<string | null>('db_load_key', { keyId: 'mutation_backfill_v1' })
    .catch(() => null)
  if (marker) return 0

  const { useIdentityStore } = await import('@/stores/identityStore')
  const myId = useIdentityStore().userId
  if (!myId) return 0

  const save = async (m: Parameters<typeof signMutation>[0]) => {
    await invoke('db_save_mutation', { mutation: mutationToRow(signMutation(m)) }).catch(() => {})
    count++
  }

  const servers = await invoke<any[]>('db_load_servers').catch(() => [])
  for (const serverRow of servers) {
    const serverId = serverRow.id
    const members = await invoke<any[]>('db_load_members', { serverId }).catch(() => [])
    const me = members.find(m => m.user_id === myId)
    if (me) {
      await save({
        id:         uuidv7(),
        type:       'member_join',
        targetId:   myId,
        channelId:  '__server__',
        authorId:   myId,
        newContent: JSON.stringify({
          userId: myId,
          serverId,
          displayName: me.display_name,
          publicSignKey: me.public_sign_key,
          publicDHKey: me.public_dh_key,
          // Only the owner may claim elevated roles in a member_join.
          roles: serverRow.owner_id === myId ? ['owner', 'admin'] : ['member'],
          joinedAt: me.joined_at,
        }),
        logicalTs:  me.joined_at,
        createdAt:  me.joined_at,
      })

      // If we have an avatar_hash, also create member_profile_update
      if (me.avatar_hash) {
        const now = new Date().toISOString()
        await save({
          id:         uuidv7(),
          type:       'member_profile_update',
          targetId:   myId,
          channelId:  '__server__',
          authorId:   myId,
          newContent: JSON.stringify({
            serverId,
            avatarHash: me.avatar_hash,
            displayName: me.display_name,
            bio: me.bio,
            bannerColor: me.banner_color,
            bannerHash: me.banner_hash,
          }),
          logicalTs:  now,
          createdAt:  now,
        })
      }
    }

    // Backfill channel_create for all channels of servers we own
    if (serverRow.owner_id !== myId) continue
    const channels = await invoke<any[]>('db_load_channels', { serverId }).catch(() => [])
    for (const ch of channels) {
      await save({
        id:         uuidv7(),
        type:       'channel_create',
        targetId:   ch.id,
        channelId:  '__server__',
        authorId:   myId,
        newContent: JSON.stringify({
          id: ch.id,
          serverId,
          name: ch.name,
          type: ch.type,
          position: ch.position,
          topic: ch.topic,
        }),
        logicalTs:  ch.created_at,
        createdAt:  ch.created_at,
      })
    }
  }

  // Mark backfill as complete
  await invoke('db_save_key', { keyId: 'mutation_backfill_v1', keyType: 'system', keyData: new Date().toISOString() })
    .catch(() => {})

  return count
}
