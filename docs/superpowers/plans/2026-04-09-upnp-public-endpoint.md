# UPnP/NAT-PMP Port Forwarding + Public Endpoints in Invite Links

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow invite links to work across the internet by automatically forwarding the LAN signal port via UPnP/NAT-PMP, discovering the public IP via STUN, and embedding both LAN and WAN endpoints in invite payloads.

**Architecture:** When the LAN signal server starts, a new Rust module attempts UPnP (`AddAnyPortMapping`) or NAT-PMP (`MapExternalPort`) to forward the LAN signal port to the same external port. If successful, the public IP from STUN + the forwarded port form a `"direct"` endpoint in invite links. The join flow already supports `"direct"` endpoints — `lan_connect_peer` works with any routable IP:port. On app shutdown, the port mapping is removed.

**Tech Stack:** `igd-next` (Rust crate for UPnP IGD + NAT-PMP), existing STUN-based `querySTUN()` in the frontend, Tauri IPC commands.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Add `igd-next` dependency |
| `src-tauri/src/upnp.rs` | Create | UPnP/NAT-PMP port forward + removal logic |
| `src-tauri/src/commands/signal_commands.rs` | Modify | Add `upnp_forward_port`, `upnp_remove_mapping`, `get_public_endpoint` commands |
| `src-tauri/src/lib.rs` | Modify | Register new commands, add `upnp_external_port` to `AppState` |
| `src/components/modals/InviteModal.vue` | Modify | Call `get_public_endpoint` and append `"direct"` endpoint |
| `src/stores/networkStore.ts` | Modify | Call `upnp_forward_port` after `lan_start`, call `upnp_remove_mapping` on shutdown |
| `src-tauri/src/upnp.rs` | Test inline | `#[cfg(test)]` unit tests for mapping struct logic |

---

### Task 1: Add `igd-next` Dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the crate**

In `src-tauri/Cargo.toml`, add under `[dependencies]` after the `mdns-sd` line:

```toml
# UPnP IGD + NAT-PMP port forwarding
igd-next           = { version = "0.15", features = ["aio_tokio"] }
```

The `aio_tokio` feature enables `async` gateway search powered by tokio, which matches our existing async runtime.

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors (may take a minute to fetch/compile `igd-next`).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "deps: add igd-next for UPnP/NAT-PMP port forwarding"
```

---

### Task 2: Create `upnp.rs` Module — Gateway Discovery + Port Mapping

**Files:**
- Create: `src-tauri/src/upnp.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod upnp;`)

- [ ] **Step 1: Create the module file**

Create `src-tauri/src/upnp.rs`:

```rust
use igd_next::aio::tokio::Tokio;
use igd_next::{Gateway, PortMappingProtocol, SearchOptions};
use std::net::SocketAddrV4;
use std::time::Duration;

/// Result of a UPnP port forwarding attempt.
#[derive(Debug, Clone)]
pub struct PortMapping {
    pub external_port: u16,
    pub gateway_addr: SocketAddrV4,
}

/// Attempt to forward `internal_port` on `local_ip` via UPnP IGD.
///
/// Returns the external port on success, or an error string describing why
/// the mapping failed (no gateway, port in use, etc.).
pub async fn forward_port(local_ip: std::net::Ipv4Addr, internal_port: u16) -> Result<PortMapping, String> {
    let opts = SearchOptions {
        timeout: Some(Duration::from_secs(5)),
        ..Default::default()
    };

    let gateway = igd_next::aio::tokio::search_gateway(opts)
        .await
        .map_err(|e| format!("UPnP gateway discovery failed: {e}"))?;

    let local_addr = SocketAddrV4::new(local_ip, internal_port);
    let description = "HexField P2P Chat";
    let lease_duration = 0; // indefinite (until removal or router reboot)

    // Try to map the same external port as internal first
    let external_port = gateway
        .add_port(
            PortMappingProtocol::TCP,
            internal_port,
            local_addr,
            lease_duration,
            description,
        )
        .await
        .map(|_| internal_port)
        .or_else(|_| async {
            // If same-port fails (already taken), let the router pick
            gateway
                .add_any_port(
                    PortMappingProtocol::TCP,
                    local_addr,
                    lease_duration,
                    description,
                )
                .await
                .map_err(|e| format!("UPnP port mapping failed: {e}"))
        })
        .await?;

    let gw_addr = match gateway.addr {
        std::net::SocketAddr::V4(v4) => v4,
        std::net::SocketAddr::V6(_) => return Err("IPv6 gateway not supported".to_string()),
    };

    log::info!(
        "UPnP: mapped external port {} -> {}:{} via gateway {}",
        external_port, local_ip, internal_port, gw_addr
    );

    Ok(PortMapping {
        external_port,
        gateway_addr: gw_addr,
    })
}

