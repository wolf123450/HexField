/**
 * chatWire — builds and reads the `chat_message` wire payload.
 *
 * Wire compatibility (spec 08 §4.1):
 *   - 0.2.14+ senders put attachment metadata (name, hash, preview, ...) in
 *     `attachmentsCipher`, encrypted once, and box its key into each envelope
 *     as `attachmentKey`. They never send the plaintext `attachments` field.
 *   - Older senders send plaintext `attachments`. Receivers still accept it.
 *   - Older receivers ignore the unknown fields: they get the text, but no
 *     attachments.
 */

import type { Attachment, EncryptedEnvelope, SealedBox } from '@/types/core'
import type { CryptoService } from '@/services/cryptoService'
import { sanitizeAttachments } from '@/services/attachmentService'

export interface ChatWireMessage {
  type:               'chat_message'
  messageId:          string
  channelId:          string
  serverId:           string
  authorId:           string
  logicalTs:          string
  createdAt:          string
  contentType:        'text' | 'markdown' | 'system'
  envelopes:          EncryptedEnvelope[]
  /** Encrypted JSON array of attachments (0.2.14+). */
  attachmentsCipher?: SealedBox
  /** Legacy plaintext attachments (pre-0.2.14 senders only). Never sent now. */
  attachments?:       Attachment[]
}

/** One recipient key: the envelope goes to `recipientId`, encrypted to `dhKey`. */
export interface EnvelopeTarget {
  recipientId: string
  dhKey:       string
}

type Crypto = Pick<CryptoService, 'encryptMessage' | 'sealForRecipients' | 'openSealed'>

/**
 * Encrypt `content` for each target. When there are attachments, encrypt them
 * once and give every envelope the key.
 */
export function buildChatEnvelopes(
  crypto: Crypto,
  content: string,
  senderId: string,
  targets: EnvelopeTarget[],
  attachments: Attachment[],
): { envelopes: EncryptedEnvelope[]; attachmentsCipher?: SealedBox } {
  const envelopes = targets.map(t => crypto.encryptMessage(content, senderId, t.recipientId, t.dhKey))
  if (attachments.length === 0 || targets.length === 0) return { envelopes }

  const { sealed, keyBoxes } = crypto.sealForRecipients(
    JSON.stringify(attachments),
    targets.map(t => t.dhKey),
  )
  return {
    envelopes: envelopes.map((env, i) => ({ ...env, attachmentKey: keyBoxes[i] })),
    attachmentsCipher: sealed,
  }
}

/**
 * Attachments of a received message. Encrypted metadata wins; the plaintext
 * field is read only when the message has no `attachmentsCipher` (old sender).
 * Returns [] when the encrypted metadata cannot be opened.
 */
export function readChatAttachments(
  crypto: Crypto,
  wire: ChatWireMessage,
  envelope: EncryptedEnvelope,
  senderDHKey: string,
): Attachment[] {
  if (wire.attachmentsCipher) {
    if (!envelope.attachmentKey) return []
    const json = crypto.openSealed(wire.attachmentsCipher, envelope.attachmentKey, senderDHKey)
    if (json === null) {
      console.warn('[chatWire] attachment metadata failed to decrypt for message', wire.messageId)
      return []
    }
    try {
      return toAttachments(JSON.parse(json))
    } catch {
      return []
    }
  }
  return toAttachments(wire.attachments)
}

function toAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []
  return sanitizeAttachments(value.filter(
    (a): a is Attachment => a !== null && typeof a === 'object' && typeof a.id === 'string',
  ))
}
