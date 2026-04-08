/**
 * Structural validators for peer data-channel messages.
 * Each function returns true if the message has the required shape.
 * Guards against malformed or malicious payloads from untrusted peers.
 */

type Obj = Record<string, unknown>

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function isValidChatMessage(msg: Obj): boolean {
  return (
    isString(msg.messageId) &&
    isString(msg.channelId) &&
    isString(msg.serverId) &&
    isString(msg.authorId) &&
    Array.isArray(msg.envelopes)
  )
}

const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'offline'])

export function isValidPresenceUpdate(msg: Obj): boolean {
  return isString(msg.status) && VALID_STATUSES.has(msg.status)
}

export function isValidMutation(msg: Obj): boolean {
  const m = msg.mutation as Obj | undefined
  return (
    m !== undefined &&
    typeof m === 'object' &&
    isString(m.id) &&
    isString(m.type) &&
    isString(m.authorId) &&
    isString(m.logicalTs)
  )
}

export function isValidTypingStart(msg: Obj): boolean {
  return isString(msg.channelId)
}

export function isValidProfileUpdate(msg: Obj): boolean {
  return msg.payload !== undefined && msg.payload !== null && typeof msg.payload === 'object'
}

export function isValidVoiceJoin(msg: Obj): boolean {
  return isString(msg.channelId)
}
