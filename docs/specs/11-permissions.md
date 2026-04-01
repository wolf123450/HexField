# Spec 11 — Permissions & Roles Model

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Built-In Roles

| Role | Description |
|------|-------------|
| `owner` | Full control; cannot be removed or demoted; exactly one per server |
| `admin` | All permissions except transferring ownership |
| `moderator` | Can delete messages, kick members |
| `member` | Default role for all joined members |

Custom roles can be created with arbitrary names and any subset of permission flags.

---

## 2. Permission Flags

Each role has a permission bitfield:

| Flag | Description |
|------|-------------|
| `VIEW_CHANNELS` | Can see that channels exist and read history |
| `SEND_MESSAGES` | Can post messages to text channels |
| `ATTACH_FILES` | Can send file attachments |
| `ADD_REACTIONS` | Can react to messages |
| `UPLOAD_EMOJI` | Can add custom emoji to the server |
| `MANAGE_MESSAGES` | Can delete or edit others' messages |
| `MANAGE_CHANNELS` | Can create, rename, reorder, delete channels |
| `MANAGE_MEMBERS` | Can kick members and assign roles below their own |
| `MANAGE_SERVER` | Can change server name, icon, description |
| `BAN_MEMBERS` | Can permanently ban a user from the server |
| `ADMINISTRATOR` | All permissions; equivalent to owner for day-to-day operations |

**Channel-level overrides**: any permission can be overridden per channel per role (allow/deny/inherit). Stored in `channel_permission_overrides` table — sparse, only overrides stored.

**Permission resolution order**:
1. `ADMINISTRATOR` flag → grant all
2. Channel-level `deny` override → deny
3. Channel-level `allow` override → allow
4. Server-level role permission → apply
5. Default → deny

---

## 3. Role Events as Mutations

All role changes are **signed mutations** stored in the `mutations` table with `channel_id = '__server__'`:

```json
{
  "id": "<uuid v7>",
  "type": "role_assign",
  "targetId": "<targetUserId>",
  "channelId": "__server__",
  "authorId": "<assignerUserId>",
  "newContent": "{\"roleName\": \"moderator\", \"serverId\": \"...\"}",
  "logicalTs": "<HLC>",
  "sig": "sign(assignerSignKey, hash(above))"
}
```

**Validation rules** (applied by every client before accepting):
- `role_assign` / `role_revoke` author must have `MANAGE_MEMBERS` permission
- Cannot assign a role at or above the assigner's own highest role
- `owner` role can only be assigned by the current owner (transfer)
- Owner's sign key is the root of trust (stored in server manifest)

**`role_revoke`** mutation: same structure, removes the role from `members.roles`.

---

## 4. Server Manifest (Root Trust Document)

Generated when server is created; signed by owner; never mutated directly:

```json
{
  "serverId": "<uuid v7>",
  "name": "My Gaming Server",
  "createdAt": "<ISO8601>",
  "ownerId": "<uuid v7>",
  "ownerSignKey": "<base64 Ed25519>",
  "defaultRole": "member",
  "defaultPermissions": ["VIEW_CHANNELS", "SEND_MESSAGES", "ADD_REACTIONS"],
  "sig": "sign(ownerSignKey, hash(above))"
}
```

Embedded in QR code invites and gossiped to all members. Immutable. Any peer can verify it.

Changes to server settings (name, icon, etc.) are separate `server_update` mutations:

```json
{
  "type": "server_update",
  "targetId": "<serverId>",
  "channelId": "__server__",
  "newContent": "{\"name\": \"New Name\", \"iconUrl\": \"...\"}",
  "sig": "sign(authorSignKey, hash(above))"
}
```

Applied last-write-wins by `logical_ts`.

---

## 5. Soft Enforcement

In a P2P model there is no authoritative server to enforce permissions at runtime:

- **Forgery is impossible**: signed events from users who lack permission will be rejected by peers who validate signatures and trust chains
- **Ignoring is possible**: a malicious modified client could ignore role checks locally, but its events will not be rendered by honest peers
- **Practical effect**: permissions reliably prevent accidental mistakes and casual abuse; a determined attacker running a modified client cannot affect other honest clients' views

---

## 6. TypeScript Permission Helpers

```typescript
// src/utils/permissions.ts

export function hasPermission(
  member: ServerMember,
  permission: PermissionFlag,
  channelId?: string
): boolean {
  // 1. Check ADMINISTRATOR
  if (member.roles.some(r => getRolePermissions(r).includes('ADMINISTRATOR'))) return true

  // 2. Check channel overrides (if channelId provided)
  if (channelId) {
    const override = getChannelOverride(channelId, member.roles, permission)
    if (override === 'allow') return true
    if (override === 'deny') return false
  }

  // 3. Check server-level role permissions
  return member.roles.some(r => getRolePermissions(r).includes(permission))
}

export function canAssignRole(assigner: ServerMember, roleName: string): boolean {
  const assignerHighest = getHighestRoleLevel(assigner.roles)
  const targetRoleLevel = getRoleLevel(roleName)
  return hasPermission(assigner, 'MANAGE_MEMBERS') && assignerHighest > targetRoleLevel
}
```
