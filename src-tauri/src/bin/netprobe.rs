//! hexfield-netprobe — headless driver for HexField's networking stack.
//!
//! Runs the app's real `lan` signaling and `webrtc_manager` code with no
//! WebView, so connectivity can be tested on servers and in the NAT lab
//! (`scripts/netlab/`). Signals are routed the way `networkStore.ts` routes
//! them: `webrtc_offer/answer/ice` events go out over the LAN WebSocket as
//! `signal_offer/answer/ice`, and incoming `signal_message` events are fed
//! back into the WebRTC manager.
//!
//! Host (waits for a peer):
//!   hexfield-netprobe --id host --listen-port 7800 [--timeout-secs 120]
//! Joiner (mirrors JoinView: dial the host's signal endpoint, then offer):
//!   hexfield-netprobe --id joiner --connect 10.0.1.2:7800 --peer host --pings 20
//!
//! The joiner prints one JSON result line on stdout and exits 0 when the data
//! channel opened and every ping was echoed, 1 otherwise.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hexfield_lib::event_sink::SharedSink;
use hexfield_lib::lan::{self, LanPeers};
use hexfield_lib::media_manager::MediaManager;
use hexfield_lib::webrtc_manager::WebRTCManager;
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;

const USAGE: &str = "\
Usage: hexfield-netprobe --id <userId> [options]

  --listen-port <port>   Run the LAN signal server on this port (host role)
  --connect <addr:port>  Dial a host's signal server (joiner role; needs --peer)
  --peer <userId>        The host's userId
  --ice <url>            ICE server URL, repeatable (stun:… / turn:…). Default: Google STUN
  --turn-user <user>     Username for turn: URLs
  --turn-pass <pass>     Credential for turn: URLs
  --relay-only           Only use TURN relay candidates (needs a turn: --ice URL)
  --expect-type <t>      Joiner: fail unless the connection type is lan|direct|relay
  --pings <n>            Data-channel echo round trips after connecting (default 10)
  --ping-timeout-secs <n> Joiner: wait up to n s for each echo (default 5). A long
                         value lets a stalled data channel recover (watchdog
                         reconnect) inside the echo stage
  --ping-interval-ms <n> Joiner: pause n ms between echoes (default 0), to spread
                         the echo stage over a longer time
  --timeout-secs <n>     Joiner: give up connecting after n s (default 30).
                         Host: exit after n s (default 0 = run until killed)
  --no-relay-retry       Do not re-offer relay-only when the first attempt stalls
                         (shows the raw outcome of mixed candidate sets)
  --verbose              Debug logging to stderr
  --debug-deps           Also debug-log dependency crates (webrtc-rs ICE/TURN)
  --trace-deps           Also trace-log dependency crates (every ICE check)";

