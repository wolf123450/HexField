# Spec 13 — Matrix Compatibility (Stretch Goal)

> Parent: [Architecture Plan](../architecture-plan.md)

---

## Overview

A dual-mode client: "Native P2P" mode (default) vs "Matrix" mode. The Vue UI layer stays unchanged in both modes; only the networking layer switches.

---

## NetworkProvider Interface

```typescript
// src/utils/networkProvider.ts

export interface NetworkProvider {
  connect(config: ConnectionConfig): Promise<void>
  disconnect(): Promise<void>
  sendMessage(channelId: string, envelopes: EncryptedEnvelope[]): Promise<void>
  sendSignal(payload: SignalPayload): Promise<void>
  joinServer(inviteCode: string): Promise<Server>
  createServer(name: string): Promise<Server>
  fetchMembers(serverId: string): Promise<ServerMember[]>
  onMessage(handler: (msg: WireMessage) => void): void
}

// Implementations:
// NativeP2PProvider  — current implementation (WebRTC + optional rendezvous)
// MatrixProvider     — matrix-js-sdk + Megolm E2E
```

---

## MatrixProvider Mapping

| HexField concept | Matrix concept |
|------------------|----------------|
| Server | Space |
| Channel | Room (inside a Space) |
| Message | `m.room.message` event |
| Custom emoji | Custom sticker packs / MSC2545 |
| Voice channel | Element Call / MSC3401 |
| E2E encryption | Megolm (built into matrix-js-sdk) |
| Invite code | Room alias / Space invite |
| Server member | Space member |

---

## Implementation Path

1. **Prerequisite**: Native P2P mode must be feature-complete and stable before abstracting
2. **Step 1**: Extract `NetworkProvider` interface from existing `signalingService` / `webrtcService`
3. **Step 2**: Refactor current code into `NativeP2PProvider`
4. **Step 3**: Implement `MatrixProvider` using `matrix-js-sdk`
5. **Step 4**: Add Settings toggle ("Connection mode: Native P2P / Matrix")
6. **Step 5**: Provider switching persists + requires app restart (simpler than live migration)

---

## Trade-offs

| Aspect | Native P2P | Matrix |
|--------|-----------|--------|
| Server required | Optional | Required (homeserver) |
| Message history | Local SQLite + P2P sync | Homeserver persistent |
| E2E crypto | libsodium custom | Megolm (proven) |
| Voice | WebRTC mesh | Element Call / Janus |
| Interop | HexField only | All Matrix clients |
| Self-hosting | `hexfield-server` (minimal) | Synapse / Dendrite (complex) |

---

## Estimate

4–6 additional weeks after Native P2P mode is stable and the abstraction boundary is well-understood.
