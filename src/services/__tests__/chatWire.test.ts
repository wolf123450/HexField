// @vitest-environment node
/**
 * chat_message wire format: encrypted attachment metadata and compatibility
 * with pre-0.2.14 clients in both directions (spec 08 §4.1).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import _sodium from 'libsodium-wrappers-sumo'
import { CryptoService } from '@/services/cryptoService'
import { buildChatEnvelopes, readChatAttachments } from '@/services/chatWire'
import type { ChatWireMessage, EnvelopeTarget } from '@/services/chatWire'
import { MESSAGE_PREVIEW_BUDGET_CHARS, PREVIEW_TARGET_BYTES, sanitizeAttachments } from '@/services/attachmentService'
import type { Attachment, EncryptedEnvelope } from '@/types/core'

let alice: CryptoService
let bob: CryptoService
let carol: CryptoService
let aliceDH: string
let bobDH: string
let carolDH: string
let aliceSign: string
let bobDHSecret: string

beforeAll(async () => {
  alice = new CryptoService()
  bob   = new CryptoService()
  carol = new CryptoService()
  await Promise.all([alice.init(), bob.init(), carol.init()])
  await alice.generateKeys()
  bobDHSecret = (await bob.generateKeys()).dhSecret
  await carol.generateKeys()
  aliceDH   = alice.getPublicDHKey()
  bobDH     = bob.getPublicDHKey()
  carolDH   = carol.getPublicDHKey()
  aliceSign = alice.getPublicSignKey()
})

const attachments: Attachment[] = [{
  id: 'att-1', name: 'tax-return-2026.pdf', size: 1234, mimeType: 'application/pdf',
  contentHash: 'blake3:deadbeef', chunkSize: 16384, transferState: 'complete',
}]

function wireOf(envelopes: EncryptedEnvelope[], extra: Partial<ChatWireMessage> = {}): ChatWireMessage {
  return {
    type: 'chat_message', messageId: 'm1', channelId: 'c1', serverId: 's1', authorId: 'alice',
    logicalTs: '1-000000', createdAt: '2026-01-01T00:00:00Z', contentType: 'text', envelopes, ...extra,
  }
}

/** JSON round trip, as over the data channel. */
function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function targetsFor(...pairs: Array<[string, string]>): EnvelopeTarget[] {
  return pairs.map(([recipientId, dhKey]) => ({ recipientId, dhKey }))
}

describe('new sender → new receiver', () => {
  it('attachments round-trip through the encrypted blob', () => {
    const built = buildChatEnvelopes(alice, 'hello', 'alice', targetsFor(['bob', bobDH], ['carol', carolDH]), attachments)
    const wire = overTheWire(wireOf(built.envelopes, { attachmentsCipher: built.attachmentsCipher }))

    const bobEnv = wire.envelopes.find(e => e.recipientId === 'bob')!
    expect(bob.decryptMessage(bobEnv, aliceDH, aliceSign)).toBe('hello')
    expect(readChatAttachments(bob, wire, bobEnv, aliceDH)).toEqual(attachments)

    const carolEnv = wire.envelopes.find(e => e.recipientId === 'carol')!
    expect(readChatAttachments(carol, wire, carolEnv, aliceDH)).toEqual(attachments)
  })

  it('the wire carries no attachment metadata in plaintext', () => {
    const built = buildChatEnvelopes(alice, 'hello', 'alice', targetsFor(['bob', bobDH]), attachments)
    const json = JSON.stringify(wireOf(built.envelopes, { attachmentsCipher: built.attachmentsCipher }))
    expect(json).not.toContain('tax-return')
    expect(json).not.toContain('deadbeef')
    expect(json).not.toContain('"attachments"')
  })

  it('a message without attachments has no cipher and no key boxes', () => {
    const built = buildChatEnvelopes(alice, 'hi', 'alice', targetsFor(['bob', bobDH]), [])
    expect(built.attachmentsCipher).toBeUndefined()
    expect(built.envelopes[0].attachmentKey).toBeUndefined()
  })

  it('returns [] when the envelope has no key for the blob', () => {
    const built = buildChatEnvelopes(alice, 'hi', 'alice', targetsFor(['bob', bobDH]), attachments)
    const { attachmentKey: _drop, ...bare } = built.envelopes[0]
    const wire = wireOf([bare], { attachmentsCipher: built.attachmentsCipher })
    expect(readChatAttachments(bob, wire, bare, aliceDH)).toEqual([])
  })

  it('a recipient cannot open another recipient\'s key box', () => {
    const built = buildChatEnvelopes(alice, 'hi', 'alice', targetsFor(['bob', bobDH]), attachments)
    const wire = wireOf(built.envelopes, { attachmentsCipher: built.attachmentsCipher })
    expect(readChatAttachments(carol, wire, built.envelopes[0], aliceDH)).toEqual([])
  })

  it('prefers the encrypted blob and ignores injected plaintext attachments', () => {
    const built = buildChatEnvelopes(alice, 'hi', 'alice', targetsFor(['bob', bobDH]), attachments)
    const injected: Attachment[] = [{ id: 'evil', name: 'evil.exe', size: 1, mimeType: 'application/x-msdownload', transferState: 'complete' }]
    const wire = wireOf(built.envelopes, { attachmentsCipher: built.attachmentsCipher, attachments: injected })
    expect(readChatAttachments(bob, wire, built.envelopes[0], aliceDH)).toEqual(attachments)
  })

  it('rejects a blob that a recipient swapped in with the same key', async () => {
    // Bob knows the message key. He must not be able to give Carol a different
    // blob under Alice's name: Carol's key box pins the hash of the real blob.
    const built = buildChatEnvelopes(alice, 'hi', 'alice', targetsFor(['bob', bobDH], ['carol', carolDH]), attachments)
    await _sodium.ready
    const s = _sodium
    const bobKeyBox = built.envelopes[0].attachmentKey!
    const keyJson = JSON.parse(s.to_string(s.crypto_box_open_easy(
      s.from_base64(bobKeyBox.ciphertext), s.from_base64(bobKeyBox.nonce),
      s.from_base64(aliceDH), s.from_base64(bobDHSecret),
    ))) as { k: string }
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES)
    const forged = s.crypto_secretbox_easy(
      s.from_string(JSON.stringify([{ ...attachments[0], name: 'forged.pdf' }])), nonce, s.from_base64(keyJson.k),
    )
    const wire = wireOf(built.envelopes, {
      attachmentsCipher: { ciphertext: s.to_base64(forged), nonce: s.to_base64(nonce) },
    })
    expect(readChatAttachments(carol, wire, built.envelopes[1], aliceDH)).toEqual([])
    // Sanity: Bob's own view of the forged blob opens (he has the key) but also fails the hash.
    expect(readChatAttachments(bob, wire, built.envelopes[0], aliceDH)).toEqual([])
  })

  it('rejects a tampered blob', () => {
    const built = buildChatEnvelopes(alice, 'hi', 'alice', targetsFor(['bob', bobDH]), attachments)
    const c = built.attachmentsCipher!
    const tampered = { ...c, ciphertext: c.ciphertext.slice(0, -2) + (c.ciphertext.endsWith('AA') ? 'BB' : 'AA') }
    const wire = wireOf(built.envelopes, { attachmentsCipher: tampered })
    expect(readChatAttachments(bob, wire, built.envelopes[0], aliceDH)).toEqual([])
  })
})

