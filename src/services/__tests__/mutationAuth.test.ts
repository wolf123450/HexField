// @vitest-environment node
/**
 * mutationAuth — signing at creation and the shared receive-side checks used by
 * both the live mutation path and history sync (spec 08 §5).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { Mutation } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { cryptoService } from '@/services/cryptoService'
import {
  signMutation,
  verifyMutationSignature,
  authorizeMutation,
  mutationToRow,
  wireToUnverifiedMutation,
  serializeMutation,
} from '@/services/mutationAuth'
import type { MutationAuthDeps, TargetMessage } from '@/services/mutationAuth'

// The singleton holds one identity at a time; switch between generated users.
interface TestUser { id: string; signSecret: string; dhSecret: string; pub: string }
async function makeUser(id: string): Promise<TestUser> {
  const { signSecret, dhSecret } = await cryptoService.generateKeys()
  return { id, signSecret, dhSecret, pub: cryptoService.getPublicSignKey() }
}
async function as<T>(user: TestUser, fn: () => T): Promise<T> {
  await cryptoService.loadKeys(user.signSecret, user.dhSecret)
  return fn()
}

let alice: TestUser
let bob: TestUser
let mallory: TestUser

const MSG_BY_ALICE: TargetMessage = { authorId: 'alice', channelId: 'ch-1', serverId: 'srv-1' }

function deps(overrides: Partial<MutationAuthDeps> = {}): MutationAuthDeps {
  const keys: Record<string, string[]> = { alice: [alice.pub], bob: [bob.pub], mallory: [mallory.pub] }
  return {
    knownSignKeys:   async (userId) => keys[userId] ?? [],
    getMessage:      async (id) => (id === 'msg-1' ? MSG_BY_ALICE : null),
    channelServerId: async (channelId) => (channelId === 'ch-1' ? 'srv-1' : channelId === 'ch-other' ? 'srv-2' : null),
    serverOwnerId:   async (serverId) => (serverId === 'srv-1' ? 'alice' : null),
    isServerAdmin:   async (userId, serverId) => serverId === 'srv-1' && userId === 'alice',
    ...overrides,
  }
}

function base(authorId: string, over: Partial<Mutation> = {}): Omit<Mutation, 'sig' | 'verified'> {
  return {
    id:        `mut-${authorId}-${over.type ?? 'edit'}`,
    type:      'edit',
    targetId:  'msg-1',
    channelId: 'ch-1',
    authorId,
    newContent: 'edited',
    logicalTs: '1750000000000-000001',
    createdAt: '2025-06-01T00:00:00.000Z',
    ...over,
  }
}

/** Simulate transit: wire JSON → receiver's unverified Mutation. */
function transit(m: Mutation): Mutation {
  return wireToUnverifiedMutation(JSON.parse(JSON.stringify(serializeMutation(m))))
}

beforeAll(async () => {
  await cryptoService.init()
  alice   = await makeUser('alice')
  bob     = await makeUser('bob')
  mallory = await makeUser('mallory')
})

describe('signMutation / verifyMutationSignature', () => {
  it('sign → verify round-trip, including after wire transit and a DB row', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    expect(m.sig).toBeTruthy()
    expect(m.verified).toBe(true)
    expect(verifyMutationSignature(m, alice.pub)).toBe(true)
    expect(verifyMutationSignature(transit(m), alice.pub)).toBe(true)

    // A DB row carries nulls for absent optional fields; they sign the same.
    const row = mutationToRow(m)
    expect(row.emoji_id).toBeNull()
    expect(row.sig).toBe(m.sig)
  })

  it('rejects a signature under a different key', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    expect(verifyMutationSignature(m, bob.pub)).toBe(false)
  })

  it('rejects any change to a signed field', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    expect(verifyMutationSignature({ ...m, newContent: 'tampered' }, alice.pub)).toBe(false)
    expect(verifyMutationSignature({ ...m, channelId: 'ch-other' }, alice.pub)).toBe(false)
    expect(verifyMutationSignature({ ...m, emojiId: 'x' }, alice.pub)).toBe(false)
  })
})

