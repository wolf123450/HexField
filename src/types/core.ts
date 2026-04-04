// ── Identity ──────────────────────────────────────────────────────────────────
export interface Identity {
  userId:          string        // UUID v7, generated locally on first launch
  displayName:     string
  avatarUrl?:      string        // data: URI or remote URL
  publicSignKey:   string        // Ed25519 public key, base64
  publicDHKey:     string        // X25519 public key, base64
  // Private keys are NEVER stored in this type — see cryptoService
}

// ── Server (community / guild) ─────────────────────────────────────────────────
export interface Server {
  id:              string
  name:            string
  description?:    string
  iconUrl?:        string
  avatarDataUrl?:  string | null
  ownerId:         string
  memberCount:     number
  createdAt:       string        // ISO 8601
  inviteCode?:     string
  customEmoji:     CustomEmoji[]
  historyStartsAt?: string       // set when server is re-baselined (Phase 6)
}

export interface ServerMember {
  userId:          string
  serverId:        string
  displayName:     string
  roles:           string[]
  joinedAt:        string
  publicSignKey:   string
  publicDHKey:     string
  onlineStatus:    OnlineStatus
  avatarDataUrl?:  string | null
  bio?:            string | null
  bannerColor?:    string | null
  bannerDataUrl?:  string | null
}

export type OnlineStatus = 'online' | 'idle' | 'dnd' | 'offline'

// ── Channels ───────────────────────────────────────────────────────────────────
export type ChannelType = 'text' | 'voice' | 'announcement'

export interface Channel {
  id:              string
  serverId:        string
  name:            string
  type:            ChannelType
  position:        number
  topic?:          string
  lastMessageId?:  string
  lastMessageAt?:  string
}

// ── Messages ───────────────────────────────────────────────────────────────────
export interface Message {
  id:              string
  channelId:       string
  serverId:        string
  authorId:        string
  content:         string | null
  contentType:     'text' | 'markdown' | 'system'
  attachments:     Attachment[]
  reactions:       ReactionSummary[]
  isEdited:        boolean
  replyToId?:      string
  logicalTs:       string
  createdAt:       string
  verified:        boolean
}

export type MutationType =
  | 'edit' | 'delete' | 'reaction_add' | 'reaction_remove'
  | 'server_update'
  | 'role_assign' | 'role_revoke'
  | 'channel_create' | 'channel_update' | 'channel_delete'
  | 'device_attest' | 'device_revoke'
  | 'member_kick' | 'member_ban' | 'member_unban'
  | 'voice_kick' | 'voice_mute' | 'voice_unmute'

export interface Mutation {
  id:              string
  type:            MutationType
  targetId:        string
  channelId:       string
  authorId:        string
  newContent?:     string
  emojiId?:        string
  logicalTs:       string
  createdAt:       string
  verified:        boolean
}

export interface Attachment {
  id:              string
  name:            string
  size:            number
  mimeType:        string
  url?:            string
  inlineData?:     string        // base64 for Phase 1 ≤100KB inline
  contentHash?:    string        // blake3: for Phase 5b P2P
  chunkSize?:      number        // CHUNK_SIZE used for this file (default 256 KB)
  transferState:   'pending' | 'transferring' | 'complete' | 'failed' | 'inline'
}

// ── Reactions ──────────────────────────────────────────────────────────────────
export interface ReactionSummary {
  emojiId:         string
  count:           number
  selfReacted:     boolean
}

export interface CustomEmoji {
  id:              string
  serverId:        string
  name:            string
  uploadedBy:      string
  createdAt:       string
}

// ── Server join manifest ───────────────────────────────────────────────────────
// Self-contained bundle sent over the WebRTC data channel after a joiner
// presents a valid invite token.  NOT embedded in QR codes (too large).
export interface ServerManifest {
  v:        1
  server:   Server
  channels: Channel[]
  owner: {
    userId:        string
    displayName:   string
    publicSignKey: string
    publicDHKey:   string
  }
}

// ── Peer invite (QR code / invite link) ───────────────────────────────────
// Small self-describing token that fits in a QR code.  Carries just enough
// information to establish a direct P2P connection; full server data is
// transferred over the WebRTC data channel after connection.
//
// Encoded as URL-safe base64 JSON in the gamechat://join/<b64> link.
export interface PeerEndpoint {
  type: 'lan' | 'direct'
  addr: string
  port: number
}

export interface PeerInvite {
  v:            2
  userId:       string          // inviter's userId
  displayName:  string
  publicSignKey: string
  publicDHKey:   string
  endpoints:    PeerEndpoint[]  // LAN endpoints first, then public IPs
  serverId:     string
  serverName:   string          // display-only, for join confirmation UI
  inviteToken:  string          // random nonce validated on the owner side
}

// ── Encryption envelope ────────────────────────────────────────────────────────
export interface EncryptedEnvelope {
  version:         1
  senderId:        string
  recipientId:     string
  ciphertext:      string        // base64 XSalsa20-Poly1305
  nonce:           string        // base64 24-byte nonce
  senderSignature: string        // base64 Ed25519 over (ciphertext + nonce)
}

// ── Peer / WebRTC ──────────────────────────────────────────────────────────────
export interface Peer {
  userId:          string
  connectionState: RTCPeerConnectionState
  audioEnabled:    boolean
  videoEnabled:    boolean
  screenSharing:   boolean
  speaking:        boolean
  adminMuted?:     boolean
}

export interface VoiceSession {
  channelId:       string
  serverId:        string
  joinedAt:        string
  peers:           Record<string, Peer>
}

export interface InviteLink {
  code:            string
  serverId:        string
  createdBy:       string
  expiresAt?:      string
  maxUses?:        number
  uses:            number
}

// ── SQLite row types (Tauri IPC wire format) ───────────────────────────────────
// These match the Rust serde-serialized structs in src-tauri/src/db/types.rs.
// Used by sync commands that exchange raw rows between peers.

export interface MessageRow {
  id:              string
  channel_id:      string
  server_id:       string
  author_id:       string
  content:         string | null
  content_type:    string
  reply_to_id:     string | null
  created_at:      string
  logical_ts:      string
  verified:        boolean
  raw_attachments: string | null
}

export interface MutationRow {
  id:           string
  type:         string       // serde rename from mutation_type
  target_id:    string
  channel_id:   string
  author_id:    string
  new_content:  string | null
  emoji_id:     string | null
  logical_ts:   string
  created_at:   string
  verified:     boolean
}

// ── Device ─────────────────────────────────────────────────────────────────────
export interface Device {
  deviceId:        string
  userId:          string
  publicSignKey:   string
  publicDHKey:     string
  attestedBy?:     string
  attestationSig?: string
  revoked:         boolean
  createdAt:       string
}

// ── Notifications & Sounds ─────────────────────────────────────────────────

export type NotificationLevel = 'all' | 'mentions' | 'muted'

export interface ServerNotificationPrefs {
  level: NotificationLevel   // default treated as 'mentions' when absent
  muteUntil?: number         // epoch ms; absent or past = not muted
}

export interface ChannelNotificationPrefs {
  level: NotificationLevel | 'inherit'  // 'inherit' = defer to server setting
  muteUntil?: number
}

export interface KeywordFilter {
  id: string                 // UUID v7
  keyword: string            // case-insensitive substring match
  serverId?: string          // undefined = applies globally
}

export type SoundEvent = 'message' | 'mention' | 'join_self' | 'join_other' | 'leave'