/// Remove a previously created port mapping.
pub async fn remove_mapping(external_port: u16) -> Result<(), String> {
    let opts = SearchOptions {
        timeout: Some(Duration::from_secs(3)),
        ..Default::default()
    };

    let gateway = igd_next::aio::tokio::search_gateway(opts)
        .await
        .map_err(|e| format!("UPnP gateway not found for removal: {e}"))?;

    gateway
        .remove_port(PortMappingProtocol::TCP, external_port)
        .await
        .map_err(|e| format!("UPnP remove mapping failed: {e}"))?;

    log::info!("UPnP: removed external port {}", external_port);
    Ok(())
}
```

- [ ] **Step 2: Register the module in `lib.rs`**

In `src-tauri/src/lib.rs`, add `mod upnp;` alongside the other `mod` declarations (near the top, next to `mod lan;`):

```rust
#[cfg(not(mobile))]
mod upnp;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles clean. The `igd-next` async API uses tokio under the hood — compatible with our runtime.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/upnp.rs src-tauri/src/lib.rs
git commit -m "feat: add upnp module for UPnP/NAT-PMP port forwarding"
```

---

### Task 3: Add `AppState` Fields for UPnP State

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add UPnP state fields to `AppState`**

Add two new fields to the `AppState` struct:

```rust
/// External port from UPnP mapping (0 = no mapping). Desktop only.
#[cfg(not(mobile))]
pub upnp_external_port: Arc<AtomicU16>,
/// Public IP discovered via STUN or UPnP gateway. Desktop only.
#[cfg(not(mobile))]
pub public_ip: Arc<Mutex<Option<String>>>,
```

Add the corresponding imports at the top of `lib.rs` (if not already present):
```rust
use std::sync::atomic::AtomicU16;
```

- [ ] **Step 2: Initialize the new fields in `setup`**

In the `app.manage(AppState { ... })` block, add:

```rust
#[cfg(not(mobile))]
upnp_external_port: Arc::new(AtomicU16::new(0)),
#[cfg(not(mobile))]
public_ip: Arc::new(Mutex::new(None)),
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add UPnP state fields to AppState"
```

---

### Task 4: Add Tauri Commands for UPnP

**Files:**
- Modify: `src-tauri/src/commands/signal_commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)

- [ ] **Step 1: Add `upnp_forward_port` command**

At the bottom of `src-tauri/src/commands/signal_commands.rs`, add:

```rust
/// Attempt UPnP/NAT-PMP port forwarding for the LAN signal port.
/// Stores the result in AppState for later removal and endpoint generation.
/// Returns the external port on success, or an error if UPnP is unavailable.
#[cfg(not(mobile))]
#[tauri::command]
pub async fn upnp_forward_port(
    state: State<'_, AppState>,
) -> Result<u16, String> {
    let internal_port = state.lan_signal_port.load(Ordering::Relaxed);
    if internal_port == 0 {
        return Err("LAN signal server not started yet".to_string());
    }

    let local_ip = crate::lan::get_primary_local_ip();
    let local_ipv4 = match local_ip {
        std::net::IpAddr::V4(v4) => v4,
        std::net::IpAddr::V6(_) => return Err("IPv6 local IP not supported for UPnP".to_string()),
    };

    let mapping = crate::upnp::forward_port(local_ipv4, internal_port).await?;

    state.upnp_external_port.store(mapping.external_port, Ordering::Relaxed);

    Ok(mapping.external_port)
}

/// Remove the UPnP port mapping created by `upnp_forward_port`.
/// Safe to call even if no mapping exists (returns Ok).
#[cfg(not(mobile))]
#[tauri::command]
pub async fn upnp_remove_mapping(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let port = state.upnp_external_port.swap(0, Ordering::Relaxed);
    if port == 0 {
        return Ok(());
    }
    crate::upnp::remove_mapping(port).await
}

/// Return the public WAN endpoint for embedding in invite links.
/// Requires that UPnP forwarding succeeded and public IP is known.
/// Returns `null` if either is unavailable.
#[cfg(not(mobile))]
#[tauri::command]
pub fn get_public_endpoint(
    state: State<AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let ext_port = state.upnp_external_port.load(Ordering::Relaxed);
    if ext_port == 0 {
        return Ok(None);
    }

    let public_ip = state.public_ip.lock().map_err(|e| e.to_string())?;
    match &*public_ip {
        Some(ip) => Ok(Some(serde_json::json!({
            "type": "direct",
            "addr": ip,
            "port": ext_port,
        }))),
        None => Ok(None),
    }
}

/// Store the public IP address discovered by the frontend (via STUN).
/// Called by the frontend after `detectNATType()` runs.
#[cfg(not(mobile))]
#[tauri::command]
pub fn set_public_ip(
    state: State<AppState>,
    ip: String,
) -> Result<(), String> {
    let mut guard = state.public_ip.lock().map_err(|e| e.to_string())?;
    *guard = Some(ip);
    Ok(())
}
```

- [ ] **Step 2: Register all new commands in `lib.rs`**

In the `invoke_handler![]` macro in `lib.rs`, add the four new commands:

```rust
upnp_forward_port,
upnp_remove_mapping,
get_public_endpoint,
set_public_ip,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Clean compile. The `lan::get_primary_local_ip()` function is already public.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/signal_commands.rs src-tauri/src/lib.rs
git commit -m "feat: add Tauri commands for UPnP port forwarding and public endpoint"
```

---

### Task 5: Integrate UPnP into Network Startup