describe('authorizeMutation', () => {
  it('accepts a valid own edit and marks it verified', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    const res = await authorizeMutation(transit(m), { senderId: 'alice', serverId: 'srv-1' }, deps())
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.mutation.verified).toBe(true)
  })

  it('never trusts the verified flag from the wire', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    const received = transit(m)
    expect(received.verified).toBe(false)
  })

  it('rejects an unsigned mutation', async () => {
    const res = await authorizeMutation({ ...base('alice'), verified: true }, {}, deps())
    expect(res).toEqual({ ok: false, reason: 'unsigned' })
  })

  it('rejects a bad signature (signed by someone else, claiming alice)', async () => {
    const forged = await as(mallory, () => signMutation(base('alice')))
    const res = await authorizeMutation(transit(forged), {}, deps())
    expect(res).toEqual({ ok: false, reason: 'bad signature' })
  })

  it('rejects a mutation from an author with no known key', async () => {
    const m = await as(mallory, () => signMutation(base('mallory')))
    const res = await authorizeMutation(transit(m), {}, deps({ knownSignKeys: async () => [] }))
    expect(res).toEqual({ ok: false, reason: 'unknown author key' })
  })

  it('rejects an edit of someone else\'s message (validly signed by the editor)', async () => {
    const m = await as(bob, () => signMutation(base('bob')))
    const res = await authorizeMutation(transit(m), { senderId: 'bob' }, deps())
    expect(res.ok).toBe(false)
  })

  it('rejects a delete of someone else\'s message by a non-admin', async () => {
    const m = await as(bob, () => signMutation(base('bob', { type: 'delete', newContent: undefined })))
    const res = await authorizeMutation(transit(m), {}, deps())
    expect(res.ok).toBe(false)
  })

  it('accepts a delete of someone else\'s message by a server admin', async () => {
    const target: TargetMessage = { authorId: 'bob', channelId: 'ch-1', serverId: 'srv-1' }
    const m = await as(alice, () => signMutation(base('alice', { type: 'delete', newContent: undefined })))
    const res = await authorizeMutation(transit(m), {}, deps({ getMessage: async () => target }))
    expect(res.ok).toBe(true)
  })

  it('drops an edit whose target message is unknown', async () => {
    const m = await as(alice, () => signMutation(base('alice', { targetId: 'msg-missing' })))
    const res = await authorizeMutation(transit(m), {}, deps())
    expect(res).toEqual({ ok: false, reason: 'unknown target message' })
  })

  it('rejects a mutation whose target message is in another channel', async () => {
    const m = await as(alice, () => signMutation(base('alice', { channelId: 'ch-other' })))
    const res = await authorizeMutation(transit(m), {}, deps())
    expect(res).toEqual({ ok: false, reason: 'target is in another channel' })
  })

  it('live path: rejects when the sending peer is not the author', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    const res = await authorizeMutation(transit(m), { senderId: 'mallory' }, deps())
    expect(res).toEqual({ ok: false, reason: 'sender is not the author' })
  })

  it('live path: drops a mutation whose channel is not in the stated server', async () => {
    const m = await as(alice, () => signMutation(base('alice')))
    const res = await authorizeMutation(transit(m), { serverId: 'srv-2' }, deps())
    expect(res).toEqual({ ok: false, reason: 'channel does not belong to server' })
  })

  it('reactions: accepted from the reacting user, rejected when claimed for another', async () => {
    const own = await as(bob, () => signMutation(base('bob', { type: 'reaction_add', newContent: undefined, emojiId: '👍' })))
    expect((await authorizeMutation(transit(own), { senderId: 'bob' }, deps())).ok).toBe(true)

    const asAlice = await as(bob, () => signMutation(base('alice', { type: 'reaction_add', newContent: undefined, emojiId: '👍' })))
    expect(await authorizeMutation(transit(asAlice), {}, deps())).toEqual({ ok: false, reason: 'bad signature' })
  })

  it('member_profile_update must be about the author', async () => {
    const m = await as(bob, () => signMutation(base('bob', { type: 'member_profile_update', targetId: 'alice', channelId: '__server__', newContent: '{}' })))
    expect((await authorizeMutation(transit(m), {}, deps())).ok).toBe(false)
  })

  it('server-level mutations require a valid signature', async () => {
    const good = await as(alice, () => signMutation(base('alice', { type: 'server_update', targetId: 'srv-1', channelId: '__server__', newContent: '{"name":"X"}' })))
    expect((await authorizeMutation(transit(good), { serverId: 'srv-1' }, deps())).ok).toBe(true)
    expect((await authorizeMutation({ ...transit(good), sig: undefined }, {}, deps())).ok).toBe(false)
  })

  describe('member_join', () => {
    function join(userId: string, pub: string, roles: string[] = ['member']) {
      return base(userId, {
        type: 'member_join', targetId: userId, channelId: '__server__',
        newContent: JSON.stringify({ userId, serverId: 'srv-1', publicSignKey: pub, publicDHKey: 'dh', roles }),
      })
    }
    const noKnownKeys = () => deps({ knownSignKeys: async () => [] })

    it('accepts a self-join from a new user, verified by the introduced key', async () => {
      const carol = await makeUser('carol')
      const m = signMutation(join('carol', carol.pub))
      expect((await authorizeMutation(transit(m), { senderId: 'carol' }, noKnownKeys())).ok).toBe(true)
    })

    it('rejects a join that replaces the known key of an existing user', async () => {
      const m = await as(mallory, () => signMutation(join('alice', mallory.pub)))
      expect(await authorizeMutation(transit(m), {}, deps()))
        .toEqual({ ok: false, reason: 'member_join key conflicts with known key' })
    })

    it('rejects a join signed by a key other than the one it introduces', async () => {
      const m = await as(mallory, () => signMutation(join('carol', bob.pub)))
      expect(await authorizeMutation(transit(m), {}, noKnownKeys())).toEqual({ ok: false, reason: 'bad signature' })
    })

    it('rejects a join claiming admin by a non-owner, accepts owner roles for the owner', async () => {
      const bobAdmin = await as(bob, () => signMutation(join('bob', bob.pub, ['admin'])))
      expect(await authorizeMutation(transit(bobAdmin), {}, deps()))
        .toEqual({ ok: false, reason: 'member_join claims elevated roles' })

      const owner = await as(alice, () => signMutation(join('alice', alice.pub, ['owner', 'admin'])))
      expect((await authorizeMutation(transit(owner), {}, deps())).ok).toBe(true)
    })

    it('rejects a join authored on behalf of another user', async () => {
      const m = await as(bob, () => signMutation({ ...join('carol', bob.pub), authorId: 'bob' }))
      expect(await authorizeMutation(transit(m), {}, deps()))
        .toEqual({ ok: false, reason: 'member_join for another user' })
    })
  })
})
