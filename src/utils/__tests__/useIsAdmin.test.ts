import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import { useIsAdmin, isAdminOfServer } from '@/utils/useIsAdmin'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

describe('useIsAdmin', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function setupStores(userId: string, serverId: string, roles: string[]) {
    const identityStore = useIdentityStore()
    const serversStore  = useServersStore()
    identityStore.userId = userId
    serversStore.members = {
      [serverId]: {
        [userId]: {
          userId,
          serverId,
          displayName: 'Test User',
          publicSignKey: '',
          publicDHKey: '',
          roles,
          joinedAt: new Date().toISOString(),
          onlineStatus: 'online' as const,
        },
      },
    }
  }

  it('returns true when user has admin role', () => {
    setupStores('user-1', 'server-1', ['admin'])
    const isAdmin = useIsAdmin('server-1')
    expect(isAdmin.value).toBe(true)
  })

  it('returns true when user has owner role', () => {
    setupStores('user-1', 'server-1', ['owner'])
    const isAdmin = useIsAdmin('server-1')
    expect(isAdmin.value).toBe(true)
  })

  it('returns false when user has member role only', () => {
    setupStores('user-1', 'server-1', ['member'])
    const isAdmin = useIsAdmin('server-1')
    expect(isAdmin.value).toBe(false)
  })

  it('returns false when serverId is null', () => {
    setupStores('user-1', 'server-1', ['admin'])
    const isAdmin = useIsAdmin(null)
    expect(isAdmin.value).toBe(false)
  })

  it('accepts a Ref<string | null>', () => {
    setupStores('user-1', 'server-1', ['admin'])
    const sid = ref<string | null>('server-1')
    const isAdmin = useIsAdmin(sid)
    expect(isAdmin.value).toBe(true)
    sid.value = null
    expect(isAdmin.value).toBe(false)
  })

  it('isAdminOfServer returns false when user has no roles', () => {
    setupStores('user-1', 'server-1', [])
    expect(isAdminOfServer('server-1')).toBe(false)
  })

  it('isAdminOfServer returns true for owner', () => {
    setupStores('user-1', 'server-1', ['owner'])
    expect(isAdminOfServer('server-1')).toBe(true)
  })
})
