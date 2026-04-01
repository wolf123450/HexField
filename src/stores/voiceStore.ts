import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { VoiceSession, Peer } from '@/types/core'

export const useVoiceStore = defineStore('voice', () => {
  const session       = ref<VoiceSession | null>(null)
  const localStream   = ref<MediaStream | null>(null)
  const screenStream  = ref<MediaStream | null>(null)
  const isMuted       = ref<boolean>(false)
  const isDeafened    = ref<boolean>(false)
  const peers         = ref<Record<string, Peer>>({})
  const speakingPeers = ref<Set<string>>(new Set())

  async function joinVoiceChannel(channelId: string, serverId: string) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    localStream.value = stream
    session.value = {
      channelId,
      serverId,
      joinedAt: new Date().toISOString(),
      peers: {},
    }
  }

  function leaveVoiceChannel() {
    localStream.value?.getTracks().forEach(t => t.stop())
    screenStream.value?.getTracks().forEach(t => t.stop())
    localStream.value  = null
    screenStream.value = null
    session.value      = null
    peers.value        = {}
    speakingPeers.value.clear()
  }

  function toggleMute() {
    isMuted.value = !isMuted.value
    localStream.value?.getAudioTracks().forEach(t => {
      t.enabled = !isMuted.value
    })
  }

  function toggleDeafen() {
    isDeafened.value = !isDeafened.value
    if (isDeafened.value && !isMuted.value) toggleMute()
  }

  async function startScreenShare() {
    const stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false })
    screenStream.value = stream
  }

  function stopScreenShare() {
    screenStream.value?.getTracks().forEach(t => t.stop())
    screenStream.value = null
  }

  function setPeerSpeaking(userId: string, speaking: boolean) {
    if (speaking) speakingPeers.value.add(userId)
    else speakingPeers.value.delete(userId)
    if (peers.value[userId]) peers.value[userId] = { ...peers.value[userId], speaking }
  }

  function updatePeer(userId: string, patch: Partial<Peer>) {
    peers.value[userId] = { ...(peers.value[userId] ?? defaultPeer(userId)), ...patch }
  }

  return {
    session,
    localStream,
    screenStream,
    isMuted,
    isDeafened,
    peers,
    speakingPeers,
    joinVoiceChannel,
    leaveVoiceChannel,
    toggleMute,
    toggleDeafen,
    startScreenShare,
    stopScreenShare,
    setPeerSpeaking,
    updatePeer,
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
