import { defineStore } from 'pinia'
import { ref } from 'vue'
import { signalingService } from '@/services/signalingService'
import type { SignalPayload } from '@/services/signalingService'
import { webrtcService } from '@/services/webrtcService'
import { startSync, handleSyncMessage, setSendFn } from '@/services/syncService'
import type { SyncWireMessage } from '@/services/syncService'

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error'

export const useNetworkStore = defineStore('network', () => {
  const signalingState   = ref<SignalingState>('disconnected')
  const serverUrl        = ref<string>('')
  const reconnectAttempt = ref<number>(0)
  const natType          = ref<'open' | 'restricted' | 'symmetric' | 'unknown'>('unknown')
  const connectedPeers   = ref<string[]>([])
  // userId -> { channelId, timestamp }
  const typingUsers      = ref<Record<string, { channelId: string; timeout: ReturnType<typeof setTimeout> }>>({})

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
        // Start history reconciliation with newly connected peer
        startSync(userId).catch(e => console.warn('[network] sync start error:', e))
      },
      (userId) => {
        connectedPeers.value = connectedPeers.value.filter(id => id !== userId)
      },
    )
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
      case 'sync_neg_init':
      case 'sync_neg_reply':
      case 'sync_push':
      case 'sync_want':
        handleSyncMessage(userId, msg as unknown as SyncWireMessage).catch(e =>
          console.warn('[network] sync message error:', e)
        )
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

  function handleTypingStopEvent(userId: string) {
    if (typingUsers.value[userId]) {
      clearTimeout(typingUsers.value[userId].timeout)
      delete typingUsers.value[userId]
      typingUsers.value = { ...typingUsers.value }
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
    sendSignal,
    sendToPeer,
    broadcast,
    connectToPeer,
    sendTypingStart,
    sendTypingStop,
    getTypingUsers,
  }
})