struct Args {
    id: String,
    listen_port: Option<u16>,
    connect: Option<(String, u16)>,
    peer: Option<String>,
    ice: Vec<String>,
    turn_user: String,
    turn_pass: String,
    pings: u32,
    ping_timeout_secs: u64,
    ping_interval_ms: u64,
    timeout_secs: Option<u64>,
    relay_only: bool,
    expect_type: Option<String>,
    no_relay_retry: bool,
    verbose: bool,
    debug_deps: bool,
    trace_deps: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        id: String::new(),
        listen_port: None,
        connect: None,
        peer: None,
        ice: Vec::new(),
        turn_user: String::new(),
        turn_pass: String::new(),
        pings: 10,
        ping_timeout_secs: 5,
        ping_interval_ms: 0,
        timeout_secs: None,
        relay_only: false,
        expect_type: None,
        no_relay_retry: false,
        verbose: false,
        debug_deps: false,
        trace_deps: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--id" => args.id = value("--id")?,
            "--listen-port" => {
                args.listen_port = Some(value("--listen-port")?.parse().map_err(|e| format!("--listen-port: {e}"))?)
            }
            "--connect" => {
                let v = value("--connect")?;
                let (addr, port) = v.rsplit_once(':').ok_or("--connect expects addr:port")?;
                let port = port.parse().map_err(|e| format!("--connect port: {e}"))?;
                args.connect = Some((addr.to_string(), port));
            }
            "--peer" => args.peer = Some(value("--peer")?),
            "--ice" => args.ice.push(value("--ice")?),
            "--turn-user" => args.turn_user = value("--turn-user")?,
            "--turn-pass" => args.turn_pass = value("--turn-pass")?,
            "--pings" => args.pings = value("--pings")?.parse().map_err(|e| format!("--pings: {e}"))?,
            "--ping-timeout-secs" => {
                args.ping_timeout_secs =
                    value("--ping-timeout-secs")?.parse().map_err(|e| format!("--ping-timeout-secs: {e}"))?
            }
            "--ping-interval-ms" => {
                args.ping_interval_ms =
                    value("--ping-interval-ms")?.parse().map_err(|e| format!("--ping-interval-ms: {e}"))?
            }
            "--timeout-secs" => {
                args.timeout_secs = Some(value("--timeout-secs")?.parse().map_err(|e| format!("--timeout-secs: {e}"))?)
            }
            "--relay-only" => args.relay_only = true,
            "--expect-type" => {
                let t = value("--expect-type")?;
                if !matches!(t.as_str(), "lan" | "direct" | "relay") {
                    return Err(format!("--expect-type must be lan, direct or relay, not {t}"));
                }
                args.expect_type = Some(t);
            }
            "--no-relay-retry" => args.no_relay_retry = true,
            "--verbose" => args.verbose = true,
            "--debug-deps" => {
                args.verbose = true;
                args.debug_deps = true;
            }
            "--trace-deps" => {
                args.verbose = true;
                args.debug_deps = true;
                args.trace_deps = true;
            }
            "-h" | "--help" => return Err(String::new()),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if args.id.is_empty() {
        return Err("--id is required".into());
    }
    if args.connect.is_some() != args.peer.is_some() {
        return Err("--connect and --peer must be given together".into());
    }
    if args.connect.is_none() && args.listen_port.is_none() {
        return Err("give --listen-port (host) or --connect/--peer (joiner)".into());
    }
    Ok(args)
}

fn ice_servers(args: &Args) -> Vec<RTCIceServer> {
    args.ice
        .iter()
        .map(|url| {
            let is_turn = url.starts_with("turn:") || url.starts_with("turns:");
            RTCIceServer {
                urls: vec![url.clone()],
                username: if is_turn { args.turn_user.clone() } else { String::new() },
                credential: if is_turn { args.turn_pass.clone() } else { String::new() },
            }
        })
        .collect()
}

// ── Logging ─────────────────────────────────────────────────────────────────

/// HexField logs at the chosen level; dependency crates (webrtc-rs is very
/// chatty about unusable interfaces) only at error, or warn with --verbose.
struct StderrLogger;
static LOGGER: StderrLogger = StderrLogger;
static VERBOSE: AtomicBool = AtomicBool::new(false);
static DEBUG_DEPS: AtomicBool = AtomicBool::new(false);
static TRACE_DEPS: AtomicBool = AtomicBool::new(false);

