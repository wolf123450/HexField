# hexfield-server

HexField rendezvous, signal relay, and discovery server. Enables HexField clients to connect across the internet, discover servers/users, resolve invite links, relay WebRTC signaling, provide TURN credentials, and broadcast presence.

## Features

- **Ed25519 challenge-response authentication** — no passwords, no accounts
- **User directory** — discoverable profiles with privacy controls
- **Server registry** — public/unlisted/secret visibility
- **Invite code resolution** — register and resolve invite links
- **WebSocket signal relay** — WebRTC offer/answer/ICE forwarding
- **TURN credential generation** — coturn HMAC-SHA1 shared-secret scheme
- **Per-IP rate limiting** — tower-governor for REST, per-client sliding window for WebSocket
- **SQLite + Diesel ORM** — compile-time checked queries, embedded migrations

## Privacy Controls

### Server Visibility

| Visibility | Listed in `/servers` search | Accessible via `/servers/:id` | Joinable |
|------------|----------------------------|-------------------------------|----------|
| `public` | Yes | Yes | Via invite |
| `unlisted` | No | Yes | Via invite |
| `secret` | No | Members only | Via invite |

### User Discoverability

| Setting | Listed in `/users` search | Accessible via `/users/:id` |
|---------|--------------------------|----------------------------|
| `public` | Yes | Yes |
| `private` | No | Only by users sharing a server |

## Quick Start

```bash
# Build and run
cd server
cargo run

# With custom config
HEXFIELD_PORT=8080 HEXFIELD_DB_PATH=./data/server.db cargo run
```

## Configuration

All options available as CLI flags or environment variables:

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--host` | `HEXFIELD_HOST` | `0.0.0.0` | Bind address |
| `--port` | `HEXFIELD_PORT` | `7700` | Bind port |
| `--db-path` | `HEXFIELD_DB_PATH` | `hexfield-server.db` | SQLite database path |
| `--turn-url` | `HEXFIELD_TURN_URL` | *(empty)* | TURN server URL (e.g. `turn:turn.example.com:3478`) |
| `--turn-secret` | `HEXFIELD_TURN_SECRET` | *(empty)* | TURN shared secret for HMAC credential generation |
| `--turn-ttl` | `HEXFIELD_TURN_TTL` | `86400` | TURN credential TTL in seconds |
| `--max-connections` | `HEXFIELD_MAX_CONNECTIONS` | `5000` | Max concurrent WebSocket connections |
| `--rate-limit-rps` | `HEXFIELD_RATE_LIMIT_RPS` | `30` | REST API per-IP requests per second |
| `--rate-limit-burst` | `HEXFIELD_RATE_LIMIT_BURST` | `60` | REST API per-IP burst size |
| `--ws-msg-rps` | `HEXFIELD_WS_MSG_RPS` | `50` | WebSocket per-client messages per second |

## Docker

```bash
# Build
docker build -t hexfield-server .

# Run
docker run -p 7700:7700 -v hexfield-data:/data \
  -e HEXFIELD_DB_PATH=/data/server.db \
  hexfield-server

# With TURN
docker run -p 7700:7700 -v hexfield-data:/data \
  -e HEXFIELD_DB_PATH=/data/server.db \
  -e HEXFIELD_TURN_URL=turn:turn.example.com:3478 \
  -e HEXFIELD_TURN_SECRET=your-shared-secret \
  hexfield-server
```

## API Reference

### Authentication

#### `POST /auth/challenge`
Request a challenge nonce for Ed25519 authentication.

```json
{
  "user_id": "uuid",
  "public_sign_key": "base64url-encoded-ed25519-pubkey",
  "public_dh_key": "base64url-encoded-x25519-pubkey",
  "display_name": "Alice"
}
```

**Response:** `{ "challenge": "uuid-nonce" }`

#### `POST /auth/verify`
Verify the signed challenge and receive a bearer token.

```json
{
  "user_id": "uuid",
  "public_sign_key": "base64url",
  "public_dh_key": "base64url",
  "display_name": "Alice",
  "signature": "base64url-encoded-ed25519-signature-of-challenge"
}
```

**Response:** `{ "token": "user_id" }`

### Users

All user endpoints require `Authorization: Bearer <token>` header.

#### `GET /users/me` — Get own profile
#### `PUT /users/me` — Update own profile

```json
{
  "display_name": "New Name",
  "avatar_hash": "sha256hex",
  "bio": "Hello!",
  "discoverability": "public"
}
```

#### `GET /users/:user_id` — Get user profile (respects discoverability)
#### `GET /users?q=name&limit=20&offset=0` — Search public users

### Servers

#### `POST /servers` — Register/update server (auth required)

```json
{
  "server_id": "uuid",
  "name": "My Server",
  "description": "A cool server",
  "icon_hash": "sha256hex",
  "visibility": "public"
}
```

#### `GET /servers/:server_id` — Get server info (respects visibility)
#### `PUT /servers/:server_id` — Update server (owner/admin only)
#### `GET /servers?q=name&limit=20&offset=0` — Discover public servers
#### `GET /servers/:server_id/members` — List members (members only)

### Invites

#### `POST /invites` — Register invite code (auth required)

```json
{
  "code": "abc123",
  "server_id": "uuid",
  "server_name": "My Server",
  "endpoints": "[\"ws://192.168.1.5:7710\"]",
  "max_uses": 10,
  "expires_at": "2026-05-01T00:00:00Z"
}
```

#### `GET /invites/:code` — Resolve invite (no auth required)

### TURN

#### `POST /turn/credentials` — Get temporary TURN credentials

```json
{ "user_id": "uuid" }
```

**Response:** `{ "urls": ["turn:..."], "username": "expiry:userId", "credential": "hmac", "ttl": 86400 }`

### WebSocket

#### `GET /ws?token=<userId>&public_sign_key=<base64url>`

Connect for real-time signal relay and presence.

**Inbound message types:**
- `signal_offer`, `signal_answer`, `signal_ice` — forwarded to `to` peer
- `presence_update`, `typing_start`, `typing_stop` — broadcast to all
- `ping` — responds with `pong`

**Outbound events:**
- `presence_update` — peer online/offline notifications
- Signal messages with `from` field injected by server
