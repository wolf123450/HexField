import { describe, it, expect } from 'vitest'
import {
  isValidChatMessage,
  isValidPresenceUpdate,
  isValidMutation,
  isValidTypingStart,
  isValidProfileUpdate,
  isValidVoiceJoin,
} from '@/utils/peerValidator'

describe('peerValidator', () => {
  // ── isValidChatMessage ────────────────────────────────────────────────────

  it('accepts a well-formed chat message', () => {
    expect(isValidChatMessage({
      messageId: 'msg-1', channelId: 'ch-1', serverId: 'srv-1',
      authorId: 'user-1', envelopes: [{ recipientId: 'r1', ciphertext: 'ct', nonce: 'n' }],
    })).toBe(true)
  })

  it('rejects chat message missing envelopes', () => {
    expect(isValidChatMessage({ messageId: 'msg-1', channelId: 'ch-1', serverId: 'srv-1', authorId: 'u' })).toBe(false)
  })

  it('rejects chat message with empty messageId', () => {
    expect(isValidChatMessage({ messageId: '', channelId: 'ch', serverId: 's', authorId: 'u', envelopes: [] })).toBe(false)
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

  it('accepts profile update with payload object', () => {
    expect(isValidProfileUpdate({ payload: { displayName: 'Alice' } })).toBe(true)
  })

  it('accepts profile update with avatar in payload', () => {
    expect(isValidProfileUpdate({ payload: { avatarDataUrl: 'data:image/png;base64,abc' } })).toBe(true)
  })

  it('rejects profile update without payload', () => {
    expect(isValidProfileUpdate({})).toBe(false)
  })

  it('rejects profile update with non-object payload', () => {
    expect(isValidProfileUpdate({ payload: 'bad' })).toBe(false)
    expect(isValidProfileUpdate({ payload: null })).toBe(false)
  })

  // ── isValidVoiceJoin ──────────────────────────────────────────────────────

  it('accepts voice_join with channelId and serverId', () => {
    expect(isValidVoiceJoin({ channelId: 'ch-voice', serverId: 'srv-1' })).toBe(true)
  })

  it('rejects voice_join without channelId', () => {
    expect(isValidVoiceJoin({ serverId: 'srv-1' })).toBe(false)
  })

  it('rejects voice_join without serverId', () => {
    expect(isValidVoiceJoin({ channelId: 'ch-voice' })).toBe(false)
  })
})