describe('new sender → old (pre-0.2.14) receiver', () => {
  it('envelopes keep every v1 field and still decrypt with the v1 algorithm', () => {
    const built = buildChatEnvelopes(alice, 'text for old peers', 'alice', targetsFor(['bob', bobDH]), attachments)
    const env = overTheWire(built.envelopes[0])
    expect(env.version).toBe(1)
    for (const field of ['senderId', 'recipientId', 'ciphertext', 'nonce', 'senderSignature'] as const) {
      expect(typeof env[field]).toBe('string')
    }
    expect(bob.decryptMessage(env, aliceDH, aliceSign)).toBe('text for old peers')
  })

  it('an old receiver sees the text and no attachments (the documented degradation)', () => {
    const built = buildChatEnvelopes(alice, 'text', 'alice', targetsFor(['bob', bobDH]), attachments)
    const wire = overTheWire(wireOf(built.envelopes, { attachmentsCipher: built.attachmentsCipher }))
    // Old receivers did exactly this: sanitizeAttachments(wire.attachments ?? []).
    expect(sanitizeAttachments(wire.attachments ?? [])).toEqual([])
  })
})

describe('old (pre-0.2.14) sender → new receiver', () => {
  it('plaintext attachments are still accepted', () => {
    const env = alice.encryptMessage('legacy', 'alice', 'bob', bobDH)
    const wire = overTheWire(wireOf([env], { attachments }))
    expect(bob.decryptMessage(wire.envelopes[0], aliceDH, aliceSign)).toBe('legacy')
    expect(readChatAttachments(bob, wire, wire.envelopes[0], aliceDH)).toEqual(attachments)
  })

  it('invalid plaintext previews and non-object entries are dropped', () => {
    const env = alice.encryptMessage('legacy', 'alice', 'bob', bobDH)
    const bad = [
      { ...attachments[0], previewDataUrl: 'javascript:alert(1)' },
      'not-an-attachment',
      null,
    ] as unknown as Attachment[]
    const wire = wireOf([env], { attachments: bad })
    const { previewDataUrl: _p, ...clean } = bad[0] as Attachment
    expect(readChatAttachments(bob, wire, env, aliceDH)).toEqual([clean])
  })
})

describe('frame budget', () => {
  it('a full-budget preview plus 20 recipients fits one data-channel frame', () => {
    const header = 'data:image/webp;base64,'
    const preview = header + 'A'.repeat(MESSAGE_PREVIEW_BUDGET_CHARS - header.length)
    const withPreview: Attachment[] = [{ ...attachments[0], name: 'photo.webp', mimeType: 'image/webp', previewDataUrl: preview }]
    const targets = Array.from({ length: 20 }, (_, i) => ({ recipientId: `0190f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`, dhKey: bobDH }))
    const built = buildChatEnvelopes(alice, 'x'.repeat(200), 'alice', targets, withPreview)
    const wire = wireOf(built.envelopes, {
      messageId: '0190f0a0-0000-7000-8000-000000000000',
      attachmentsCipher: built.attachmentsCipher,
    })
    // SCTP_SAFE_BYTES in syncService; the data channel limit is ~64 KB.
    expect(JSON.stringify(wire).length).toBeLessThan(60_000)
  })

  it('one image at the preview size target fits the per-message budget', () => {
    // base64 of PREVIEW_TARGET_BYTES plus the data-URL header
    const encodedChars = Math.ceil(PREVIEW_TARGET_BYTES / 3) * 4 + 'data:image/webp;base64,'.length
    expect(encodedChars).toBeLessThanOrEqual(MESSAGE_PREVIEW_BUDGET_CHARS)
  })
})
