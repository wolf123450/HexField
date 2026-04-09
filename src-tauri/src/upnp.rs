use igd_next::{PortMappingProtocol, SearchOptions};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

/// Result of a UPnP port forwarding attempt.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PortMapping {
    pub external_port: u16,
    pub gateway_addr: SocketAddrV4,
}

/// Attempt to forward `internal_port` on `local_ip` via UPnP IGD.
///
/// Returns the external port on success, or an error string describing why
/// the mapping failed (no gateway, port in use, etc.).
pub async fn forward_port(local_ip: Ipv4Addr, internal_port: u16) -> Result<PortMapping, String> {
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
    let external_port = match gateway
        .add_port(
            PortMappingProtocol::TCP,
            internal_port,
            SocketAddr::V4(local_addr),
            lease_duration,
            description,
        )
        .await
    {
        Ok(()) => internal_port,
        Err(_) => {
            // Same-port failed (already taken) — let the router pick any port
            gateway
                .add_any_port(
                    PortMappingProtocol::TCP,
                    SocketAddr::V4(local_addr),
                    lease_duration,
                    description,
                )
                .await
                .map_err(|e| format!("UPnP port mapping failed: {e}"))?
        }
    };

    let gw_addr = match gateway.addr {
        SocketAddr::V4(v4) => v4,
        SocketAddr::V6(_) => return Err("IPv6 gateway not supported".to_string()),
    };

    log::info!(
        "UPnP: mapped external port {} -> {}:{} via gateway {}",
        external_port,
        local_ip,
        internal_port,
        gw_addr
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
