import { defineStore } from 'pinia'
import { ref } from 'vue'

export type SignalingState = 'disconnected' | 'connecting' | 'connected' | 'error'

export const useNetworkStore = defineStore('network', () => {
  const signalingState   = ref<SignalingState>('disconnected')
  const serverUrl        = ref<string>('')
  const reconnectAttempt = ref<number>(0)
  const natType          = ref<'open' | 'restricted' | 'symmetric' | 'unknown'>('unknown')

  function handleIncomingSignal(payload: any) {
    // Dispatched to webrtcService or messagesStore based on type
    // Implemented fully in Phase 3
    console.debug('[networkStore] incoming signal', payload?.type)
  }

  return {
    signalingState,
    serverUrl,
    reconnectAttempt,
    natType,
    handleIncomingSignal,
  }
})
