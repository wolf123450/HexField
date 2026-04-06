import { describe, it, expect } from 'vitest'
import {
  isValidChatMessage,
  isValidMemberAnnounce,
  isValidPresenceUpdate,
  isValidMutation,
  isValidTypingStart,
  isValidProfileUpdate,
  isValidVoiceJoin,
  isValidEmojiSync,
} from '@/utils/peerValidator'

describe('peerValidator', () => {
  // ── isValidChatMessage ────────────────────────────────────────────────────

  it('accepts a well-formed chat message', () => {
    expect(isValidChatMessage({
      id: 'msg-1', channelId: 'ch-1', authorId: 'user-1',
      ciphertext: 'abc123', nonce: 'nonce123',
    })).toBe(true)
  })

  it('rejects chat message missing ciphertext', () => {
    expect(isValidChatMessage({ id: 'msg-1', channelId: 'ch-1', authorId: 'u', nonce: 'n' })).toBe(false)
  })

  it('rejects chat message with empty id', () => {
    expect(isValidChatMessage({ id: '', channelId: 'ch', authorId: 'u', ciphertext: 'c', nonce: 'n' })).toBe(false)
  })

  // ── isValidMemberAnnounce ─────────────────────────────────────────────────

  it('accepts a well-formed member announce', () => {
    expect(isValidMemberAnnounce({
      userId: 'u1', serverId: 's1', displayName: 'Alice',
      publicSignKey: 'key1', publicDHKey: 'key2',
    })).toBe(true)
  })

  it('rejects member announce missing publicSignKey', () => {
    expect(isValidMemberAnnounce({
      userId: 'u1', serverId: 's1', displayName: 'Alice', publicDHKey: 'key2',
    })).toBe(false)
  })

  // ── isValidPresenceUpdate ─────────────────────────────────────────────────

  it('accepts valid statuses', () => {
    for (const status of ['online', 'idle', 'dnd', 'offline']) {
      expect(isValidPresenceUpdate({ status })).toBe(true)
    }
  })

  it('rejects unknown status', () => {
    expect(isValidPresenceUpdate({ status: 'away' })).toBe(false)
    expect(isValidPresenceUpdate({ status: '' })).toBe(false)
    expect(isValidPresenceUpdate({})).toBe(false)
  })

  // ── isValidMutation ───────────────────────────────────────────────────────

  it('accepts a well-formed mutation', () => {
    expect(isValidMutation({
      mutation: { id: 'm1', type: 'edit', authorId: 'u1', logicalTs: '1000-000000' },
    })).toBe(true)
  })

  it('rejects mutation with missing required field', () => {
    expect(isValidMutation({
      mutation: { id: 'm1', type: 'edit', logicalTs: '1000-000000' },
    })).toBe(false)
  })

  it('rejects when mutation is not an object', () => {
    expect(isValidMutation({ mutation: 'bad' })).toBe(false)
    expect(isValidMutation({})).toBe(false)
  })

  // ── isValidTypingStart ────────────────────────────────────────────────────

  it('accepts typing_start with channelId', () => {
    expect(isValidTypingStart({ channelId: 'ch-1' })).toBe(true)
  })

  it('rejects typing_start with empty channelId', () => {
    expect(isValidTypingStart({ channelId: '' })).toBe(false)
    expect(isValidTypingStart({})).toBe(false)
  })

  // ── isValidProfileUpdate ──────────────────────────────────────────────────

  it('accepts profile update with displayName', () => {
    expect(isValidProfileUpdate({ displayName: 'Alice' })).toBe(true)
  })

  it('accepts profile update with avatarDataUrl', () => {
    expect(isValidProfileUpdate({ avatarDataUrl: 'data:image/png;base64,abc' })).toBe(true)
  })

  it('rejects profile update with neither', () => {
    expect(isValidProfileUpdate({})).toBe(false)
  })

  // ── isValidVoiceJoin ──────────────────────────────────────────────────────

  it('accepts voice_join with channelId', () => {
    expect(isValidVoiceJoin({ channelId: 'ch-voice' })).toBe(true)
  })

  it('rejects voice_join without channelId', () => {
    expect(isValidVoiceJoin({})).toBe(false)
  })

  // ── isValidEmojiSync ──────────────────────────────────────────────────────

  it('accepts emoji_sync with emojis array', () => {
    expect(isValidEmojiSync({ emojis: [] })).toBe(true)
    expect(isValidEmojiSync({ emojis: [{ id: 'e1' }] })).toBe(true)
  })

  it('rejects emoji_sync without array', () => {
    expect(isValidEmojiSync({ emojis: 'bad' })).toBe(false)
    expect(isValidEmojiSync({})).toBe(false)
  })
})
