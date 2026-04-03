import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { signalingService } from '@/services/signalingService'
import type { SignalPayload } from '@/services/signalingService'
import { webrtcService } from '@/services/webrtcService'
import { startSync, handleSyncMessage, setSendFn } from '@/services/syncService'
import type { SyncWireMessage } from '@/services/syncService'
import type { ServerManifest } from '@/types/core'

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error'

export const useNetworkStore = defineStore('network', () => {
  const signalingState   = ref<SignalingState>('disconnected')
  const serverUrl        = ref<string>('')
  const reconnectAttempt = ref<number>(0)
  const natType          = ref<'open' | 'restricted' | 'symmetric' | 'unknown'>('unknown')
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

    // Initialize webrtcService
    webrtcService.init(
      localUserId,
      handleDataChannelMessage,
      (userId) => {
        if (!connectedPeers.value.includes(userId)) {
          connectedPeers.value = [...connectedPeers.value, userId]
        }
        // Gossip identity first — member keys must be queued on the data channel
        // before startSync sends sync_neg_init, so the remote decrypts our messages
        // in the right order (SCTP preserves send order).
        gossipOwnDevice(userId)
        gossipOwnMembership(userId)
        // Start history reconciliation with newly connected peer
        startSync(userId).catch(e => console.warn('[network] sync start error:', e))
      },
      (userId) => {
        connectedPeers.value = connectedPeers.value.filter(id => id !== userId)
        // Clean up voice state if the peer disconnects
        handleVoicePeerDisconnect(userId)
      },
      handleRemoteTrack,
    )

    // Listen for mDNS-discovered peers (auto-connect on same LAN).
    await listen<{ userId: string; addr: string; port: number }>(
      'lan_peer_discovered',
      ({ payload }) => handleLanPeerDiscovered(payload.userId, payload.addr, payload.port, localUserId),
    )

    // lan_peer_lost is handled implicitly — WebRTC disconnection fires
    // the onPeerDisconnected callback above; no extra action needed.
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
    reconnectAttempt.value = 0
    webrtcService.destroyAll()
    connectedPeers.value = []
    await signalingService.disconnect()
  }

  /**
   * Send a signaling payload (routes through WS to rendezvous server).
   */
  async function sendSignal(payload: SignalPayload) {
    await signalingService.send(payload)
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

    switch (payload.type) {
      case 'signal_offer':
        webrtcService.handleOffer(from, payload.sdp as string)
        break
      case 'signal_answer':
        webrtcService.handleAnswer(from, payload.sdp as string)
        break
      case 'signal_ice':
        webrtcService.handleIceCandidate(from, payload.candidate as RTCIceCandidateInit)
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

    switch (msg.type) {
      case 'chat_message':
        handleChatMessage(userId, msg)
        break
      case 'typing_start':
        handleTypingStart(userId, msg.channelId as string)
        break
      case 'typing_stop':
        handleTypingStopEvent(userId)
        break
      case 'mutation':
        handleMutationMessage(msg)
        break
      case 'emoji_sync':
        handleEmojiSync(msg)
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
      case 'member_announce':
        handleMemberAnnounce(userId, msg).catch(e =>
          console.warn('[network] member_announce error:', e)
        )
        break
      case 'voice_join':
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
          console.warn('[network] sync message error:', e)
        )
        break
      case 'server_join_request':
        handleServerJoinRequest(userId, msg).catch(e =>
          console.warn('[network] server_join_request error:', e)
        )
        break
      case 'server_manifest':
        handleServerManifestReceived(msg)
        break
      default:
        console.debug('[network] unhandled data message type:', msg.type)
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
    await messagesStore.applyMutation({
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
    })
  }

  async function handleEmojiSync(msg: Record<string, unknown>) {
    const { useEmojiStore } = await import('./emojiStore')
    const emojiStore = useEmojiStore()
    const emoji = msg.emoji as { id: string; name: string; uploadedBy: string; createdAt: string }
    const serverId = msg.serverId as string
    if (!emoji || !serverId) return
    emojiStore.receiveEmojiSync({ id: emoji.id, serverId, name: emoji.name, uploadedBy: emoji.uploadedBy, createdAt: emoji.createdAt })
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

  /**
   * Gossip our own membership records to a newly connected peer.
   * This lets them populate their members map so they can decrypt our messages
   * and display our name/avatar correctly.
   */
  async function gossipOwnMembership(peerId: string) {
    const { useServersStore } = await import('./serversStore')
    const { useIdentityStore } = await import('./identityStore')
    const serversStore  = useServersStore()
    const identityStore = useIdentityStore()
    if (!identityStore.userId) return

    const uid = identityStore.userId
    const ownMemberships = Object.values(serversStore.members)
      .flatMap(serverMembers => Object.values(serverMembers))
      .filter(m => m.userId === uid)
      // Include avatar so the remote can render our image.
      .map(m => ({ ...m, avatarDataUrl: identityStore.avatarDataUrl ?? undefined }))

    if (ownMemberships.length === 0) return
    webrtcService.sendToPeer(peerId, { type: 'member_announce', members: ownMemberships })
  }

  async function handleMemberAnnounce(fromUserId: string, msg: Record<string, unknown>) {
    const memberList = msg.members as Array<{
      userId: string; serverId: string; displayName: string
      publicSignKey: string; publicDHKey: string
      roles: string[]; joinedAt: string; onlineStatus: string
      avatarDataUrl?: string
    }>
    if (!Array.isArray(memberList)) return
    const { useServersStore } = await import('./serversStore')
    const serversStore = useServersStore()
    for (const m of memberList) {
      if (m.userId !== fromUserId) continue // Only accept sender's own memberships
      await serversStore.upsertMember(m)
    }
  }

  async function handleDeviceLinkRequest(_fromUserId: string, msg: Record<string, unknown>) {
    const { useDevicesStore } = await import('./devicesStore')
    const devicesStore = useDevicesStore()
    const linkToken    = msg.linkToken as string
    if (!devicesStore.isLinkTokenValid(linkToken)) {
      console.warn('[network] device_link_request: invalid or expired link token')
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

  async function handleRemoteTrack(userId: string, stream: MediaStream, track: MediaStreamTrack) {
    const { useVoiceStore } = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    if (!voiceStore.session) return
    if (track.kind === 'audio') {
      const { audioService } = await import('@/services/audioService')
      audioService.attachRemoteStream(userId, stream)
      voiceStore.updatePeer(userId, { audioEnabled: true })
    } else if (track.kind === 'video') {
      voiceStore.screenStreams[userId] = stream
      voiceStore.updatePeer(userId, { screenSharing: true })
      track.onended = () => {
        delete voiceStore.screenStreams[userId]
        voiceStore.updatePeer(userId, { screenSharing: false })
      }
    }
  }

  async function handleVoiceJoin(userId: string, msg: Record<string, unknown>) {
    const { useVoiceStore }   = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    const channelId  = msg.channelId as string | undefined
    if (!channelId) return
    // Always track where this peer is in voice (so sidebar shows it even for non-participants)
    voiceStore.setPeerVoiceChannel(userId, channelId)
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
    voiceStore.removePeer(userId)
    voiceStore.clearPeerVoiceChannel(userId)
  }

  async function handleVoiceScreenShareStart(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    useVoiceStore().updatePeer(userId, { screenSharing: true })
  }

  async function handleVoiceScreenShareStop(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    useVoiceStore().updatePeer(userId, { screenSharing: false })
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

      sendToPeer(peerId, {
        type:          'server_join_request',
        inviteToken,
        serverId,
        displayName:   identityStore.displayName,
        publicSignKey: identityStore.publicSignKey ?? '',
        publicDHKey:   identityStore.publicDHKey   ?? '',
      })
    })
  }

  // ── New data-channel handlers ────────────────────────────────────────────

  /** Received by the server owner — validate token, send back full manifest. */
  async function handleServerJoinRequest(
    fromUserId: string,
    msg: Record<string, unknown>,
  ) {
    const { useServersStore }  = await import('./serversStore')
    const { useChannelsStore } = await import('./channelsStore')
    const { useIdentityStore } = await import('./identityStore')

    const serversStore  = useServersStore()
    const channelsStore = useChannelsStore()
    const identityStore = useIdentityStore()

    const token    = msg.inviteToken as string
    const serverId = msg.serverId   as string

    if (!serversStore.validateInviteToken(token, serverId)) {
      sendToPeer(fromUserId, { type: 'server_join_error', error: 'Invalid or expired invite token' })
      return
    }

    // Upsert the joiner as a member so we can encrypt messages to them.
    const joinerDisplayName   = (msg.displayName   as string | undefined) ?? 'Player'
    const joinerPublicSignKey = (msg.publicSignKey as string | undefined) ?? ''
    const joinerPublicDHKey   = (msg.publicDHKey   as string | undefined) ?? ''
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

    const server = serversStore.servers[serverId]
    if (!server) {
      sendToPeer(fromUserId, { type: 'server_join_error', error: 'Server not found' })
      return
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
  }

  /** Auto-connect when mDNS discovers a peer on the same network. */
  async function handleLanPeerDiscovered(
    userId: string,
    addr: string,
    port: number,
    localUserId: string,
  ) {
    if (connectedPeers.value.includes(userId)) return

    try {
      await invoke('lan_connect_peer', { userId, addr, port })
      // Perfect negotiation: lower userId is "impolite" and initiates.
      // Higher userId is "polite" and waits for an offer.
      if (localUserId < userId) {
        await connectToPeer(userId)
      }
    } catch (e) {
      console.warn('[network] LAN auto-connect failed:', e)
    }
  }

  return {
    signalingState,
    serverUrl,
    reconnectAttempt,
    natType,
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
  }
})
