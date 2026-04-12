import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { signalingService } from '@/services/signalingService'
import type { SignalPayload } from '@/services/signalingService'
import { WebRTCService, webrtcService } from '@/services/webrtcService'
import { startSync, handleSyncMessage, setSendFn } from '@/services/syncService'
import type { SyncWireMessage } from '@/services/syncService'
import type { ServerManifest } from '@/types/core'
import * as attachmentService from '@/services/attachmentService'
import { detectNATType } from '@/utils/natDetection'
import type { NATType } from '@/utils/natDetection'
import { cryptoService } from '@/services/cryptoService'
import {
  isValidChatMessage,
  isValidPresenceUpdate,
  isValidMutation,
  isValidTypingStart,
  isValidProfileUpdate,
  isValidVoiceJoin,
} from '@/utils/peerValidator'
import { logger } from '@/utils/logger'

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error'

export const useNetworkStore = defineStore('network', () => {
  const signalingState   = ref<SignalingState>('disconnected')
  const serverUrl        = ref<string>('')
  const reconnectAttempt = ref<number>(0)
  const natType          = ref<NATType>('pending')
  /** Own external IP:port discovered by STUN (null until NAT detection completes). */
  const ownPublicAddr    = ref<{ ip: string; port: number } | null>(null)
  /** Peers that are relay-capable: userId → relayAddr string (e.g. '203.0.113.1:3479'). */
  const relayCapablePeers = ref<Record<string, string>>({})
  const connectedPeers   = ref<string[]>([])
  // userId -> { channelId, timestamp }
  const typingUsers      = ref<Record<string, { channelId: string; timeout: ReturnType<typeof setTimeout> }>>({})

  // Pending server-join request: resolve/reject when server_manifest arrives
  let _pendingServerJoin: {
    resolve: (m: ServerManifest) => void
    reject:  (e: Error) => void
  } | null = null

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let initialized = false
  /** Snapshot of custom TURN servers from settingsStore — refreshed on init. */
  let _cachedCustomTURN: RTCIceServer[] = []

  /** Rendezvous server auth token (userId after verified challenge). */
  let _rendezvousToken: string | null = null
  /** TURN credentials obtained from rendezvous server. */
  let _turnCredentials: { urls: string[]; username: string; credential: string } | null = null

  // ── Rate limiter ───────────────────────────────────────────────────────────
  // Limit inbound data-channel messages per peer to prevent flooding.
  // Set high enough to accommodate burst sync traffic (negentropy + push chunks)
  // while still blocking malicious flooding.
  const RATE_LIMIT = 100          // max messages per window
  const RATE_WINDOW_MS = 1000     // 1-second sliding window
  const peerMessageCounts = new Map<string, { count: number; windowStart: number }>()

  function isRateLimited(userId: string): boolean {
    const now = Date.now()
    const entry = peerMessageCounts.get(userId)
    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      peerMessageCounts.set(userId, { count: 1, windowStart: now })
      return false
    }
    entry.count++
    if (entry.count > RATE_LIMIT) {
      logger.warn('network', `rate limit exceeded for peer ${userId}`)
      return true
    }
    return false
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  // Keep peers' online status accurate without relying solely on WebRTC teardown.
  // Interval is intentionally short for development; production can use a longer value.
  const HEARTBEAT_INTERVAL_MS = 10_000  // send / check every 10 s
  const HEARTBEAT_TIMEOUT_MS  = 25_000  // mark offline after 25 s of silence
  const lastHeartbeatFrom = new Map<string, number>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  function startHeartbeat() {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(async () => {
      // Broadcast our own status, scoped to this user's key so multiple instances
      // on the same machine don't read each other's status from shared localStorage.
      const { useIdentityStore } = await import('./identityStore')
      const identityStore = useIdentityStore()
      if (identityStore.userId) {
        const statusKey = `hexfield_own_status_${identityStore.userId}`
        const ownStatus = localStorage.getItem(statusKey) ?? 'online'
        if (ownStatus !== 'offline') {
          broadcast({
            type:      'presence_update',
            userId:    identityStore.userId,
            status:    ownStatus,
            timestamp: Date.now(),
          })
        }
      }
      // Watchdog: mark peers offline if we haven't heard from them recently.
      const now = Date.now()
      const { useServersStore } = await import('./serversStore')
      const serversStore = useServersStore()
      for (const peerId of [...connectedPeers.value]) {
        const last = lastHeartbeatFrom.get(peerId) ?? 0
        if (now - last > HEARTBEAT_TIMEOUT_MS) {
          handlePresenceUpdate(peerId, { status: 'offline' })
        }
      }
      // Also mark any non-connected peer that still shows online in any server.
      for (const sid of serversStore.joinedServerIds) {
        for (const [uid, m] of Object.entries(serversStore.members[sid] ?? {})) {
          if (m.onlineStatus !== 'offline' && !connectedPeers.value.includes(uid)
              && uid !== (await import('./identityStore')).useIdentityStore().userId) {
            serversStore.updateMemberStatus(sid, uid, 'offline')
          }
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * Initialize the networking layer: register signal/WebRTC handlers.
   * Called once at app startup after identity is loaded.
   */
  async function init(localUserId: string) {
    if (initialized) return
    initialized = true

    // Initialize signalingService with handlers
    await signalingService.init(
      handleSignalMessage,
      handleStateChange,
    )

    // Give syncService a way to send to peers
    setSendFn((peerId, data) => webrtcService.sendToPeer(peerId, data))

    // Warn when the system WebView doesn't have WebRTC compiled in (e.g. Ubuntu
    // 24.04 ships libwebkit2gtk without WebRTC; the setting exists but is a no-op).
    // Peer-to-peer connections will silently fail, so surface a clear message.
    if (!WebRTCService.isAvailable()) {
      const { useUIStore } = await import('./uiStore')
      useUIStore().showAlert(
        'Peer-to-peer connections unavailable',
        'Your system WebView does not include WebRTC.\n\n' +
        'LAN discovery, peer connections, and voice will not work on this device.\n\n' +
        'To fix this on Ubuntu 24.04:\n' +
        '  1. sudo add-apt-repository ppa:escalion/ppa-webkit2gtk-experimental\n' +
        '  2. sudo apt update && sudo apt upgrade\n' +
        '  3. sudo apt-get install -y gstreamer1.0-plugins-bad gstreamer1.0-nice libnice10\n\n' +
        'Alternatively, use Arch/Fedora/openSUSE, or distribute as a Flatpak.',
      )
    }

    // Initialize webrtcService
    webrtcService.init(
      localUserId,
      handleDataChannelMessage,
      (userId) => {
        if (!connectedPeers.value.includes(userId)) {
          connectedPeers.value = [...connectedPeers.value, userId]
        }
        logger.info('network', 'peer connected:', userId)
        // Gossip identity first — member keys must be queued on the data channel
        // before startSync sends sync_neg_init, so the remote decrypts our messages
        // in the right order (SCTP preserves send order).
        gossipOwnDevice(userId).catch(e => logger.warn('network', 'gossipOwnDevice error:', e))
        gossipOwnPresence(userId).catch(e => logger.warn('network', 'gossipOwnPresence error:', e))
        // Record heartbeat baseline so the watchdog doesn't immediately time this peer out.
        lastHeartbeatFrom.set(userId, Date.now())
        // Start history reconciliation with newly connected peer
        startSync(userId).catch(e => logger.warn('network', 'sync start error:', e))
      },
      (userId) => {
        // Destroy the stale PeerState so reconnections start fresh.
        // Without this, createOffer() silently no-ops for a peer that's already
        // in the map, and handleOffer() may receive an offer with mismatched
        // m-line ordering because the new remote session has no prior history.
        webrtcService.destroyPeer(userId)
        connectedPeers.value = connectedPeers.value.filter(id => id !== userId)
        logger.info('network', 'peer disconnected:', userId)
        lastHeartbeatFrom.delete(userId)
        peerMessageCounts.delete(userId)
        // Clear any pending typing indicator for this peer
        if (typingUsers.value[userId]) {
          clearTimeout(typingUsers.value[userId].timeout)
          const { [userId]: _removed, ...rest } = typingUsers.value
          typingUsers.value = rest
        }
        // Mark peer as offline across all server member maps
        handlePresenceUpdate(userId, { status: 'offline' })
        // Clean up voice state if the peer disconnects
        handleVoicePeerDisconnect(userId)
      },
    )

    // Listen for mDNS-discovered peers (auto-connect on same LAN).
    await listen<{ userId: string; addr: string; port: number }>(
      'lan_peer_discovered',
      ({ payload }) => handleLanPeerDiscovered(payload.userId, payload.addr, payload.port, localUserId),
    )

    // lan_peer_lost is handled implicitly — WebRTC disconnection fires
    // the onPeerDisconnected callback above; no extra action needed.

    // Relay Rust-native WebRTC signaling events out through the signaling transport.
    // NOTE: 'from' must be included so remote peers know who sent the signal;
    // the old browser-RTCPeerConnection implementation always set this explicitly.

    // Listen for incoming media tracks from Rust WebRTC on_track callback
    listen<{ userId: string; kind: string; trackId: string; streamId: string }>(
      'webrtc_track',
      async ({ payload }) => {
        if (payload.kind === 'audio') {
          // Audio is handled entirely in Rust (MediaManager) — just update voice UI
          const { useVoiceStore } = await import('./voiceStore')
          useVoiceStore().updatePeer(payload.userId, { audioEnabled: true })
        }
        // Video tracks are decoded in Rust — frames arrive via media_video_frame event
      },
    ).catch(e => logger.warn('network', 'webrtc_track listen failed:', e))

    // Incoming decoded video frames from Rust screen share pipeline
    listen<{ userId: string; frameNumber: number; path: string }>(
      'media_video_frame',
      async ({ payload }) => {
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const { useVoiceStore } = await import('./voiceStore')
        const voiceStore = useVoiceStore()
        const url = convertFileSrc(payload.path) + `?v=${payload.frameNumber}`
        voiceStore.screenFrameUrls[payload.userId] = url
        voiceStore.updatePeer(payload.userId, { screenSharing: true })
      },
    ).catch(e => logger.warn('network', 'media_video_frame listen failed:', e))

    listen<{ userId: string }>(
      'media_screen_share_stopped',
      async ({ payload }) => {
        const { useVoiceStore } = await import('./voiceStore')
        const voiceStore = useVoiceStore()
        delete voiceStore.screenFrameUrls[payload.userId]
        voiceStore.updatePeer(payload.userId, { screenSharing: false })
      },
    ).catch(e => logger.warn('network', 'media_screen_share_stopped listen failed:', e))

    listen<{ to: string; sdp: string }>('webrtc_offer', ({ payload }) => {
      sendSignal({ type: 'signal_offer', to: payload.to, from: localUserId, sdp: payload.sdp })
        .catch(e => logger.warn('webrtc', 'relay webrtc_offer error:', e))
    }).catch(e => logger.warn('webrtc', 'webrtc_offer listen failed:', e))

    listen<{ to: string; sdp: string }>('webrtc_answer', ({ payload }) => {
      sendSignal({ type: 'signal_answer', to: payload.to, from: localUserId, sdp: payload.sdp })
        .catch(e => logger.warn('webrtc', 'relay webrtc_answer error:', e))
    }).catch(e => logger.warn('webrtc', 'webrtc_answer listen failed:', e))

    listen<{ to: string; candidate: string; sdpMid: string | null; sdpMlineIndex: number | null }>(
      'webrtc_ice', ({ payload }) => {
        sendSignal({
          type: 'signal_ice',
          to: payload.to,
          from: localUserId,
          candidate: { candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMlineIndex },
        }).catch(e => logger.warn('webrtc', 'relay webrtc_ice error:', e))
      },
    ).catch(e => logger.warn('webrtc', 'webrtc_ice listen failed:', e))

    startHeartbeat()

    // Register the chunk-request function so attachmentService can ask peers for chunks.
    attachmentService.setRequestChunksFn((contentHash, peerId, chunkIndices) => {
      webrtcService.sendToPeer(peerId, {
        type: 'attachment_chunk_request',
        contentHash: `blake3:${contentHash}`,
        chunkIndices,
      })
    })

    // NAT detection — run after WebRTC is initialised (off the critical path).
    detectNATType().then(async (type) => {
      natType.value = type
      // Cache own public address from a single STUN probe for relay advertisement.
      if (type !== 'symmetric') {
        const { querySTUN } = await import('@/utils/natDetection')
        const addr = await querySTUN('stun.l.google.com:19302')
        if (addr) {
          ownPublicAddr.value = addr
          // Store public IP in Rust AppState for UPnP endpoint generation
          invoke('set_public_ip', { ip: addr.ip }).catch(() => {})
        }
      }
      logger.debug('network', `NAT type: ${type}`)
    }).catch(e => logger.warn('network', 'NAT detection error:', e))

    // Inject a per-peer ICE config builder so relay peers and custom TURN
    // servers are automatically used for new connections.
    // Sync the custom TURN cache from settings immediately so buildICEConfig
    // has the right values on first connection attempt.
    import('@/stores/settingsStore').then(({ useSettingsStore }) => {
      _cachedCustomTURN = useSettingsStore().settings.customTURNServers ?? []
    }).catch(() => { /* ignore in tests */ })

    webrtcService.setICEConfigBuilder(buildICEConfig)

    // Auto-connect to rendezvous server if configured
    connectToRendezvous(localUserId).catch(e =>
      logger.warn('network', 'Rendezvous connection failed:', e),
    )
  }

  /**
   * Challenge-response authenticate with the rendezvous server and open a
   * WebSocket for signal relay + presence.  Non-fatal — failures are logged.
   */
  async function connectToRendezvous(localUserId: string) {
    const { useSettingsStore } = await import('./settingsStore')
    const { useIdentityStore } = await import('./identityStore')
    const settingsStore = useSettingsStore()
    const identityStore = useIdentityStore()
    const rendezvousUrl = settingsStore.settings.rendezvousServerUrl
    if (!rendezvousUrl) return

    // 1. Request challenge nonce
    const challengeResp = await fetch(`${rendezvousUrl}/auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: localUserId,
        public_sign_key: identityStore.publicSignKey ?? '',
        public_dh_key: identityStore.publicDHKey ?? '',
        display_name: identityStore.displayName,
      }),
    })
    if (!challengeResp.ok) throw new Error('Challenge request failed')
    const { challenge } = await challengeResp.json()

    // 2. Sign challenge with Ed25519 key
    const signature = cryptoService.sign(new TextEncoder().encode(challenge))

    // 3. Verify signature with server — receive bearer token
    const verifyResp = await fetch(`${rendezvousUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: localUserId,
        public_sign_key: identityStore.publicSignKey ?? '',
        public_dh_key: identityStore.publicDHKey ?? '',
        display_name: identityStore.displayName,
        signature,
      }),
    })
    if (!verifyResp.ok) throw new Error('Auth verify failed')
    const { token } = await verifyResp.json()
    _rendezvousToken = token
    logger.info('network', 'Authenticated with rendezvous server')

    // 4. Connect WebSocket through the WS signaling relay
    const wsScheme = rendezvousUrl.startsWith('https') ? 'wss' : 'ws'
    const wsBase = rendezvousUrl.replace(/^https?/, wsScheme)
    const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}&public_sign_key=${encodeURIComponent(identityStore.publicSignKey ?? '')}`
    await signalingService.connect(wsUrl)
    logger.info('network', 'Connected to rendezvous WS')

    // 5. Fetch TURN credentials (non-fatal)
    try {
      const turnResp = await fetch(`${rendezvousUrl}/turn/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: localUserId }),
      })
      if (turnResp.ok) {
        _turnCredentials = await turnResp.json()
        logger.info('network', 'TURN credentials obtained')
      }
    } catch (e) { logger.warn('network', 'TURN fetch failed:', e) }
  }

  /**
   * Build a per-peer RTCIceServer list.
   * Priority: public STUN → relay-capable peers (if we need relay) → custom TURN → rendezvous TURN.
   * NOTE: This is called synchronously from RTCPeerConnection constructor, so we
   * read settingsStore state via a cached reference set in init().
   */
  function buildICEConfig(_targetUserId: string): RTCIceServer[] {
    const base: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]

    // Only add TURN candidates when we're behind symmetric NAT (or unknown) —
    // for open/restricted NAT, plain STUN is sufficient.
    const needRelay = natType.value === 'symmetric' || natType.value === 'unknown' || natType.value === 'pending'

    if (needRelay) {
      for (const [peerId, relayAddr] of Object.entries(relayCapablePeers.value)) {
        base.push({
          urls:       `turn:${relayAddr}`,
          username:   _targetUserId,
          credential: peerId,
        })
      }
    }

    // User-configured custom TURN servers are always appended (regardless of NAT type).
    if (_cachedCustomTURN.length > 0) {
      base.push(..._cachedCustomTURN)
    }

    // Rendezvous-provided TURN credentials (from coturn shared-secret scheme).
    if (_turnCredentials) {
      base.push({
        urls:       _turnCredentials.urls,
        username:   _turnCredentials.username,
        credential: _turnCredentials.credential,
      })
    }

    return base
  }

  /**
   * Connect to a rendezvous signaling server.
   */
  async function connect(url: string) {
    if (!url) return
    serverUrl.value = url
    reconnectAttempt.value = 0
    await signalingService.connect(url)
  }

  /**
   * Disconnect from the signaling server and tear down all peers.
   */
  async function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stopHeartbeat()
    reconnectAttempt.value = 0
    webrtcService.destroyAll()
    connectedPeers.value = []
    // Remove UPnP port mapping (non-fatal)
    invoke('upnp_remove_mapping').catch(() => {})
    await signalingService.disconnect()
  }

  /**
   * Send a signaling payload (routes through WS to rendezvous server).
   */
  async function sendSignal(payload: SignalPayload) {
    const signed = cryptoService.signJson(payload as Record<string, unknown>)
    await signalingService.send(signed as unknown as SignalPayload)
  }

  /**
   * Send data to a specific peer over WebRTC data channel.
   */
  function sendToPeer(userId: string, data: unknown): boolean {
    return webrtcService.sendToPeer(userId, data)
  }

  /**
   * Broadcast data to all connected peers via WebRTC data channels.
   */
  function broadcast(data: unknown) {
    webrtcService.broadcast(data)
  }

  /**
   * Initiate a WebRTC connection to a specific peer.
   */
  async function connectToPeer(userId: string) {
    logger.debug('network', 'createOffer →', userId)
    await webrtcService.createOffer(userId)
  }

  // ── Typing indicators ──────────────────────────────────────────────────────

  function sendTypingStart(channelId: string) {
    broadcast({ type: 'typing_start', channelId })
  }

  function sendTypingStop(channelId: string) {
    broadcast({ type: 'typing_stop', channelId })
  }

  function getTypingUsers(channelId: string): string[] {
    return Object.entries(typingUsers.value)
      .filter(([, v]) => v.channelId === channelId)
      .map(([userId]) => userId)
  }

  // ── Internal handlers ──────────────────────────────────────────────────────

  function handleStateChange(state: string) {
    signalingState.value = state as SignalingState

    if (state === 'disconnected' && serverUrl.value) {
      // Auto-reconnect with exponential backoff
      reconnectAttempt.value++
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.value - 1), 60000)
      reconnectTimer = setTimeout(() => {
        signalingService.connect(serverUrl.value)
      }, delay)
    } else if (state === 'connected') {
      reconnectAttempt.value = 0
    }
  }

  function handleSignalMessage(payload: SignalPayload) {
    const from = payload.from as string | undefined
    if (!from) return

    // Verify Ed25519 signature if present (soft check — backward compat with unsigned peers)
    const asObj = payload as unknown as Record<string, unknown>
    if (asObj['__sig']) {
      const senderKey = cryptoService.verifyJsonSignature(asObj)
      if (!senderKey) {
        logger.warn('network', 'signal from', from, 'has invalid signature — dropped')
        return
      }
    }

    logger.debug('network', 'signal rx:', payload.type, 'from:', from)
    switch (payload.type) {
      case 'signal_offer':
        webrtcService.handleOffer(from, payload.sdp as string).catch(e => logger.warn('webrtc', 'signal_offer unhandled:', e))
        break
      case 'signal_answer':
        webrtcService.handleAnswer(from, payload.sdp as string).catch(e => logger.warn('webrtc', 'signal_answer unhandled:', e))
        break
      case 'signal_ice':
        webrtcService.handleIceCandidate(from, payload.candidate as RTCIceCandidateInit).catch(e => logger.warn('webrtc', 'signal_ice unhandled:', e))
        break
      default:
        // Other signaling messages (presence, relay, etc.) can be dispatched here
        handleDataChannelMessage(from, payload)
        break
    }
  }

  function handleDataChannelMessage(userId: string, data: unknown) {
    const msg = data as Record<string, unknown>
    if (!msg || typeof msg !== 'object' || !msg.type) return

    if (isRateLimited(userId)) return

    switch (msg.type) {
      case 'chat_message':
        if (!isValidChatMessage(msg)) { logger.warn('network', 'invalid chat_message from', userId); return }
        handleChatMessage(userId, msg)
        break
      case 'typing_start':
        if (!isValidTypingStart(msg)) { logger.warn('network', 'invalid typing_start from', userId); return }
        handleTypingStart(userId, msg.channelId as string)
        break
      case 'typing_stop':
        handleTypingStopEvent(userId)
        break
      case 'mutation':
        if (!isValidMutation(msg)) { logger.warn('network', 'invalid mutation from', userId); return }
        handleMutationMessage(msg)
        break
      case 'emoji_image_request':
        handleEmojiImageRequest(userId, msg)
        break
      case 'emoji_image':
        handleEmojiImage(msg)
        break
      case 'device_link_request':
        handleDeviceLinkRequest(userId, msg)
        break
      case 'device_link_confirm':
        handleDeviceLinkConfirm(msg)
        break
      case 'device_attest':
        handleDeviceAttest(msg)
        break
      case 'presence_update':
        if (!isValidPresenceUpdate(msg)) { logger.warn('network', 'invalid presence_update from', userId); return }
        handlePresenceUpdate(userId, msg)
        break
      case 'profile_update':
        if (!isValidProfileUpdate(msg)) { logger.warn('network', 'invalid profile_update from', userId); return }
        handleProfileUpdate(userId, msg)
        break
      case 'profile_request':
        handleProfileRequest(userId)
        break
      case 'server_avatar_update':
        handleServerAvatarUpdate(msg).catch(e =>
          logger.warn('network', 'server_avatar_update error:', e)
        )
        break
      case 'voice_join':
        if (!isValidVoiceJoin(msg)) { logger.warn('network', 'invalid voice_join from', userId); return }
        handleVoiceJoin(userId, msg)
        break
      case 'voice_leave':
        handleVoiceLeave(userId)
        break
      case 'voice_screen_share_start':
        handleVoiceScreenShareStart(userId)
        break
      case 'voice_screen_share_stop':
        handleVoiceScreenShareStop(userId)
        break
      case 'sync_neg_init':
      case 'sync_neg_reply':
      case 'sync_push':
      case 'sync_want':
        handleSyncMessage(userId, msg as unknown as SyncWireMessage).catch(e =>
          logger.warn('network', 'sync message error:', e)
        )
        break
      case 'server_join_request':
        handleServerJoinRequest(userId, msg).catch(e =>
          logger.warn('network', 'server_join_request error:', e)
        )
        break
      case 'attachment_want':
        handleAttachmentWant(userId, msg).catch(e =>
          logger.warn('network', 'attachment_want error:', e)
        )
        break
      case 'attachment_have':
        handleAttachmentHave(userId, msg)
        break
      case 'attachment_chunk_request':
        handleAttachmentChunkRequest(userId, msg).catch(e =>
          logger.warn('network', 'attachment_chunk_request error:', e)
        )
        break
      case 'attachment_chunk':
        handleAttachmentChunk(msg).catch(e =>
          logger.warn('network', 'attachment_chunk error:', e)
        )
        break
      case 'server_manifest':
        handleServerManifestReceived(msg)
        break
      case 'server_join_denied':
        handleServerJoinDenied(msg)
        break
      default:
        logger.debug('network', 'unhandled data message type:', msg.type)
    }
  }

  async function handleChatMessage(_userId: string, msg: Record<string, unknown>) {
    const { useMessagesStore } = await import('./messagesStore')
    const messagesStore = useMessagesStore()
    messagesStore.receiveEncryptedMessage(msg)
  }

  async function handleMutationMessage(msg: Record<string, unknown>) {
    const raw = msg.mutation as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return
    const { useMessagesStore } = await import('./messagesStore')
    const messagesStore = useMessagesStore()
    const mutation = {
      id:         raw.id as string,
      type:       raw.type as any,
      targetId:   raw.targetId as string,
      channelId:  raw.channelId as string,
      authorId:   raw.authorId as string,
      emojiId:    raw.emojiId as string | undefined,
      newContent: raw.newContent as string | undefined,
      logicalTs:  raw.logicalTs as string,
      createdAt:  raw.createdAt as string,
      verified:   true,
    }
    await messagesStore.applyMutation(mutation)
    // Server-level mutations also update in-memory server/member state
    if (['server_update', 'role_assign', 'role_revoke',
         'member_kick', 'member_ban', 'member_unban',
         'access_mode_update'].includes(mutation.type)) {
      const { useServersStore } = await import('./serversStore')
      const serversStore = useServersStore()
      serversStore.applyServerMutation(mutation)

      // Notify the local user if they were kicked or banned
      if (mutation.type === 'member_kick' || mutation.type === 'member_ban') {
        const { useIdentityStore } = await import('./identityStore')
        const myId = useIdentityStore().userId
        if (myId && mutation.targetId === myId && mutation.newContent) {
          const { serverId, reason } = JSON.parse(mutation.newContent) as { serverId: string; reason?: string }
          const server = serversStore.servers[serverId]
          const serverName = server?.name ?? 'the server'
          const action = mutation.type === 'member_ban' ? 'banned from' : 'removed from'
          const msg2 = reason ? `You were ${action} ${serverName}: ${reason}` : `You were ${action} ${serverName}`
          const { useUIStore } = await import('./uiStore')
          useUIStore().showNotification(msg2, 'warning')
        }
      }
    }

    // Voice-level mutations
    if (mutation.type === 'voice_kick' && mutation.newContent) {
      const { channelId, reason } = JSON.parse(mutation.newContent) as { channelId: string; reason?: string }
      const { useVoiceStore } = await import('./voiceStore')
      const voiceStore = useVoiceStore()
      const { useIdentityStore } = await import('./identityStore')
      const myId = useIdentityStore().userId

      if (myId && mutation.targetId === myId) {
        // I was kicked — leave the voice channel if I'm in the kicked channel
        if (voiceStore.session?.channelId === channelId) {
          await voiceStore.leaveVoiceChannel()
          const msg2 = reason ? `You were removed from voice: ${reason}` : 'You were removed from voice by an admin'
          const { useUIStore } = await import('./uiStore')
          useUIStore().showNotification(msg2, 'warning')
        }
      } else {
        // Someone else was kicked — remove them from voice peer state
        if (voiceStore.peerVoiceChannels[mutation.targetId] === channelId) {
          voiceStore.removePeer(mutation.targetId)
          voiceStore.clearPeerVoiceChannel(mutation.targetId)
        }
      }
    }

    if (mutation.type === 'voice_mute' || mutation.type === 'voice_unmute') {
      const muting = mutation.type === 'voice_mute'
      const { reason } = mutation.newContent ? (JSON.parse(mutation.newContent) as { reason?: string }) : {}
      const { useVoiceStore } = await import('./voiceStore')
      const voiceStore = useVoiceStore()
      const { useIdentityStore } = await import('./identityStore')
      const myId = useIdentityStore().userId

      if (myId && mutation.targetId === myId) {
        // I was admin-muted/unmuted
        voiceStore.setAdminMuted(muting)
        if (muting) {
          const { useUIStore } = await import('./uiStore')
          const msg3 = reason ? `You were muted by an admin: ${reason}` : 'You were muted by an admin'
          useUIStore().showNotification(msg3, 'warning')
        }
      } else {
        // Another peer was muted/unmuted — update their peer entry
        voiceStore.updatePeer(mutation.targetId, { adminMuted: muting })
      }
    }

    if (mutation.type === 'channel_acl_update' && mutation.newContent) {
      const { useChannelsStore } = await import('./channelsStore')
      await useChannelsStore().persistAndSetAcl(JSON.parse(mutation.newContent))
    }

    // Channel mutations
    if (['channel_create', 'channel_update', 'channel_delete'].includes(mutation.type)) {
      const { useChannelsStore } = await import('./channelsStore')
      await useChannelsStore().applyChannelMutation(mutation)
    }

    // Member mutations
    if (mutation.type === 'member_join' && mutation.newContent) {
      const { useServersStore } = await import('./serversStore')
      const serversStore = useServersStore()
      const payload = JSON.parse(mutation.newContent)
      if (payload.serverId && payload.userId) {
        if (!serversStore.members[payload.serverId]) serversStore.members[payload.serverId] = {}
        serversStore.members[payload.serverId][payload.userId] = {
          userId: payload.userId,
          serverId: payload.serverId,
          displayName: payload.displayName ?? '',
          roles: payload.roles ?? ['member'],
          joinedAt: payload.joinedAt ?? mutation.createdAt,
          publicSignKey: payload.publicSignKey ?? '',
          publicDHKey: payload.publicDHKey ?? '',
          onlineStatus: 'offline',
        }
      }
    }

    if (mutation.type === 'member_profile_update' && mutation.newContent) {
      const { useServersStore } = await import('./serversStore')
      const serversStore = useServersStore()
      const patch = JSON.parse(mutation.newContent)
      if (patch.serverId) {
        serversStore.updateMemberProfile(patch.serverId, mutation.targetId, patch)
      }
      // Trigger image fetch for new hashes
      const hashesToFetch = [patch.avatarHash, patch.bannerHash].filter(Boolean) as string[]
      for (const hash of hashesToFetch) {
        const has = await invoke<boolean>('has_attachment', { contentHash: hash }).catch(() => false)
        if (!has) {
          broadcast({ type: 'attachment_want', contentHash: hash, messageId: '' })
        }
      }
    }

    // Emoji mutations
    if (mutation.type === 'emoji_add' && mutation.newContent) {
      const { useEmojiStore } = await import('./emojiStore')
      useEmojiStore().applyEmojiAddMutation(JSON.parse(mutation.newContent))
    }
    if (mutation.type === 'emoji_remove') {
      const { useEmojiStore } = await import('./emojiStore')
      useEmojiStore().applyEmojiRemoveMutation(mutation.targetId)
    }
  }

  async function handleEmojiImageRequest(fromUserId: string, msg: Record<string, unknown>) {
    const emojiId = msg.emojiId as string
    if (!emojiId) return
    const { useEmojiStore } = await import('./emojiStore')
    const emojiStore = useEmojiStore()
    // Find which server this emoji belongs to
    for (const [serverId, serverEmoji] of Object.entries(emojiStore.custom)) {
      if (serverEmoji[emojiId]) {
        try {
          const dataUrl = await emojiStore.getEmojiImage(emojiId, serverId)
          // Strip data URI prefix and send raw base64
          const base64 = dataUrl.replace('data:image/webp;base64,', '')
          const bytes = Array.from(atob(base64), c => c.charCodeAt(0))
          webrtcService.sendToPeer(fromUserId, { type: 'emoji_image', emojiId, imageBytes: bytes })
        } catch {
          // Ignore — peer will retry later
        }
        break
      }
    }
  }

  async function handleEmojiImage(msg: Record<string, unknown>) {
    const emojiId    = msg.emojiId as string
    const imageBytes = msg.imageBytes as number[]
    if (!emojiId || !imageBytes) return
    const { useEmojiStore } = await import('./emojiStore')
    const emojiStore = useEmojiStore()
    // Find server for this emoji (metadata must have arrived via emoji_sync first)
    for (const [serverId, serverEmoji] of Object.entries(emojiStore.custom)) {
      if (serverEmoji[emojiId]) {
        await emojiStore.storeEmojiImage(emojiId, serverId, imageBytes)
        break
      }
    }
  }

  function handleTypingStart(userId: string, channelId: string) {
    // Clear existing timeout for this user
    if (typingUsers.value[userId]) {
      clearTimeout(typingUsers.value[userId].timeout)
    }

    // Auto-expire after 5 seconds
    const timeout = setTimeout(() => {
      delete typingUsers.value[userId]
      typingUsers.value = { ...typingUsers.value }
    }, 5000)

    typingUsers.value = {
      ...typingUsers.value,
      [userId]: { channelId, timeout },
    }
  }

  async function gossipOwnDevice(peerId: string) {
    const { useDevicesStore } = await import('./devicesStore')
    const devicesStore = useDevicesStore()
    if (!devicesStore.deviceId || !devicesStore.deviceSignKey || !devicesStore.deviceDHKey) return
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    if (!identityStore.userId) return
    webrtcService.sendToPeer(peerId, {
      type:         'device_attest',
      device: {
        deviceId:      devicesStore.deviceId,
        userId:        identityStore.userId,
        publicSignKey: devicesStore.deviceSignKey,
        publicDHKey:   devicesStore.deviceDHKey,
        attestedBy:    null,
        attestationSig: null,
        revoked:       false,
        createdAt:     new Date().toISOString(),
      },
    })
  }

  async function handlePresenceUpdate(fromUserId: string, msg: Record<string, unknown>) {
    const status = msg.status as string
    if (!status) return
    // Treat any incoming presence as a heartbeat from that peer.
    if (status !== 'offline') lastHeartbeatFrom.set(fromUserId, Date.now())

    // Track relay capability — used by buildICEConfig for future peer connections.
    if (msg.relayCapable === true && typeof msg.relayAddr === 'string') {
      relayCapablePeers.value = { ...relayCapablePeers.value, [fromUserId]: msg.relayAddr }
    } else if (status === 'offline') {
      const updated = { ...relayCapablePeers.value }
      delete updated[fromUserId]
      relayCapablePeers.value = updated
    }

    const { useServersStore } = await import('./serversStore')
    const serversStore = useServersStore()
    for (const sid of serversStore.joinedServerIds) {
      serversStore.updateMemberStatus(sid, fromUserId, status as any)
    }
  }

  async function handleProfileUpdate(fromUserId: string, msg: Record<string, unknown>) {
    const payload = msg.payload as Record<string, unknown> | undefined
    if (!payload) return
    const { useServersStore } = await import('./serversStore')
    const serversStore = useServersStore()
    for (const sid of serversStore.joinedServerIds) {
      serversStore.updateMemberProfile(sid, fromUserId, {
        displayName:   payload.displayName   as string | undefined,
        avatarHash:    payload.avatarHash    as string | null | undefined,
        bio:           payload.bio           as string | null | undefined,
        bannerColor:   payload.bannerColor   as string | null | undefined,
        bannerHash:    payload.bannerHash    as string | null | undefined,
      })
    }

    // Fetch images we don't have locally
    const hashesToFetch = [payload.avatarHash, payload.bannerHash].filter(Boolean) as string[]
    for (const hash of hashesToFetch) {
      const has = await invoke<boolean>('has_attachment', { contentHash: hash }).catch(() => false)
      if (!has) {
        broadcast({ type: 'attachment_want', contentHash: hash, messageId: '' })
      }
    }
  }

  async function handleProfileRequest(fromUserId: string) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    webrtcService.sendToPeer(fromUserId, {
      type:    'profile_update',
      payload: {
        displayName:   identityStore.displayName,
        avatarHash:    identityStore.avatarHash,
        bio:           identityStore.bio,
        bannerColor:   identityStore.bannerColor,
        bannerHash:    identityStore.bannerHash,
      },
    })
  }

  /** Send a presence_update to all connected peers. */
  async function broadcastPresence(status: string) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    if (!identityStore.userId) return
    const isRelayCapable = natType.value === 'open' || natType.value === 'restricted'
    broadcast({
      type:         'presence_update',
      userId:       identityStore.userId,
      status,
      timestamp:    Date.now(),
      relayCapable: isRelayCapable,
      relayAddr:    isRelayCapable && ownPublicAddr.value
        ? `${ownPublicAddr.value.ip}:3479`
        : undefined,
    })
  }

  /** Send a profile_update to all connected peers. */
  async function broadcastProfile(payload: {
    displayName?:   string
    avatarHash?:    string | null
    bio?:           string | null
    bannerColor?:   string | null
    bannerHash?:    string | null
  }) {
    broadcast({ type: 'profile_update', payload })
  }

  /** Request a profile_update from a specific peer. */
  async function requestProfile(peerId: string) {
    webrtcService.sendToPeer(peerId, { type: 'profile_request' })
  }

  /** Send own presence+profile to a single newly connected peer. */
  async function gossipOwnPresence(peerId: string) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    if (!identityStore.userId) return
    const statusKey = `hexfield_own_status_${identityStore.userId}`
    const status = (localStorage.getItem(statusKey) as string | null) ?? 'online'
    const isRelayCapable = natType.value === 'open' || natType.value === 'restricted'
    webrtcService.sendToPeer(peerId, {
      type:         'presence_update',
      userId:       identityStore.userId,
      status,
      timestamp:    Date.now(),
      relayCapable: isRelayCapable,
      relayAddr:    isRelayCapable && ownPublicAddr.value
        ? `${ownPublicAddr.value.ip}:3479`
        : undefined,
    })
  }

  async function handleServerAvatarUpdate(msg: Record<string, unknown>) {
    const serverId   = msg.serverId   as string | undefined
    const avatarHash = msg.avatarHash as string | undefined
    if (!serverId || !avatarHash) return
    const { useServersStore } = await import('./serversStore')
    const serversStore = useServersStore()
    if (serversStore.joinedServerIds.includes(serverId)) {
      await serversStore.updateServerAvatarHash(serverId, avatarHash)

      // Fetch the image if we don't have it locally
      const has = await invoke<boolean>('has_attachment', { contentHash: avatarHash }).catch(() => false)
      if (!has) {
        broadcast({ type: 'attachment_want', contentHash: avatarHash, messageId: '' })
      }
    }
  }

  /** Broadcast a server avatar change to all peers. */
  async function broadcastServerAvatar(serverId: string, avatarHash: string | null) {
    broadcast({ type: 'server_avatar_update', serverId, avatarHash })
  }

  // ── Attachment gossip (Phase 5b) ───────────────────────────────────────────

  /**
   * Broadcast to all connected peers that we want to download `contentHash`.
   * Any peer who has the file will reply with `attachment_have`.
   */
  function broadcastAttachmentWant(contentHash: string, messageId: string) {
    broadcast({ type: 'attachment_want', contentHash, messageId })
  }

  /**
   * A peer is asking whether we have `contentHash`.
   * Called for broadcast — send back `attachment_have` if we hold it.
   */
  async function handleAttachmentWant(fromUserId: string, msg: Record<string, unknown>) {
    const contentHash = msg.contentHash as string
    if (!contentHash) return
    const hashHex = contentHash.replace('blake3:', '')
    const have = await invoke<boolean>('has_attachment', { contentHash: hashHex })
    if (have) {
      webrtcService.sendToPeer(fromUserId, {
        type: 'attachment_have',
        contentHash,
      })
    }
  }

  /**
   * A peer says they have `contentHash` — register them as a seeder and
   * request missing chunks.
   */
  function handleAttachmentHave(fromUserId: string, msg: Record<string, unknown>) {
    const contentHash = msg.contentHash as string
    if (!contentHash) return
    const hashHex = contentHash.replace('blake3:', '')
    attachmentService.addSeeder(hashHex, fromUserId)
  }

  /**
   * A peer requests specific chunks of an attachment we hold.
   */
  async function handleAttachmentChunkRequest(fromUserId: string, msg: Record<string, unknown>) {
    const contentHash = msg.contentHash as string
    const indices = msg.chunkIndices as number[]
    if (!contentHash || !Array.isArray(indices)) return
    const hashHex = contentHash.replace('blake3:', '')
    for (const idx of indices) {
      const data = await attachmentService.readChunkForSeeding(hashHex, idx)
      if (data) {
        webrtcService.sendToPeer(fromUserId, {
          type:         'attachment_chunk',
          contentHash,
          chunkIndex:   idx,
          data,
        })
      }
    }
  }

  /**
   * An inbound chunk for an ongoing download.
   */
  async function handleAttachmentChunk(msg: Record<string, unknown>) {
    const contentHash = msg.contentHash as string
    const chunkIndex  = msg.chunkIndex  as number
    const data        = msg.data        as number[]
    const totalChunks = msg.totalChunks as number | undefined
    if (!contentHash || typeof chunkIndex !== 'number' || !Array.isArray(data)) return
    const hashHex = contentHash.replace('blake3:', '')
    // totalChunks may not be in the message (older clients) — fall back to 0 and let Rust work it out
    await attachmentService.receiveChunk(hashHex, chunkIndex, data, totalChunks ?? 0)
  }

  async function handleDeviceLinkRequest(_fromUserId: string, msg: Record<string, unknown>) {
    const { useDevicesStore } = await import('./devicesStore')
    const devicesStore = useDevicesStore()
    const linkToken    = msg.linkToken as string
    if (!devicesStore.isLinkTokenValid(linkToken)) {
      logger.warn('network', 'device_link_request: invalid or expired link token')
      return
    }
    devicesStore.pendingLinkRequest = {
      deviceId:      msg.deviceId      as string,
      publicSignKey: msg.publicSignKey as string,
      publicDHKey:   msg.publicDHKey   as string,
      displayName:   (msg.displayName  as string | undefined) ?? 'New Device',
    }
  }

  async function handleDeviceLinkConfirm(msg: Record<string, unknown>) {
    const device = msg.device as import('@/types/core').Device | undefined
    if (!device) return
    const { useDevicesStore } = await import('./devicesStore')
    await useDevicesStore().receiveAttestedDevice(device)
  }

  async function handleDeviceAttest(msg: Record<string, unknown>) {
    const device = msg.device as import('@/types/core').Device | undefined
    if (!device) return
    const { useDevicesStore } = await import('./devicesStore')
    await useDevicesStore().receiveAttestedDevice(device)
  }

  async function handleVoiceJoin(userId: string, msg: Record<string, unknown>) {
    const { useVoiceStore }   = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    const channelId  = msg.channelId as string | undefined
    if (!channelId) return
    // Always track where this peer is in voice (so sidebar shows it even for non-participants)
    voiceStore.setPeerVoiceChannel(userId, channelId)
    // Notify: someone joined a voice channel (only if we are in the same channel)
    if (voiceStore.session?.channelId === channelId) {
      const serverId = voiceStore.session?.serverId
      const peerName = (await import('./serversStore')).useServersStore()
        .members[serverId ?? '']?.[userId]?.displayName ?? userId.slice(0, 8)
      ;(await import('./notificationStore')).useNotificationStore().notify({
        type:      'join_other',
        serverId,
        channelId,
        authorId:  userId,
        titleText: `${peerName} joined voice`,
      }).catch(() => {})
    }
    if (voiceStore.session?.channelId === channelId) {
      voiceStore.updatePeer(userId, { audioEnabled: true })
      // Reply only if this is an initial announce (not a reply), to avoid a ping-pong loop.
      if (!msg.isReply) {
        sendToPeer(userId, { type: 'voice_join', channelId, isReply: true })
      }
    }
  }

  async function handleVoiceLeave(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    const serverId = voiceStore.session?.serverId
    const channelId = voiceStore.session?.channelId
    voiceStore.removePeer(userId)
    voiceStore.clearPeerVoiceChannel(userId)
    // Notify: peer left voice (only meaningful if we were in the same session)
    if (serverId) {
      const peerName = (await import('./serversStore')).useServersStore()
        .members[serverId]?.[userId]?.displayName ?? userId.slice(0, 8)
      ;(await import('./notificationStore')).useNotificationStore().notify({
        type:      'leave',
        serverId,
        channelId,
        authorId:  userId,
        titleText: `${peerName} left voice`,
      }).catch(() => {})
    }
  }

  async function handleVoiceScreenShareStart(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    useVoiceStore().updatePeer(userId, { screenSharing: true })
  }

  async function handleVoiceScreenShareStop(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    delete voiceStore.screenFrameUrls[userId]
    voiceStore.updatePeer(userId, { screenSharing: false })
  }

  async function handleVoicePeerDisconnect(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    useVoiceStore().removePeer(userId)
  }

  function handleTypingStopEvent(userId: string) {
    if (typingUsers.value[userId]) {
      clearTimeout(typingUsers.value[userId].timeout)
      delete typingUsers.value[userId]
      typingUsers.value = { ...typingUsers.value }
    }
  }

  /**
   * Returns a promise that resolves once signalingState === 'connected',
   * or rejects if the timeout elapses first.
   */
  function waitForConnected(timeoutMs = 12000): Promise<void> {
    if (signalingState.value === 'connected') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (signalingState.value === 'connected') return resolve()
        if (Date.now() - start >= timeoutMs) return reject(new Error('Signaling connection timed out'))
        setTimeout(check, 150)
      }
      check()
    })
  }

  /**
   * Resolves when a specific peer appears in `connectedPeers` (WebRTC connected).
   */
  function waitForPeer(userId: string, timeoutMs = 15000): Promise<void> {
    if (connectedPeers.value.includes(userId)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const check = () => {
        if (connectedPeers.value.includes(userId)) return resolve()
        if (Date.now() - start >= timeoutMs) return reject(new Error('Peer connection timed out'))
        setTimeout(check, 200)
      }
      check()
    })
  }

  /**
   * Connect to a peer's LAN signal server, then initiate WebRTC.
   * Called from JoinModal (Priority 2) and mDNS auto-discover (Priority 1).
   */
  async function connectViaDirect(userId: string, addr: string, port: number): Promise<void> {
    await invoke('lan_connect_peer', { userId, addr, port })
  }

  /**
   * Send a `server_join_request` to a peer and wait for them to respond with
   * the full `ServerManifest`. Resolves with the manifest or rejects on timeout.
   */
  async function requestServerManifest(
    peerId: string,
    serverId: string,
    inviteToken: string,
    timeoutMs = 20000,
  ): Promise<ServerManifest> {
    logger.info('network', 'requesting manifest from', peerId, 'server:', serverId)
    // Include our identity so the owner can upsert us as a member immediately.
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _pendingServerJoin = null
        reject(new Error('Server manifest request timed out'))
      }, timeoutMs)

      _pendingServerJoin = {
        resolve: (manifest) => { clearTimeout(timer); resolve(manifest) },
        reject:  (err)      => { clearTimeout(timer); reject(err)      },
      }

      const payload = {
        type:          'server_join_request',
        inviteToken,
        serverId,
        displayName:   identityStore.displayName,
        publicSignKey: identityStore.publicSignKey ?? '',
        publicDHKey:   identityStore.publicDHKey   ?? '',
      }

      // sendToPeer returns false if the data channel is not yet open in Rust (e.g. a
      // second WebRTC offer replaced the first before its DC opened, leaving the new
      // PC's DC slot temporarily null). Retry every 500 ms so the request isn't
      // silently dropped during the brief window when the DC handshake is finishing.
      const trySend = () => {
        if (!_pendingServerJoin) return   // already resolved or rejected
        if (!sendToPeer(peerId, payload)) {
          logger.debug('network', 'manifest DC not ready — retry for', peerId)
          setTimeout(trySend, 500)
        }
      }
      trySend()
    })
  }

  /** Received by the server owner — validate token, send back full manifest (or queue if closed). */
  async function handleServerJoinRequest(
    fromUserId: string,
    msg: Record<string, unknown>,
  ) {
    const { useServersStore }  = await import('./serversStore')
    const { useChannelsStore } = await import('./channelsStore')
    const { useIdentityStore } = await import('./identityStore')
    const { v7: uuidv7 } = await import('uuid')

    const serversStore  = useServersStore()
    const channelsStore = useChannelsStore()
    const identityStore = useIdentityStore()

    const token    = msg.inviteToken as string
    const serverId = msg.serverId   as string

    const tokenStatus = await serversStore.validateInviteToken(token, serverId)
    if (tokenStatus !== 'ok') {
      logger.warn('network', 'join denied:', tokenStatus, 'from:', fromUserId)
      const reasonMap: Record<string, string> = {
        not_found:        'Invalid or expired invite token',
        invite_expired:   'This invite link has expired',
        invite_exhausted: 'This invite link has reached its maximum uses',
      }
      sendToPeer(fromUserId, { type: 'server_join_denied', reason: tokenStatus, error: reasonMap[tokenStatus] ?? 'Invalid token' })
      return
    }

    const server = serversStore.servers[serverId]
    if (!server) {
      sendToPeer(fromUserId, { type: 'server_join_denied', reason: 'not_found', error: 'Server not found' })
      return
    }

    const joinerDisplayName   = (msg.displayName   as string | undefined) ?? 'Player'
    const joinerPublicSignKey = (msg.publicSignKey as string | undefined) ?? ''
    const joinerPublicDHKey   = (msg.publicDHKey   as string | undefined) ?? ''

    // If the server is in closed mode — queue the request and notify the joiner
    if (server.accessMode === 'closed') {
      const req = {
        id:            uuidv7(),
        serverId,
        userId:        fromUserId,
        displayName:   joinerDisplayName,
        publicSignKey: joinerPublicSignKey,
        publicDHKey:   joinerPublicDHKey,
        requestedAt:   new Date().toISOString(),
        status:        'pending' as const,
      }
      await serversStore.queueJoinRequest(req)
      sendToPeer(fromUserId, { type: 'server_join_denied', reason: 'server_closed' })
      // Notify local admins
      const { useUIStore } = await import('./uiStore')
      useUIStore().showNotification(`${joinerDisplayName} requested to join ${server.name}`, 'info')
      return
    }

    // Open mode — upsert the joiner and send manifest immediately
    if (joinerPublicSignKey && joinerPublicDHKey) {
      await serversStore.upsertMember({
        userId:        fromUserId,
        serverId,
        displayName:   joinerDisplayName,
        publicSignKey: joinerPublicSignKey,
        publicDHKey:   joinerPublicDHKey,
        roles:         ['member'],
        joinedAt:      new Date().toISOString(),
        onlineStatus:  'online',
      })
    }

    const manifest: ServerManifest = {
      v:        1,
      server,
      channels: channelsStore.channels[serverId] ?? [],
      owner: {
        userId:        identityStore.userId        ?? '',
        displayName:   identityStore.displayName,
        publicSignKey: identityStore.publicSignKey ?? '',
        publicDHKey:   identityStore.publicDHKey   ?? '',
      },
    }

    sendToPeer(fromUserId, { type: 'server_manifest', manifest })
    logger.info('network', 'manifest sent to:', fromUserId, 'server:', serverId)
  }

  /** Received by the joiner — resolve the pending join promise. */
  function handleServerManifestReceived(msg: Record<string, unknown>) {
    const manifest = msg.manifest as ServerManifest | undefined
    if (!manifest || !manifest.server?.id) {
      _pendingServerJoin?.reject(new Error('Received invalid server manifest'))
      _pendingServerJoin = null
      return
    }
    _pendingServerJoin?.resolve(manifest)
    _pendingServerJoin = null
    logger.info('network', 'manifest received for server:', manifest.server?.id)
  }

  /** Received by the joiner when the admin denies (or defers) the join request. */
  async function handleServerJoinDenied(msg: Record<string, unknown>) {
    const reason = msg.reason as string | undefined
    const { useUIStore } = await import('./uiStore')
    const uiStore = useUIStore()

    if (reason === 'server_closed') {
      _pendingServerJoin?.reject(new Error('server_closed'))
      uiStore.showNotification('This server requires admin approval. Your request has been queued.', 'info')
    } else if (reason === 'invite_expired') {
      _pendingServerJoin?.reject(new Error('invite_expired'))
      uiStore.showNotification('This invite link has expired. Ask for a new one.', 'warning')
    } else if (reason === 'invite_exhausted') {
      _pendingServerJoin?.reject(new Error('invite_exhausted'))
      uiStore.showNotification('This invite link has reached its maximum uses.', 'warning')
    } else if (reason === 'request_denied') {
      uiStore.showNotification('Your join request was denied by an admin.', 'warning')
    } else {
      _pendingServerJoin?.reject(new Error(msg.error as string ?? 'Join request denied'))
      uiStore.showNotification('Join request was denied.', 'warning')
    }
    _pendingServerJoin = null
  }

  /** Auto-connect when mDNS discovers a peer on the same network. */
  async function handleLanPeerDiscovered(
    userId: string,
    addr: string,
    port: number,
    localUserId: string,
  ) {
    if (connectedPeers.value.includes(userId)) return
    logger.info('network', 'mDNS peer discovered:', userId, `${addr}:${port}`)

    try {
      await invoke('lan_connect_peer', { userId, addr, port })
      // Perfect negotiation: lower userId is "impolite" and initiates.
      // Higher userId is "polite" and waits for an offer.
      if (localUserId < userId) {
        await connectToPeer(userId)
      }
    } catch (e) {
      logger.warn('network', 'LAN auto-connect failed:', e)
    }
  }

  /**
   * Trigger a fresh sync round with a peer that is already connected.
   * Useful after importing a server manifest so that messages received
   * (and dropped due to missing FK) during the initial connection can be
   * recovered by re-initiating negentropy against the now-populated DB.
   */
  function resyncPeer(peerId: string) {
    if (!connectedPeers.value.includes(peerId)) return
    startSync(peerId).catch(e => logger.warn('network', 'resync error:', e))
  }

  function getRendezvousToken() { return _rendezvousToken }
  function getTurnCredentials() { return _turnCredentials }

  return {
    signalingState,
    serverUrl,
    reconnectAttempt,
    natType,
    ownPublicAddr,
    relayCapablePeers,
    connectedPeers,
    typingUsers,
    init,
    connect,
    disconnect,
    waitForConnected,
    waitForPeer,
    connectViaDirect,
    requestServerManifest,
    sendSignal,
    sendToPeer,
    broadcast,
    connectToPeer,
    sendTypingStart,
    sendTypingStop,
    getTypingUsers,
    broadcastPresence,
    broadcastProfile,
    requestProfile,
    broadcastServerAvatar,
    broadcastAttachmentWant,
    resyncPeer,
    getRendezvousToken,
    getTurnCredentials,
  }
})
