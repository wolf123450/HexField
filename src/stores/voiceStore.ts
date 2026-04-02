import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { VoiceSession, Peer } from '@/types/core'
import { audioService } from '@/services/audioService'
import { webrtcService } from '@/services/webrtcService'

// Warn in UI when voice channel has more than this many participants
const MESH_PEER_LIMIT = 8

export const useVoiceStore = defineStore('voice', () => {
  const session       = ref<VoiceSession | null>(null)
  const localStream   = ref<MediaStream | null>(null)
  const screenStream  = ref<MediaStream | null>(null)
  const isMuted       = ref<boolean>(false)
  const isDeafened    = ref<boolean>(false)
  const peers         = ref<Record<string, Peer>>({})
  const speakingPeers = ref<Set<string>>(new Set())

  const peerCount  = computed(() => Object.keys(peers.value).length)
  const meshWarning = computed(() => peerCount.value >= MESH_PEER_LIMIT)

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
    const deviceId = settingsStore.settings.inputDeviceId

    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)

    localStream.value = stream
    isMuted.value     = false
    isDeafened.value  = false
    audioService.setLocalStream(stream)
    audioService.setLocalMuted(false)
    audioService.setDeafened(false)

    // Add audio tracks to all existing WebRTC peer connections
    for (const track of stream.getAudioTracks()) {
      webrtcService.addAudioTrack(track, stream)
    }

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
  }

  async function leaveVoiceChannel(): Promise<void> {
    if (!session.value) return

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'voice_leave' })

    webrtcService.removeAudioTracks()
    webrtcService.removeScreenShareTrack()

    localStream.value?.getTracks().forEach(t => t.stop())
    screenStream.value?.getTracks().forEach(t => t.stop())
    audioService.detachAll()
    audioService.setLocalStream(null as unknown as MediaStream)

    localStream.value  = null
    screenStream.value = null
    session.value      = null
    peers.value        = {}
    isMuted.value      = false
    isDeafened.value   = false
    speakingPeers.value.clear()
  }

  // ── Mute / Deafen ─────────────────────────────────────────────────────────

  function toggleMute(): void {
    isMuted.value = !isMuted.value
    audioService.setLocalMuted(isMuted.value)
  }

  function toggleDeafen(): void {
    isDeafened.value = !isDeafened.value
    audioService.setDeafened(isDeafened.value)
    if (isDeafened.value && !isMuted.value) {
      isMuted.value = true
      audioService.setLocalMuted(true)
    } else if (!isDeafened.value) {
      isMuted.value = false
      audioService.setLocalMuted(false)
    }
  }

  // ── Screen share ──────────────────────────────────────────────────────────

  async function startScreenShare(): Promise<void> {
    let stream: MediaStream

    // On Windows/Linux try chromeMediaSourceId path; fall back to getDisplayMedia
    const isMacOS = navigator.platform.toLowerCase().includes('mac')

    if (!isMacOS) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const sources = await invoke<{ id: string; name: string; thumbnail: string }[]>('get_screen_sources')
        if (sources.length > 0) {
          const { useUIStore } = await import('./uiStore')
          const selected = await showScreenSourcePicker(sources, useUIStore())
          if (selected) {
            stream = await (navigator.mediaDevices as MediaDevices & {
              getUserMedia(c: object): Promise<MediaStream>
            }).getUserMedia({
              audio: false,
              video: {
                // @ts-ignore — Chromium-specific extension
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: selected,
                  maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
                },
              },
            })
          } else {
            return // User cancelled picker
          }
        } else {
          stream = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({ video: true, audio: false })
        }
      } catch {
        stream = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({ video: true, audio: false })
      }
    } else {
      stream = await (navigator.mediaDevices as MediaDevices).getDisplayMedia({ video: true, audio: false })
    }

    screenStream.value = stream
    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) {
      webrtcService.addScreenShareTrack(videoTrack)
      // Auto-stop when the user ends the share via browser UI
      videoTrack.onended = () => stopScreenShare()
    }

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({
      type:      'voice_screen_share_start',
      channelId: session.value?.channelId,
    })
  }

  function stopScreenShare(): void {
    if (!screenStream.value) return
    webrtcService.removeScreenShareTrack()
    screenStream.value.getTracks().forEach(t => t.stop())
    screenStream.value = null

    import('./networkStore').then(({ useNetworkStore }) => {
      useNetworkStore().broadcast({ type: 'voice_screen_share_stop' })
    })
  }

  // ── Peer management ───────────────────────────────────────────────────────

  function setPeerSpeaking(userId: string, speaking: boolean): void {
    if (speaking) speakingPeers.value.add(userId)
    else          speakingPeers.value.delete(userId)
    if (peers.value[userId]) peers.value[userId] = { ...peers.value[userId], speaking }
  }

  function updatePeer(userId: string, patch: Partial<Peer>): void {
    peers.value[userId] = { ...(peers.value[userId] ?? defaultPeer(userId)), ...patch }
  }

  function removePeer(userId: string): void {
    delete peers.value[userId]
    speakingPeers.value.delete(userId)
    audioService.detachRemoteStream(userId)
  }

  return {
    session,
    localStream,
    screenStream,
    isMuted,
    isDeafened,
    peers,
    speakingPeers,
    peerCount,
    meshWarning,
    joinVoiceChannel,
    leaveVoiceChannel,
    toggleMute,
    toggleDeafen,
    startScreenShare,
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

/** Minimal picker: returns the chosen source ID or null for cancellation. */
function showScreenSourcePicker(
  sources: { id: string; name: string; thumbnail: string }[],
  _uiStore: ReturnType<typeof import('./uiStore').useUIStore>,
): Promise<string | null> {
  return new Promise((resolve) => {
    // Very simple prompt-based picker. ScreenSharePicker.vue replaces this in Phase 6.
    const names = sources.map((s, i) => `${i + 1}: ${s.name}`).join('\n')
    const input = window.prompt(`Select screen source:\n${names}\n\nEnter number:`)
    if (!input) { resolve(null); return }
    const idx = parseInt(input, 10) - 1
    if (idx >= 0 && idx < sources.length) resolve(sources[idx].id)
    else resolve(null)
  })
}

