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