**Files:**
- Modify: `src/stores/networkStore.ts`

- [ ] **Step 1: Call UPnP after LAN start and feed public IP from STUN**

In `networkStore.ts`, locate the `init()` function where `lan_start` is called. After the LAN start succeeds, add UPnP forwarding and public IP storage.

Find the block where `lan_start` returns successfully and add after it:

```typescript
// Attempt UPnP/NAT-PMP port forwarding for cross-network reachability
try {
  const extPort = await invoke<number>('upnp_forward_port')
  console.log(`[network] UPnP forwarded external port ${extPort}`)
} catch (e) {
  console.warn('[network] UPnP forwarding unavailable:', e)
}

// Store public IP from STUN for use in invite links
try {
  const { querySTUN } = await import('../utils/natDetection')
  const stunResult = await querySTUN('stun.l.google.com:19302')
  if (stunResult) {
    await invoke('set_public_ip', { ip: stunResult.ip })
    console.log(`[network] Public IP stored: ${stunResult.ip}`)
  }
} catch (e) {
  console.warn('[network] STUN public IP detection failed:', e)
}
```

- [ ] **Step 2: Clean up UPnP mapping on shutdown**

Find the cleanup/destroy function in `networkStore.ts` (or the `beforeunload` handler). Add:

```typescript
invoke('upnp_remove_mapping').catch(() => {})
```

If there is no explicit shutdown path, add a `window.addEventListener('beforeunload', ...)` in `init()`:

```typescript
window.addEventListener('beforeunload', () => {
  invoke('upnp_remove_mapping').catch(() => {})
})
```

- [ ] **Step 3: Verify frontend compiles**

Run: `npm run build`
Expected: `vue-tsc --noEmit` and Vite build succeed.

- [ ] **Step 4: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "feat: attempt UPnP port forwarding on network init"
```

---

### Task 6: Add Public Endpoint to Invite Links

**Files:**
- Modify: `src/components/modals/InviteModal.vue`

- [ ] **Step 1: Fetch and append the public endpoint**

In `InviteModal.vue`, find the `watch(() => uiStore.showInviteModal, ...)` handler where `lan_get_local_addrs` is called. After the LAN endpoints are resolved, add a call to `get_public_endpoint`:

```typescript
// Fetch public WAN endpoint (requires UPnP + STUN success)
try {
  const pub = await invoke<{ type: string; addr: string; port: number } | null>('get_public_endpoint')
  if (pub) {
    endpoints.value.push({ type: pub.type as PeerEndpoint['type'], addr: pub.addr, port: pub.port })
  }
} catch {
  // No public endpoint available — LAN-only invite
}
```

This appends the `"direct"` endpoint after the `"lan"` endpoints, so the join flow tries LAN first (fast), then internet (slower but works cross-network).

- [ ] **Step 2: Verify frontend compiles**

Run: `npm run build`
Expected: Clean build.

- [ ] **Step 3: Manual test plan**

1. Start the app on a machine behind a UPnP-capable router
2. Create a server and open the invite modal
3. Check the browser console for `[network] UPnP forwarded external port` and `[network] Public IP stored`
4. Copy the invite link and decode the base64 payload
5. Verify the `endpoints` array contains both a `"lan"` and a `"direct"` entry
6. Test the invite link from a device on a different network — it should connect via the `"direct"` endpoint

- [ ] **Step 4: Commit**

```bash
git add src/components/modals/InviteModal.vue
git commit -m "feat: include public WAN endpoint in invite links"
```

---

### Task 7: Update TODO.md

**Files:**
- Modify: `docs/TODO.md`

- [ ] **Step 1: Add UPnP completion checkboxes**

Under Phase 5c or Phase 6 (wherever NAT/connectivity items are tracked), add:

```markdown
- [x] UPnP/NAT-PMP port forwarding via `igd-next`
- [x] Public IP discovery via STUN, stored in AppState
- [x] WAN `"direct"` endpoint embedded in invite links
- [x] UPnP mapping cleanup on app shutdown
```

- [ ] **Step 2: Commit**

```bash
git add docs/TODO.md
git commit -m "docs: mark UPnP port forwarding tasks complete"
```

---

## Notes

- **UPnP availability:** Not all routers support UPnP IGD. Corporate networks, carrier-grade NAT (CGNAT), and some consumer routers have it disabled. The `forward_port` call failing is expected and gracefully handled — the invite link simply won't include a `"direct"` endpoint.
- **Security:** UPnP only forwards the specific signal port. The signal server already validates connections via userId. No new attack surface beyond what LAN already exposes.
- **Symmetric NAT:** Even with UPnP, symmetric NAT devices may not properly forward. The existing `detectNATType()` already identifies this — a future improvement could skip the UPnP attempt for symmetric NAT.
- **CGNAT:** If the STUN-detected public IP differs from the UPnP gateway's external IP, the user is behind CGNAT and the direct endpoint won't work. A future improvement could detect this and skip the endpoint.
- **Lease renewal:** `lease_duration = 0` means indefinite mapping. Some routers ignore this and expire mappings after ~30 min. A periodic renewal task could be added later if this becomes an issue.
