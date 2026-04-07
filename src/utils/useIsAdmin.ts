import { computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'

/**
 * Reactive computed that returns true when the current user is an admin or owner
 * of the given server.  Pass a `Ref<string | null>`, a plain `string`, or `null`.
 */
export function useIsAdmin(serverId: Ref<string | null> | string | null): ComputedRef<boolean> {
  const serversStore  = useServersStore()
  const identityStore = useIdentityStore()

  return computed(() => {
    const sid = typeof serverId === 'string' || serverId === null
      ? serverId
      : serverId.value
    const uid = identityStore.userId
    if (!sid || !uid) return false
    return serversStore.members[sid]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
  })
}

/**
 * Non-reactive helper for use in plain functions (not setup/computed context).
 */
export function isAdminOfServer(serverId: string): boolean {
  const serversStore  = useServersStore()
  const identityStore = useIdentityStore()
  const uid = identityStore.userId
  if (!uid) return false
  return serversStore.members[serverId]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
}
