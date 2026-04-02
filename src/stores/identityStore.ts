import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import { cryptoService } from '@/services/cryptoService'

export const useIdentityStore = defineStore('identity', () => {
  const userId        = ref<string | null>(null)
  const displayName   = ref<string>('')
  const publicSignKey = ref<string | null>(null)
  const publicDHKey   = ref<string | null>(null)
  const avatarDataUrl = ref<string | null>(null)
  const isRegistered  = ref<boolean>(false)

  async function initializeIdentity() {
    await cryptoService.init()

    // Try to load existing keys from SQLite
    const existingSignKey = await invoke<string | null>('db_load_key', { keyId: 'local_sign_secret' })
    const existingDHKey   = await invoke<string | null>('db_load_key', { keyId: 'local_dh_secret' })
    const existingUserId  = await invoke<string | null>('db_load_key', { keyId: 'local_user_id' })
    const existingName    = await invoke<string | null>('db_load_key', { keyId: 'local_display_name' })

    if (existingSignKey && existingDHKey && existingUserId) {
      // Load existing identity
      await cryptoService.loadKeys(existingSignKey, existingDHKey)
      userId.value        = existingUserId
      displayName.value   = existingName ?? 'Anonymous'
      publicSignKey.value = cryptoService.getPublicSignKey()
      publicDHKey.value   = cryptoService.getPublicDHKey()
      isRegistered.value  = true
    } else {
      // First launch — generate new identity
      const newUserId = uuidv7()
      const keys = await cryptoService.generateKeys()

      // Persist to SQLite key store
      await invoke('db_save_key', { keyId: 'local_sign_secret', keyType: 'sign_secret', keyData: keys.signSecret })
      await invoke('db_save_key', { keyId: 'local_dh_secret',   keyType: 'dh_secret',  keyData: keys.dhSecret })
      await invoke('db_save_key', { keyId: 'local_user_id',     keyType: 'user_id',    keyData: newUserId })
      await invoke('db_save_key', { keyId: 'local_display_name', keyType: 'display_name', keyData: 'Player' })

      userId.value        = newUserId
      displayName.value   = 'Player'
      publicSignKey.value = cryptoService.getPublicSignKey()
      publicDHKey.value   = cryptoService.getPublicDHKey()
      isRegistered.value  = true
    }

    // Initialise per-device keypair (separate from identity keypair)
    const { useDevicesStore } = await import('./devicesStore')
    await useDevicesStore().initDeviceIdentity(userId.value!)
  }

  async function updateDisplayName(name: string) {
    displayName.value = name
    await invoke('db_save_key', { keyId: 'local_display_name', keyType: 'display_name', keyData: name })
  }

  function updateAvatar(dataUrl: string) {
    avatarDataUrl.value = dataUrl
  }

  return {
    userId,
    displayName,
    publicSignKey,
    publicDHKey,
    avatarDataUrl,
    isRegistered,
    initializeIdentity,
    updateDisplayName,
    updateAvatar,
  }
})
