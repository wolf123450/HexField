/**
 * Tests for JoinView.vue's rendezvous signaling fallback
 * (network-compatibility-plan step 1.1):
 *  - direct/LAN endpoints are tried first; rendezvous fallback is skipped
 *    entirely when one connects
 *  - when no endpoint connects, connectRendezvousForJoin() is called with
 *    the invite's `rendezvous` field
 *  - a rendezvous connection failure (not configured, unreachable, timeout)
 *    surfaces a clear message naming the inviter
 *  - a `peer_unavailable` rejection from waitForPeer surfaces a distinct
 *    "not online" message instead of a generic timeout message
 *  - an already-connected peer (e.g. via mDNS) is not re-dialed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import type { PeerInvite } from '@/types/core'

// ── Mocks ──────────────────────────────────────────────────────────────────

const invokeImpl = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeImpl(...args) }))

const routerReplace = vi.fn()
let routeParams: Record<string, string> = {}
vi.mock('vue-router', () => ({
  useRoute:  () => ({ params: routeParams }),
  useRouter: () => ({ replace: routerReplace }),
}))

const networkStoreMock = {
  connectedPeers:          [] as string[],
  connectRendezvousForJoin: vi.fn().mockResolvedValue(undefined),
  connectToPeer:           vi.fn().mockResolvedValue(undefined),
  waitForPeer:             vi.fn().mockResolvedValue(undefined),
  requestServerManifest:   vi.fn().mockResolvedValue({ server: { id: 'srv-1', name: 'Test Server' } }),
  resyncPeer:              vi.fn(),
}
vi.mock('@/stores/networkStore', () => ({ useNetworkStore: () => networkStoreMock }))

const serversStoreMock = {
  joinFromManifest: vi.fn().mockResolvedValue({ id: 'srv-1', name: 'Test Server' }),
  setActiveServer:  vi.fn(),
}
vi.mock('@/stores/serversStore', () => ({ useServersStore: () => serversStoreMock }))

const channelsStoreMock = {
  channels: {} as Record<string, { id: string; type: string }[]>,
  loadChannels:     vi.fn().mockResolvedValue(undefined),
  setActiveChannel: vi.fn(),
}
vi.mock('@/stores/channelsStore', () => ({ useChannelsStore: () => channelsStoreMock }))

const uiStoreMock = { showNotification: vi.fn() }
vi.mock('@/stores/uiStore', () => ({ useUIStore: () => uiStoreMock }))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({ userId: 'user-joiner' }),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

function encodeInvite(invite: PeerInvite): string {
  return btoa(JSON.stringify(invite)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function baseInvite(overrides: Partial<PeerInvite> = {}): PeerInvite {
  return {
    v: 2,
    userId: 'user-host',
    displayName: 'Alex',
    publicSignKey: 'sign',
    publicDHKey: 'dh',
    endpoints: [],
    serverId: 'srv-1',
    serverName: 'Test Server',
    inviteToken: 'tok',
    ...overrides,
  }
}

async function mountJoinView() {
  const { default: JoinView } = await import('@/views/JoinView.vue')
  const wrapper = mount(JoinView, { global: { plugins: [createTestingPinia()] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  routeParams = {}
  networkStoreMock.connectedPeers = []
  networkStoreMock.connectRendezvousForJoin.mockResolvedValue(undefined)
  networkStoreMock.connectToPeer.mockResolvedValue(undefined)
  networkStoreMock.waitForPeer.mockResolvedValue(undefined)
  invokeImpl.mockResolvedValue(undefined)
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('JoinView — rendezvous signaling fallback', () => {
  it('skips the rendezvous fallback when a direct/LAN endpoint connects', async () => {
    routeParams.inviteCode = encodeInvite(baseInvite({
      endpoints: [{ type: 'lan', addr: '192.168.1.5', port: 4000 }],
      rendezvous: 'https://rdv.example',
    }))

    const wrapper = await mountJoinView()

    expect(invokeImpl).toHaveBeenCalledWith('lan_connect_peer', { userId: 'user-host', addr: '192.168.1.5', port: 4000 })
    expect(networkStoreMock.connectRendezvousForJoin).not.toHaveBeenCalled()
    expect(networkStoreMock.connectToPeer).toHaveBeenCalledWith('user-host')
    expect(wrapper.text()).not.toContain('error')
  })

  it('falls back to the invite\'s rendezvous server when no endpoint connects', async () => {
    invokeImpl.mockRejectedValue(new Error('unreachable'))
    routeParams.inviteCode = encodeInvite(baseInvite({
      endpoints: [{ type: 'direct', addr: '203.0.113.1', port: 4000 }],
      rendezvous: 'https://rdv.example',
    }))

    await mountJoinView()

    expect(networkStoreMock.connectRendezvousForJoin).toHaveBeenCalledWith('user-joiner', 'https://rdv.example')
    expect(networkStoreMock.connectToPeer).toHaveBeenCalledWith('user-host')
    expect(serversStoreMock.joinFromManifest).toHaveBeenCalled()
  })

  it('shows a clear message when rendezvous is not configured and no endpoint worked', async () => {
    invokeImpl.mockRejectedValue(new Error('unreachable'))
    networkStoreMock.connectRendezvousForJoin.mockRejectedValue(
      new Error('No rendezvous server is available for this invite.'),
    )
    routeParams.inviteCode = encodeInvite(baseInvite({ endpoints: [] }))

    const wrapper = await mountJoinView()

    expect(wrapper.text()).toContain('Alex')
    expect(wrapper.text()).toContain('No rendezvous server is available for this invite.')
    expect(wrapper.find('p.error').exists()).toBe(true)
  })

  it('shows a distinct message when the inviter is reported offline', async () => {
    routeParams.inviteCode = encodeInvite(baseInvite({
      endpoints: [{ type: 'lan', addr: '192.168.1.5', port: 4000 }],
    }))
    networkStoreMock.waitForPeer.mockRejectedValue(new Error('peer_unavailable:user-host'))

    const wrapper = await mountJoinView()

    expect(wrapper.text()).toContain('Alex is not online right now')
    expect(serversStoreMock.joinFromManifest).not.toHaveBeenCalled()
  })

  it('shows a generic offline message on a plain waitForPeer timeout', async () => {
    routeParams.inviteCode = encodeInvite(baseInvite({
      endpoints: [{ type: 'lan', addr: '192.168.1.5', port: 4000 }],
    }))
    networkStoreMock.waitForPeer.mockRejectedValue(new Error('Peer connection timed out'))

    const wrapper = await mountJoinView()

    expect(wrapper.text()).toContain('Could not establish a connection to Alex')
  })

  it('does not double-dial a peer already connected (e.g. via mDNS)', async () => {
    routeParams.inviteCode = encodeInvite(baseInvite({
      endpoints: [{ type: 'lan', addr: '192.168.1.5', port: 4000 }],
    }))
    networkStoreMock.connectedPeers = ['user-host']

    await mountJoinView()

    expect(networkStoreMock.connectToPeer).not.toHaveBeenCalled()
    expect(networkStoreMock.waitForPeer).toHaveBeenCalledWith('user-host', 15000)
  })
})
