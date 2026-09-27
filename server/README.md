# hexfield-server

HexField rendezvous, signal relay, and discovery server. Enables HexField clients to connect across the internet, discover servers/users, resolve invite links, relay WebRTC signaling and provide TURN credentials.

The server is a **signaling mailbox**, not a chat relay. It forwards only `signal_offer`/`signal_answer`/`signal_ice` messages to the addressed user. Messages, sync, presence and typing go peer-to-peer and never pass through it.

## Features

- **Ed25519 challenge-response authentication** — no passwords, no accounts; issues signed, expiring session tokens
- **User directory** — discoverable profiles with privacy controls
- **Server registry** — public/unlisted/secret visibility
- **Invite code resolution** — register and resolve invite links
- **WebSocket signal relay** — WebRTC offer/answer/ICE forwarding
- **TURN credential generation** — Cloudflare Realtime TURN (short-lived keys via its API), or coturn HMAC-SHA1 shared-secret scheme
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
| `--cf-turn-key-id` | `HEXFIELD_CF_TURN_KEY_ID` | *(empty)* | Cloudflare Realtime TURN key ID. With the API token set, Cloudflare is used instead of coturn |
| `--cf-turn-api-token` | `HEXFIELD_CF_TURN_API_TOKEN` | *(empty)* | Cloudflare Realtime TURN key API token (keep secret) |
| `--turn-ttl` | `HEXFIELD_TURN_TTL` | `86400` | TURN credential TTL in seconds (both backends) |
| `--max-connections` | `HEXFIELD_MAX_CONNECTIONS` | `5000` | Max concurrent WebSocket connections |
| `--rate-limit-rps` | `HEXFIELD_RATE_LIMIT_RPS` | `30` | REST API per-IP requests per second |
| `--rate-limit-burst` | `HEXFIELD_RATE_LIMIT_BURST` | `60` | REST API per-IP burst size |
| `--ws-msg-rps` | `HEXFIELD_WS_MSG_RPS` | `50` | WebSocket per-client messages per second |
| `--session-secret` | `HEXFIELD_SESSION_SECRET` | *(empty)* | HMAC-SHA256 key for session tokens (keep secret; generate 32+ random bytes once, e.g. `openssl rand -base64 48`, and keep them). If empty, a random key is generated at startup with a warning, and all tokens become invalid when the server restarts |
| `--session-ttl` | `HEXFIELD_SESSION_TTL` | `86400` | Session token lifetime in seconds |

## Docker

```bash
# Build
docker build -t hexfield-server .

# Run
docker run -p 7700:7700 -v hexfield-data:/data \
  -e HEXFIELD_DB_PATH=/data/server.db \
  -e HEXFIELD_SESSION_SECRET=your-session-secret \
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

Flow: `POST /auth/challenge` → sign the challenge string with the Ed25519 identity key → `POST /auth/verify` with the signature and the challenge → session token. Use the token as `Authorization: Bearer <token>` on authenticated routes and on the `/ws` upgrade request. Tokens are never read from a URL, so they do not end up in proxy access logs.

- The token is `base64url(claims).base64url(mac)`: claims `{"sub": user_id, "exp": unix_seconds}`, MAC = HMAC-SHA256 with `HEXFIELD_SESSION_SECRET`. The server checks it in constant time and rejects expired tokens.
- A user ID is bound to the first sign key that authenticates for it. A later `/auth/verify` for the same user ID with a different key returns `401`.
- Authenticated routes return `401` for a missing, forged or expired token. Clients re-authenticate and retry.
- Challenges are stateless: `base64url(claims).base64url(mac)` with claims `{"sub": user_id, "nonce", "exp"}` (5 minutes), MAC'd with the same secret under a separate context, so a challenge is never a valid session token. The server stores no per-user challenge, so a third party who requests a challenge for your user ID cannot invalidate yours. Each challenge works once: its nonce is recorded after a successful signature check.

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

**Response:** `{ "challenge": "<opaque signed challenge>" }`. Sign its UTF-8 bytes and send it back unchanged to `/auth/verify`.

#### `POST /auth/verify`
Verify the signed challenge and receive a session token.

```json
{
  "user_id": "uuid",
  "public_sign_key": "base64url",
  "public_dh_key": "base64url",
  "display_name": "Alice",
  "signature": "base64url-encoded-ed25519-signature-of-challenge",
  "challenge": "<the challenge string from /auth/challenge>"
}
```

**Response:** `{ "token": "<session token>", "expires_at": <unix seconds> }`. `401` if the challenge is missing, forged, expired, already used or issued for another user ID, the signature is wrong, or the user ID is already bound to another key.

### Users

`/users/me` requires `Authorization: Bearer <token>`. On `/users/:user_id` the token is optional; with a valid one, private profiles of users who share a server with the caller are visible.

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

#### `GET /servers/:server_id` — Get server info (respects visibility; optional token to see `secret` servers you are a member of)
#### `PUT /servers/:server_id` — Update server (auth required, owner/admin only)
#### `GET /servers?q=name&limit=20&offset=0` — Discover public servers
#### `GET /servers/:server_id/members` — List members (auth required, members only)

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

#### `POST /turn/credentials` — Get temporary TURN credentials (auth required)

Requires `Authorization: Bearer <token>`, so only authenticated users can mint (possibly billed) credentials. Any request body is ignored; older clients send `{ "user_id": "uuid" }`, which is accepted but not trusted. The user comes from the token.

**Response:** `{ "urls": ["turn:..."], "username": "...", "credential": "...", "ttl": 86400 }`

- Cloudflare backend: the credentialed entry from Cloudflare's `generate-ice-servers` response (port-53 URLs removed).
- coturn backend: `username` is `expiry:userId` (the token's user) and `credential` is the HMAC-SHA1 of it with the shared secret.
- `401` without a valid session token; `503` when neither backend is configured; `502` when Cloudflare's API fails.

Clients refresh credentials at 80% of `ttl`. The HexField client (webrtc-rs 0.17) only uses UDP `turn:` URLs; `turns:`/TCP entries are ignored.

### WebSocket

#### `GET /ws` with `Authorization: Bearer <session token>`

Connect for signal relay. The upgrade is rejected with `401` unless the `Authorization` header carries a valid session token. A `token` query value is not accepted (it would leak into proxy logs). The connection's user ID comes from the token. A new connection for the same user replaces the old one.

When the token expires, the server sends `{"type":"session_expired"}` and closes the socket with close code `4001`. To keep the socket open, send a fresh token before then (see `auth` below); otherwise re-authenticate and reconnect.

**Inbound message types:**
- `signal_offer`, `signal_answer`, `signal_ice` — forwarded to the connected user named in `to`. The server sets `from` to the authenticated sender.
- `ping` — answered with `{"type":"pong"}`. Clients send one about every 45 s as a keepalive and reconnect if nothing arrives for two intervals.
- `{"type":"auth","token":"<session token>"}` — a fresh token for the same user extends the connection to the new token's expiry. Answered with `{"type":"auth_ok","expires_at":<unix seconds>}`, or `{"type":"auth_failed"}` (invalid token or another user's; the old expiry stays). The HexField client sends this at 80% of the token lifetime.
- Anything else (including `presence_update`, `typing_start`, `typing_stop`) is dropped.

**Outbound messages:**
- Forwarded `signal_*` messages, with `from` injected by the server.
- `{"type":"peer_unavailable","to":"<userId>"}` — sent only to the sender when the `to` user of a `signal_*` message is not connected. The server never broadcasts: there are no presence or typing events, so no one learns who is online without addressing them directly.
- `pong`, `auth_ok`, `auth_failed`, `session_expired`.
