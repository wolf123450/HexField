import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { VoiceSession, Peer } from '@/types/core'
import { audioService } from '@/services/audioService'
import { webrtcService } from '@/services/webrtcService'

// Warn in UI when voice channel has more than this many participants
const MESH_PEER_LIMIT = 8

export const useVoiceStore = defineStore('voice', () => {
  const session         = ref<VoiceSession | null>(null)
  const localStream     = ref<MediaStream | null>(null)
  const screenShareActive = ref<boolean>(false)
  const screenFrameUrls   = ref<Record<string, string>>({}) // asset:// URLs per peer for screen frames
  const isMuted         = ref<boolean>(false)
  const isDeafened      = ref<boolean>(false)
  const adminMuted      = ref<boolean>(false)
  const loopbackEnabled = ref<boolean>(false)
  const voiceViewActive = ref<boolean>(false) // false = minimised → show text channel
  const peers              = ref<Record<string, Peer>>({})
  const speakingPeers      = ref<Set<string>>(new Set())
  // Tracks which voice channel each remote peer is currently in (even if we are not in the channel)
  const peerVoiceChannels  = ref<Record<string, string>>({})

  const peerCount     = computed(() => Object.keys(peers.value).length)
  const meshWarning   = computed(() => peerCount.value >= MESH_PEER_LIMIT)
  const hasScreenShares = computed(() =>
    screenShareActive.value || Object.keys(screenFrameUrls.value).length > 0
  )

  // Wire audioService VAD callbacks once on store creation
  audioService.init((userId, speaking) => setPeerSpeaking(userId, speaking))

  // ── Join / Leave ──────────────────────────────────────────────────────────

  async function joinVoiceChannel(channelId: string, serverId: string): Promise<void> {
    // Don't re-join if already in this channel
    if (session.value?.channelId === channelId) return

    // Leave current channel first if in one
    if (session.value) {
      await leaveVoiceChannel()
    }

    const { useSettingsStore } = await import('./settingsStore')
    const settingsStore = useSettingsStore()
    const deviceId = settingsStore.settings.inputDeviceId || undefined

    // Start mic capture in Rust — audio flows entirely in Rust
    // (cpal → Opus → WebRTC track). No MediaStream in JS.
    await webrtcService.addAudioTrack(deviceId)

    isMuted.value     = false
    isDeafened.value   = false
    adminMuted.value   = false

    voiceViewActive.value = true
    session.value = {
      channelId,
      serverId,
      joinedAt: new Date().toISOString(),
      peers: {},
    }

    // Announce to peers via data channel
    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({
      type:      'voice_join',
      channelId,
      serverId,
    })
    // Notify self: joined voice channel
    const { useNotificationStore } = await import('./notificationStore')
    const { useChannelsStore }     = await import('./channelsStore')
    const ch = Object.values(useChannelsStore().channels).flat().find(c => c.id === channelId)
    useNotificationStore().notify({
      type:      'join_self',
      serverId,
      channelId,
      titleText: `You joined ${ch?.name ? `#${ch.name}` : 'voice'}`,
    }).catch(() => {})
  }

  async function leaveVoiceChannel(): Promise<void> {
    if (!session.value) return

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'voice_leave' })

    await webrtcService.removeAudioTracks()
    await webrtcService.removeScreenShareTrack()

    localStream.value        = null
    screenShareActive.value  = false
    screenFrameUrls.value    = {}
    voiceViewActive.value    = false
    session.value         = null
    peers.value           = {}
    isMuted.value         = false
    isDeafened.value      = false
    adminMuted.value      = false
    loopbackEnabled.value = false
    speakingPeers.value   = new Set()
    // Don't wipe peerVoiceChannels on leave — peers may still be in voice
  }

  async function toggleMute(): Promise<void> {
    if (adminMuted.value) return  // Can't unmute while admin-muted
    isMuted.value = !isMuted.value
    await invoke('media_set_muted', { muted: isMuted.value })
  }

  function setAdminMuted(muted: boolean): void {
    adminMuted.value = muted
    if (muted) {
      isMuted.value = true
      invoke('media_set_muted', { muted: true }).catch(() => {})
    }
  }

  async function toggleDeafen(): Promise<void> {
    isDeafened.value = !isDeafened.value
    await invoke('media_set_deafened', { deafened: isDeafened.value })
    if (isDeafened.value && !isMuted.value) {
      isMuted.value = true
      await invoke('media_set_muted', { muted: true })
    } else if (!isDeafened.value) {
      isMuted.value = false
      await invoke('media_set_muted', { muted: false })
    }
  }

  async function toggleLoopback(): Promise<void> {
    loopbackEnabled.value = !loopbackEnabled.value
    await invoke('media_set_loopback', { enabled: loopbackEnabled.value })
  }

  // ── Screen share ──────────────────────────────────────────────────────────

  async function startScreenShare(): Promise<void> {
    const { useUIStore } = await import('./uiStore')
    const uiStore = useUIStore()

    // Open source picker and wait for user selection
    const sourceId = await uiStore.openSourcePicker()
    if (!sourceId) return // User cancelled

    const { useSettingsStore } = await import('./settingsStore')
    const settings = useSettingsStore().settings

    const bitrateMap: Record<string, number | undefined> = {
      'auto': undefined, '500kbps': 500, '1mbps': 1000, '2.5mbps': 2500, '5mbps': 5000,
    }
    const maxBitrateKbps = bitrateMap[settings.videoBitrate]

    await webrtcService.addScreenShareTrack(
      sourceId,
      settings.videoFrameRate,
      maxBitrateKbps,
    )

    screenShareActive.value = true

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({
      type:      'voice_screen_share_start',
      channelId: session.value?.channelId,
    })
  }

  async function stopScreenShare(): Promise<void> {
    if (!screenShareActive.value) return
    await webrtcService.removeScreenShareTrack()
    screenShareActive.value = false

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'voice_screen_share_stop' })
  }

  // ── Peer management ───────────────────────────────────────────────────────

  function setPeerSpeaking(userId: string, speaking: boolean): void {
    const next = new Set(speakingPeers.value)
    if (speaking) next.add(userId)
    else          next.delete(userId)
    speakingPeers.value = next
    if (peers.value[userId]) peers.value[userId] = { ...peers.value[userId], speaking }
  }

  function updatePeer(userId: string, patch: Partial<Peer>): void {
    peers.value[userId] = { ...(peers.value[userId] ?? defaultPeer(userId)), ...patch }
  }

  function removePeer(userId: string): void {
    delete peers.value[userId]
    delete screenFrameUrls.value[userId]
    const next = new Set(speakingPeers.value)
    next.delete(userId)
    speakingPeers.value = next
    audioService.detachRemoteStream(userId)
  }

  function setPeerVoiceChannel(userId: string, channelId: string): void {
    peerVoiceChannels.value[userId] = channelId
  }

  function clearPeerVoiceChannel(userId: string): void {
    delete peerVoiceChannels.value[userId]
  }

  return {
    session,
    localStream,
    screenShareActive,
    screenFrameUrls,
    isMuted,
    isDeafened,
    adminMuted,
    loopbackEnabled,
    voiceViewActive,
    peers,
    speakingPeers,
    peerVoiceChannels,
    peerCount,
    meshWarning,
    hasScreenShares,
    joinVoiceChannel,
    leaveVoiceChannel,
    toggleMute,
    toggleDeafen,
    toggleLoopback,
    setAdminMuted,
    startScreenShare,
    setPeerVoiceChannel,
    clearPeerVoiceChannel,
    stopScreenShare,
    setPeerSpeaking,
    updatePeer,
    removePeer,
  }
})

function defaultPeer(userId: string): Peer {
  return {
    userId,
    connectionState: 'new',
    audioEnabled: true,
    videoEnabled: false,
    screenSharing: false,
    speaking: false,
  }
}