impl log::Log for StderrLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        let dep_level = if TRACE_DEPS.load(Ordering::Relaxed) {
            log::Level::Trace
        } else if DEBUG_DEPS.load(Ordering::Relaxed) {
            log::Level::Debug
        } else if VERBOSE.load(Ordering::Relaxed) {
            log::Level::Warn
        } else {
            log::Level::Error
        };
        m.target().starts_with("hexfield") || m.level() <= dep_level
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{:5}] {}: {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

// ── Probe ───────────────────────────────────────────────────────────────────

/// Events the role loops care about, after signaling has been routed.
enum ProbeEvent {
    Connected(String),
    Disconnected(String),
    Pong(u64),
}

struct Probe {
    id: String,
    mgr: Arc<WebRTCManager>,
    media: Arc<MediaManager>,
    sink: SharedSink,
    lan_peers: Arc<LanPeers>,
    events: UnboundedReceiver<(String, Value)>,
    /// Set when the manager fell back to a relay-only re-offer.
    relay_retried: bool,
}

impl Probe {
    async fn send_lan(&self, to: &str, msg: Value) {
        log::debug!("[netprobe] → {to}: {} {}", msg["type"], msg["candidate"]["candidate"]);
        let peers = self.lan_peers.lock().await;
        match peers.get(to) {
            Some((_, tx)) => {
                if tx.send(msg).is_err() {
                    log::warn!("[netprobe] LAN sender for {to} closed");
                }
            }
            None => log::warn!("[netprobe] no LAN route to {to}; signal dropped"),
        }
    }

    /// Route one event from the networking layer. Returns the events the role
    /// loops react to; everything else is handled here.
    async fn route(&mut self, name: &str, p: Value) -> Option<ProbeEvent> {
        let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        match name {
            "webrtc_offer" | "webrtc_answer" => {
                let kind = if name == "webrtc_offer" { "signal_offer" } else { "signal_answer" };
                let to = s("to");
                let relay_only = p.get("relayOnly").and_then(Value::as_bool).unwrap_or(false);
                let msg = json!({ "type": kind, "to": to, "from": self.id, "sdp": s("sdp"), "relayOnly": relay_only });
                self.send_lan(&to, msg).await;
            }
            "webrtc_ice" => {
                let to = s("to");
                let msg = json!({
                    "type": "signal_ice", "to": to, "from": self.id,
                    "candidate": {
                        "candidate": s("candidate"),
                        "sdpMid": p.get("sdpMid"),
                        "sdpMLineIndex": p.get("sdpMlineIndex"),
                    },
                });
                self.send_lan(&to, msg).await;
            }
            "signal_message" => {
                let from = s("from");
                log::debug!("[netprobe] ← {from}: {}", p["type"]);
                let result = match p.get("type").and_then(Value::as_str) {
                    Some("signal_offer") => {
                        let relay_only = p.get("relayOnly").and_then(Value::as_bool).unwrap_or(false);
                        self.mgr.handle_offer(&from, s("sdp"), relay_only, &self.media, &self.sink).await
                    }
                    Some("signal_answer") => self.mgr.handle_answer(&from, s("sdp")).await,
                    Some("signal_ice") => {
                        let c = p.get("candidate").cloned().unwrap_or_default();
                        let init = RTCIceCandidateInit {
                            candidate: c.get("candidate").and_then(Value::as_str).unwrap_or_default().to_string(),
                            sdp_mid: c.get("sdpMid").and_then(Value::as_str).map(str::to_string),
                            sdp_mline_index: c.get("sdpMLineIndex").and_then(Value::as_u64).map(|i| i as u16),
                            username_fragment: None,
                        };
                        self.mgr.add_ice_candidate(&from, init).await
                    }
                    other => {
                        log::debug!("[netprobe] ignoring signal {other:?} from {from}");
                        Ok(())
                    }
                };
                if let Err(e) = result {
                    log::warn!("[netprobe] signal from {from} failed: {e}");
                }
            }
            "webrtc_relay_retry" => {
                log::info!("[netprobe] {} not connected yet, relay-only retry", s("userId"));
                self.relay_retried = true;
            }
            "webrtc_connected" => return Some(ProbeEvent::Connected(s("userId"))),
            "webrtc_disconnected" => return Some(ProbeEvent::Disconnected(s("userId"))),
            "webrtc_data" => {
                let from = s("from");
                let msg: Value = serde_json::from_str(&s("payload")).unwrap_or_default();
                match msg.get("type").and_then(Value::as_str) {
                    Some("probe_ping") => {
                        let pong = json!({ "type": "probe_pong", "seq": msg["seq"] });
                        if let Err(e) = self.mgr.send(&from, pong.to_string()).await {
                            log::warn!("[netprobe] pong to {from} failed: {e}");
                        }
                    }
                    Some("probe_pong") => return msg["seq"].as_u64().map(ProbeEvent::Pong),
                    _ => {}
                }
            }
            other => log::debug!("[netprobe] event {other}: {p}"),
        }
        None
    }

    /// Wait for the next event the role loop cares about, until `deadline`.
    async fn next(&mut self, deadline: Instant) -> Option<ProbeEvent> {
        loop {
            let (name, payload) =
                tokio::time::timeout_at(deadline.into(), self.events.recv()).await.ok()??;
            if let Some(ev) = self.route(&name, payload).await {
                return Some(ev);
            }
        }
    }
}

async fn run_host(mut probe: Probe, timeout: Option<Duration>) -> i32 {
    // Year-long deadline stands in for "run until killed".
    let deadline = Instant::now() + timeout.unwrap_or(Duration::from_secs(365 * 24 * 3600));
    while Instant::now() < deadline {
        match probe.next(deadline).await {
            Some(ProbeEvent::Connected(peer)) => {
                let types = probe.mgr.selected_candidate_types(&peer).await;
                let connection_type = probe.mgr.connection_type(&peer).await.map(|t| t.as_str());
                println!(
                    "{}",
                    json!({ "event": "connected", "peer": peer, "candidates": types, "connection_type": connection_type })
                );
            }
            Some(ProbeEvent::Disconnected(peer)) => {
                println!("{}", json!({ "event": "disconnected", "peer": peer }));
            }
            Some(ProbeEvent::Pong(_)) => {}
            None => break,
        }
    }
    0
}

/// Echo-stage bookkeeping for the joiner.
#[derive(Default)]
struct EchoStats {
    rtts: Vec<f64>,
    sent: HashMap<u64, Instant>,
    /// Reconnects during the echo stage (the stall watchdog in webrtc_manager).
    reconnects: u32,
}

impl EchoStats {
    /// Record one event; returns the sequence number of a pong.
    fn record(&mut self, ev: ProbeEvent, peer: &str) -> Option<u64> {
        match ev {
            ProbeEvent::Pong(n) => {
                if let Some(t) = self.sent.remove(&n) {
                    self.rtts.push(t.elapsed().as_secs_f64() * 1000.0);
                }
                Some(n)
            }
            ProbeEvent::Connected(p) if p == peer => {
                self.reconnects += 1;
                None
            }
            _ => None,
        }
    }
}

async fn run_joiner(
    mut probe: Probe,
    addr: String,
    port: u16,
    peer: String,
    pings: u32,
    ping_timeout: Duration,
    ping_interval: Duration,
    timeout: Duration,
    expect_type: Option<String>,
) -> i32 {
    let started = Instant::now();
    let deadline = started + timeout;
    let mut result = json!({ "ok": false, "peer": peer, "endpoint": format!("{addr}:{port}") });

    // 1. Signaling: the same direct dial JoinView does via lan_connect_peer.
    let dial = lan::connect_to_lan_peer(
        peer.clone(), addr, port, probe.id.clone(), probe.lan_peers.clone(), probe.sink.clone(),
    );
    if let Err(e) = tokio::time::timeout_at(deadline.into(), dial).await.unwrap_or(Err("timed out".into())) {
        result["stage"] = json!("signal");
        result["error"] = json!(e);
        println!("{result}");
        return 1;
    }
    // connect_to_lan_peer registers the route from a spawned task.
    while !probe.lan_peers.lock().await.contains_key(&peer) {
        if Instant::now() >= deadline {
            result["stage"] = json!("signal");
            result["error"] = json!("LAN route never registered");
            println!("{result}");
            return 1;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    result["signal_ms"] = json!(started.elapsed().as_millis() as u64);

    // 2. ICE + DTLS + SCTP: offer and wait for the data channel to open.
    if let Err(e) = probe.mgr.create_offer(&peer, &probe.media, &probe.sink).await {
        result["stage"] = json!("offer");
        result["error"] = json!(e);
        println!("{result}");
        return 1;
    }
    loop {
        match probe.next(deadline).await {
            Some(ProbeEvent::Connected(p)) if p == peer => break,
            Some(ProbeEvent::Disconnected(p)) if p == peer => {
                result["stage"] = json!("ice");
                result["error"] = json!("peer connection failed");
                println!("{result}");
                return 1;
            }
            Some(_) => {}
            None => {
                // A selected candidate pair means ICE succeeded and the
                // DTLS/SCTP layers above it never opened the data channel.
                match probe.mgr.selected_candidate_types(&peer).await {
                    Some((local, remote)) => {
                        result["stage"] = json!("sctp");
                        result["local_candidate"] = json!(local);
                        result["remote_candidate"] = json!(remote);
                    }
                    None => result["stage"] = json!("ice"),
                }
                result["error"] = json!("timed out waiting for data channel");
                println!("{result}");
                return 1;
            }
        }
    }
    result["connect_ms"] = json!(started.elapsed().as_millis() as u64);
    result["relay_retry"] = json!(probe.relay_retried);
    let connection_type = probe.mgr.connection_type(&peer).await.map(|t| t.as_str());
    result["connection_type"] = json!(connection_type);
    result["media_allowed"] = json!(probe.mgr.media_allowed(&peer).await);
    if let Some((local, remote)) = probe.mgr.selected_candidate_types(&peer).await {
        result["local_candidate"] = json!(local);
        result["remote_candidate"] = json!(remote);
    }

    // 3. Data-channel echo round trips.
    let mut echo = EchoStats::default();
    for seq in 0..pings as u64 {
        if seq > 0 && !ping_interval.is_zero() {
            // Keep routing events (late pongs, reconnects) while pausing.
            let pause_end = Instant::now() + ping_interval;
            while let Some(ev) = probe.next(pause_end).await {
                echo.record(ev, &peer);
            }
        }
        let ping = json!({ "type": "probe_ping", "seq": seq });
        echo.sent.insert(seq, Instant::now());
        if let Err(e) = probe.mgr.send(&peer, ping.to_string()).await {
            log::warn!("[netprobe] ping {seq} failed: {e}");
            continue;
        }
        let ping_deadline = Instant::now() + ping_timeout;
        while let Some(ev) = probe.next(ping_deadline).await {
            if echo.record(ev, &peer) == Some(seq) {
                break;
            }
        }
    }
    let EchoStats { rtts, reconnects, .. } = echo;
    result["pings"] = json!(pings);
    result["pongs"] = json!(rtts.len());
    result["reconnects"] = json!(reconnects);
    if !rtts.is_empty() {
        let avg = rtts.iter().sum::<f64>() / rtts.len() as f64;
        let max = rtts.iter().cloned().fold(0.0, f64::max);
        result["rtt_ms_avg"] = json!((avg * 10.0).round() / 10.0);
        result["rtt_ms_max"] = json!((max * 10.0).round() / 10.0);
    }
    let echoes_ok = rtts.len() == pings as usize;
    let type_ok = expect_type.as_deref().map_or(true, |t| connection_type == Some(t));
    let ok = echoes_ok && type_ok;
    result["ok"] = json!(ok);
    result["stage"] = json!(if !echoes_ok { "echo" } else if !type_ok { "type" } else { "done" });
    println!("{result}");
    let _ = probe.mgr.destroy_all().await;
    if ok { 0 } else { 1 }
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("error: {e}\n");
            }
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };

    // Same crypto-provider pin as the app (see lib.rs / Known Pitfalls).
    let _ = rustls::crypto::ring::default_provider().install_default();

    VERBOSE.store(args.verbose, Ordering::Relaxed);
    DEBUG_DEPS.store(args.debug_deps, Ordering::Relaxed);
    TRACE_DEPS.store(args.trace_deps, Ordering::Relaxed);
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(if args.trace_deps {
        log::LevelFilter::Trace
    } else if args.verbose {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });

    let (tx, rx) = unbounded_channel::<(String, Value)>();
    let sink: SharedSink = Arc::new(tx);
    let mgr = Arc::new(WebRTCManager::new());
    mgr.set_local_user_id(args.id.clone());
    if !args.ice.is_empty() {
        mgr.set_ice_servers(ice_servers(&args));
    }
    mgr.set_relay_only(args.relay_only);
    mgr.set_relay_retry(!args.no_relay_retry);
    let lan_peers: Arc<LanPeers> = Arc::new(Default::default());

    if let Some(port) = args.listen_port {
        match lan::start_lan_server(sink.clone(), lan_peers.clone(), port).await {
            Ok(bound) => println!("{}", json!({ "event": "listening", "id": args.id, "port": bound })),
            Err(e) => {
                eprintln!("error: {e}");
                std::process::exit(1);
            }
        }
    }

    let probe = Probe {
        id: args.id.clone(),
        mgr,
        media: Arc::new(MediaManager::new()),
        sink,
        lan_peers,
        events: rx,
        relay_retried: false,
    };

    let code = match (args.connect, args.peer) {
        (Some((addr, port)), Some(peer)) => {
            let timeout = Duration::from_secs(args.timeout_secs.unwrap_or(30));
            let ping_timeout = Duration::from_secs(args.ping_timeout_secs);
            let ping_interval = Duration::from_millis(args.ping_interval_ms);
            run_joiner(probe, addr, port, peer, args.pings, ping_timeout, ping_interval, timeout, args.expect_type).await
        }
        _ => run_host(probe, args.timeout_secs.map(Duration::from_secs)).await,
    };
    std::process::exit(code);
}
