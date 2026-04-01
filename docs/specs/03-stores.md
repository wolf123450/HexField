# Spec 03 — Pinia Store Architecture

> Parent: [Architecture Plan](../architecture-plan.md)

All stores use Pinia Composition API (`defineStore` with `ref`/`computed`) — matching the skeleton pattern.

---

## Store Map

```
src/stores/
  uiStore.ts          ← extend existing (add activeServerId, voicePanelOpen, emojiPicker state)
  settingsStore.ts    ← extend existing (add notifications, soundEnabled, pushToTalkKey,
                         TURN config, showDeletedMessagePlaceholder, storageLimit)
  identityStore.ts    ← NEW
  serversStore.ts     ← NEW
  channelsStore.ts    ← NEW
  messagesStore.ts    ← NEW (windowed cache, SQLite-backed)
  voiceStore.ts       ← NEW (WebRTC peer state, audio tracks, VAD)
  networkStore.ts     ← NEW (signaling WS state, peer connection dispatch)
  emojiStore.ts       ← NEW (custom emoji registry, recent list)
```

---

## identityStore

Owns public identity. **Private keys are held exclusively in `cryptoService` memory — never in the store.**

```typescript
const userId          = ref<string | null>(null)
const displayName     = ref<string>("")
const publicSignKey   = ref<string | null>(null)   // base64 Ed25519 pubkey
const publicDHKey     = ref<string | null>(null)   // base64 X25519 pubkey
const avatarDataUrl   = ref<string | null>(null)
const isRegistered    = ref<boolean>(false)

// Actions:
// initializeIdentity()    — load key from SQLite or generate on first launch
// registerWithServer()    — POST /auth/register with public keys (if rendezvous configured)
// updateDisplayName(name)
// updateAvatar(dataUrl)
```

---

## serversStore

```typescript
const servers         = ref<Record<string, Server>>({})
const members         = ref<Record<string, Record<string, ServerMember>>>({})  // [serverId][userId]
const joinedServerIds = ref<string[]>([])
const activeServerId  = ref<string | null>(null)

// Actions:
// loadServers()
// createServer(name, iconFile?) → generates server manifest + signs it
// joinServer(inviteCode)        → direct P2P or via rendezvous
// leaveServer(serverId)
// fetchMembers(serverId)
// updateMemberStatus(userId, status)
// applyServerMutation(mutation)  → handles 'server_update' / 'role_assign' / etc.
```

---

## channelsStore

```typescript
const channels        = ref<Record<string, Channel[]>>({})  // keyed by serverId
const activeChannelId = ref<string | null>(null)

// Actions:
// loadChannels(serverId)
// createChannel(serverId, name, type)
// deleteChannel(channelId)
// setActiveChannel(channelId)
// applyChannelMutation(mutation)  → 'channel_create' / 'channel_update' / 'channel_delete'
```

---

## messagesStore

Windowed cache — holds most recent 100 messages per active channel in memory. Older messages loaded on scroll-up via cursor pagination.

```typescript
const messages        = ref<Record<string, Message[]>>({})   // channelId → sorted by logicalTs
const cursors         = ref<Record<string, string | null>>({}) // channelId → oldest loaded id
const pendingMessages = ref<Record<string, Message[]>>({})   // optimistic send queue
const unreadCounts    = ref<Record<string, number>>({})      // channelId → count

// sendMessage flow:
//   1. Generate Message (local UUID v7 + createdAt)
//   2. Push to pendingMessages (optimistic display)
//   3. cryptoService.encryptMessage() per member → N EncryptedEnvelopes
//   4. signalingService.send({ type: "chat_message", channelId, envelopes })
//   5. On WS ack: move from pending → messages, invoke db_save_message

// Derived state from mutations (computed reactively):
//   - reactions: filter mutations where type='reaction_add'/'reaction_remove' for each message
//   - isEdited:  any 'edit' mutation exists for a message id
// These update when new mutations arrive via applyMutation()

// Offline queue:
//   - Messages composed offline appended to pendingMessages with local UUID v7
//   - Stay in SQLite locally; Negentropy sync delivers them to peers on reconnect

// Actions:
// loadMessages(channelId, cursor?)
// sendMessage(channelId, content, attachments?)
// editMessage(messageId, newContent)
// deleteMessage(messageId)
// addReaction(messageId, emojiId)
// removeReaction(messageId, emojiId)
// applyMutation(mutation: Mutation)
// markChannelRead(channelId)
```

---

## voiceStore

```typescript
const session         = ref<VoiceSession | null>(null)
const localStream     = ref<MediaStream | null>(null)
const screenStream    = ref<MediaStream | null>(null)
const isMuted         = ref<boolean>(false)
const isDeafened      = ref<boolean>(false)
const peers           = ref<Record<string, Peer>>({})
const speakingPeers   = ref<Set<string>>(new Set())

// Actions:
// joinVoiceChannel(channelId, serverId)
// leaveVoiceChannel()
// toggleMute()
// toggleDeafen()
// startScreenShare()
// stopScreenShare()
// setPeerSpeaking(userId, speaking)
// updatePeerStream(userId, stream)
```

---

## networkStore

```typescript
const signalingState   = ref<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected')
const serverUrl        = ref<string>("")
const reconnectAttempt = ref<number>(0)
const natType          = ref<'open' | 'restricted' | 'symmetric' | 'unknown'>('unknown')

// Actions:
// connect(serverUrl)
// disconnect()
// sendSignal(payload)
// handleIncomingSignal(payload)  ← dispatches to webrtcService or messagesStore
// detectNATType()                ← dual-STUN comparison on startup
```

---

## emojiStore

```typescript
const custom          = ref<Record<string, Record<string, CustomEmoji>>>({})  // [serverId][emojiId]
const imageCache      = ref<Record<string, string>>({})                       // emojiId → data: URI
const recent          = ref<string[]>([])                                     // max 20 recently used

// Actions:
// loadEmoji(serverId)
// uploadEmoji(serverId, name, file)
// deleteEmoji(emojiId)
// getEmojiImage(emojiId, serverId) → loads from disk via Rust if not cached
// receiveEmojiSync(metadata)       ← new emoji metadata from a peer
// useEmoji(emojiId)                ← updates recent list
```

---

## uiStore Extensions

Add to existing `uiStore`:

```typescript
const activeServerId     = ref<string | null>(null)  // or own field in serversStore
const voicePanelOpen     = ref<boolean>(false)
const memberListOpen     = ref<boolean>(true)
const emojiPickerAnchor  = ref<HTMLElement | null>(null)
const emojiPickerTarget  = ref<string | null>(null)   // channelId or messageId
```

---

## settingsStore Extensions

Add to existing `settingsStore`:

```typescript
// Privacy
const showDeletedMessagePlaceholder = ref<boolean>(false)  // default: off
const confirmBeforeDelete           = ref<boolean>(true)
const storageLimitGB                = ref<number>(5)        // default 5, max 10

// Voice
const inputDeviceId                 = ref<string>("")
const outputDeviceId                = ref<string>("")
const pushToTalkKey                 = ref<string | null>(null)
const customTURNServers             = ref<RTCIceServer[]>([])

// Network
const rendezvousServerUrl           = ref<string>("")
const soundEnabled                  = ref<boolean>(true)
const notificationsEnabled          = ref<boolean>(true)
```
