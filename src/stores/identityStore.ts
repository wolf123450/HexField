import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import { cryptoService } from '@/services/cryptoService'

export const useIdentityStore = defineStore('identity', () => {
  const userId            = ref<string | null>(null)
  const displayName       = ref<string>('')
  const publicSignKey     = ref<string | null>(null)
  const publicDHKey       = ref<string | null>(null)
  const avatarDataUrl     = ref<string | null>(null)
  const avatarHash        = ref<string | null>(null)
  const bio               = ref<string | null>(null)
  const bannerColor       = ref<string | null>(null)
  const bannerDataUrl     = ref<string | null>(null)
  const bannerHash        = ref<string | null>(null)
  const isRegistered      = ref<boolean>(false)
  /** True when the identity keys are stored passphrase-wrapped (Phase 2 crypto tier). */
  const passphraseProtected = ref<boolean>(false)
  /** True when the identity keys are stored in the OS-native keychain (Phase 3 crypto tier). */
  const keychainProtected   = ref<boolean>(false)

  async function initializeIdentity() {
    await cryptoService.init()

    // Try to load existing keys from SQLite
    const existingSignKey  = await invoke<string | null>('db_load_key', { keyId: 'local_sign_secret' })
    const existingDHKey    = await invoke<string | null>('db_load_key', { keyId: 'local_dh_secret' })
    const existingUserId   = await invoke<string | null>('db_load_key', { keyId: 'local_user_id' })
    const existingName     = await invoke<string | null>('db_load_key', { keyId: 'local_display_name' })
    const existingAvatar   = await invoke<string | null>('db_load_key', { keyId: 'local_avatar_data' })

    if (existingSignKey && existingDHKey && existingUserId) {
      // Detect the active key storage tier.
      // Tier 3 — OS keychain: sentinel value '__keychain__'
      if (existingSignKey === '__keychain__') {
        const signSecret = await invoke<string | null>('keychain_load', { service: 'hexfield', account: 'identity_sign_secret' })
        const dhSecret   = await invoke<string | null>('keychain_load', { service: 'hexfield', account: 'identity_dh_secret' })
        if (signSecret && dhSecret) {
          await cryptoService.loadKeys(signSecret, dhSecret)
          keychainProtected.value = true
        }
        // If keychain load fails (key deleted by OS), fall through with no keys loaded —
        // the caller can handle the locked state.
      } else {
        // Detect whether keys are passphrase-wrapped (version 2).
        // A wrapped bundle is stored as a JSON string with { version: 2, ... }.
        let isWrapped = false
        try {
          const maybeJson = JSON.parse(existingSignKey)
          if (maybeJson && maybeJson.version === 2) isWrapped = true
        } catch { /* raw base64 key — not wrapped */ }

        if (isWrapped) {
          // Keys are wrapped — leave keys null in memory; caller must call
          // unlockWithPassphrase() before the identity is fully usable.
          passphraseProtected.value = true
        } else {
          // Load existing raw keys
          await cryptoService.loadKeys(existingSignKey, existingDHKey)
          passphraseProtected.value = false
        }
      }

      userId.value        = existingUserId
      displayName.value   = existingName ?? 'Anonymous'
      if (!passphraseProtected.value || keychainProtected.value) {
        publicSignKey.value = cryptoService.getPublicSignKey()
        publicDHKey.value   = cryptoService.getPublicDHKey()
      }
      if (existingAvatar) avatarDataUrl.value = existingAvatar

      const existingAvatarHash = await invoke<string | null>('db_load_key', { keyId: 'local_avatar_hash' })
        .catch(() => null)
      if (existingAvatarHash) avatarHash.value = existingAvatarHash

      const existingBannerHash = await invoke<string | null>('db_load_key', { keyId: 'local_banner_hash' })
        .catch(() => null)
      if (existingBannerHash) bannerHash.value = existingBannerHash

      bio.value         = await invoke<string | null>('db_load_key', { keyId: 'local_bio' })
      bannerColor.value = await invoke<string | null>('db_load_key', { keyId: 'local_banner_color' })
      bannerDataUrl.value = await invoke<string | null>('db_load_key', { keyId: 'local_banner_data' })
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

    // Initialise personal blocks/mutes (localStorage-backed, keyed by userId)
    const { usePersonalBlocksStore } = await import('./personalBlocksStore')
    usePersonalBlocksStore().init(userId.value!)

    // One-time migration: convert existing data URL images to disk files
    try {
      const migrated = await invoke<number>('migrate_data_urls_to_files')
      if (migrated > 0) {
        console.log(`[identity] migrated ${migrated} data URL images to disk`)
        // Reload hashes after migration
        const newAvatarHash = await invoke<string | null>('db_load_key', { keyId: 'local_avatar_hash' })
          .catch(() => null)
        if (newAvatarHash) avatarHash.value = newAvatarHash
      }
    } catch (e) {
      console.warn('[identity] data URL migration failed:', e)
    }
  }

  async function updateDisplayName(name: string) {
    displayName.value = name
    await invoke('db_save_key', { keyId: 'local_display_name', keyType: 'display_name', keyData: name })
  }

  function updateAvatar(dataUrl: string) {
    avatarDataUrl.value = dataUrl
  }

  async function updateAvatarHash(hash: string) {
    avatarHash.value = hash
    avatarDataUrl.value = null
    await invoke('db_save_key', { keyId: 'local_avatar_hash', keyType: 'avatar_hash', keyData: hash })
  }

  async function updateBannerHash(hash: string | null) {
    bannerHash.value = hash
    bannerDataUrl.value = null
    if (hash) {
      await invoke('db_save_key', { keyId: 'local_banner_hash', keyType: 'banner_hash', keyData: hash })
    }
  }

  async function updateBio(text: string) {
    bio.value = text
    await invoke('db_save_key', { keyId: 'local_bio', keyType: 'bio', keyData: text })
  }

  async function updateBanner(color: string | null, dataUrl: string | null) {
    bannerColor.value   = color
    bannerDataUrl.value = dataUrl
    if (color !== null) {
      await invoke('db_save_key', { keyId: 'local_banner_color', keyType: 'banner_color', keyData: color })
    }
    if (dataUrl !== null) {
      await invoke('db_save_key', { keyId: 'local_banner_data', keyType: 'banner_data', keyData: dataUrl })
    }
  }

  /**
   * Build a portable identity bundle (plain JSON, no passphrase).
   * The caller is responsible for prompting the user to save the file securely.
   */
  async function exportIdentity(): Promise<string> {
    const signSecret = await invoke<string | null>('db_load_key', { keyId: 'local_sign_secret' })
    const dhSecret   = await invoke<string | null>('db_load_key', { keyId: 'local_dh_secret' })
    if (!signSecret || !dhSecret || !userId.value) {
      throw new Error('Identity not initialised — cannot export.')
    }
    return JSON.stringify({
      v:            1,
      userId:       userId.value,
      displayName:  displayName.value,
      signSecret,
      dhSecret,
      exportedAt:   new Date().toISOString(),
    }, null, 2)
  }

  /**
   * Restore identity from a previously exported bundle.
   * Overwrites current keys in SQLite and restores in-memory state.
   * The app should reload after this (caller's responsibility).
   */
  async function importIdentity(bundleJson: string): Promise<void> {
    let bundle: { v: number; userId: string; displayName: string; signSecret: string; dhSecret: string }
    try {
      bundle = JSON.parse(bundleJson)
    } catch {
      throw new Error('Invalid identity file — could not parse JSON.')
    }
    if (bundle.v !== 1 || !bundle.userId || !bundle.signSecret || !bundle.dhSecret) {
      throw new Error('Unsupported or malformed identity bundle.')
    }
    // Persist to SQLite (replaces existing keys)
    await invoke('db_save_key', { keyId: 'local_sign_secret',   keyType: 'sign_secret',   keyData: bundle.signSecret })
    await invoke('db_save_key', { keyId: 'local_dh_secret',     keyType: 'dh_secret',     keyData: bundle.dhSecret })
    await invoke('db_save_key', { keyId: 'local_user_id',       keyType: 'user_id',       keyData: bundle.userId })
    await invoke('db_save_key', { keyId: 'local_display_name',  keyType: 'display_name',  keyData: bundle.displayName ?? displayName.value })
    // Reload in-memory state
    await cryptoService.loadKeys(bundle.signSecret, bundle.dhSecret)
    userId.value        = bundle.userId
    displayName.value   = bundle.displayName ?? displayName.value
    publicSignKey.value = cryptoService.getPublicSignKey()
    publicDHKey.value   = cryptoService.getPublicDHKey()
  }

  /**
   * Decrypt passphrase-wrapped keys and load them into memory.
   * Returns true on success, false if the passphrase is wrong.
   */
  async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
    const wrappedSign = await invoke<string | null>('db_load_key', { keyId: 'local_sign_secret' })
    if (!wrappedSign) return false
    try {
      const bundle = JSON.parse(wrappedSign)
      await cryptoService.unwrapKeysWithPassphrase(bundle, passphrase)
      publicSignKey.value = cryptoService.getPublicSignKey()
      publicDHKey.value   = cryptoService.getPublicDHKey()
      passphraseProtected.value = true
      return true
    } catch {
      return false
    }
  }

  /**
   * Enable passphrase protection: wrap current in-memory keys and persist
   * the ciphertext bundle, replacing the raw secrets in key_store.
   */
  async function setPassphrase(passphrase: string): Promise<void> {
    const wrapped = cryptoService.wrapKeysWithPassphrase(passphrase)
    const wrappedJson = JSON.stringify(wrapped)
    await invoke('db_save_key', { keyId: 'local_sign_secret', keyType: 'sign_secret', keyData: wrappedJson })
    // Store a sentinel so we don't need to load the sign secret to detect wrapping
    await invoke('db_save_key', { keyId: 'local_dh_secret', keyType: 'dh_secret', keyData: '__wrapped__' })
    passphraseProtected.value = true
  }

  /**
   * Enable OS keychain storage: save raw secrets to the OS credential store
   * and replace the SQLite key_store entry with a sentinel.
   * Keys must already be loaded in memory (not passphrase-locked).
   */
  async function saveToKeychain(): Promise<void> {
    const raw = cryptoService.getRawIdentitySecrets()
    if (!raw) throw new Error('Keys not in memory — cannot save to keychain')
    await invoke('keychain_save', { service: 'hexfield', account: 'identity_sign_secret', secret: raw.signSecret })
    await invoke('keychain_save', { service: 'hexfield', account: 'identity_dh_secret',   secret: raw.dhSecret })
    // Write sentinel to SQLite so we know to load from keychain on next launch
    await invoke('db_save_key', { keyId: 'local_sign_secret', keyType: 'sign_secret', keyData: '__keychain__' })
    await invoke('db_save_key', { keyId: 'local_dh_secret',   keyType: 'dh_secret',   keyData: '__keychain__' })
    keychainProtected.value = true
  }

  /**
   * Disable OS keychain storage: load raw secrets back from the keychain,
   * save them as plain base64 in SQLite, and delete the keychain entries.
   * Keys must already be loaded in memory.
   */
  async function removeFromKeychain(): Promise<void> {
    const signSecret = await invoke<string | null>('keychain_load', { service: 'hexfield', account: 'identity_sign_secret' })
    const dhSecret   = await invoke<string | null>('keychain_load', { service: 'hexfield', account: 'identity_dh_secret' })
    if (!signSecret || !dhSecret) throw new Error('Keychain entry not found — cannot remove')
    await invoke('db_save_key', { keyId: 'local_sign_secret', keyType: 'sign_secret', keyData: signSecret })
    await invoke('db_save_key', { keyId: 'local_dh_secret',   keyType: 'dh_secret',   keyData: dhSecret })
    await invoke('keychain_delete', { service: 'hexfield', account: 'identity_sign_secret' })
    await invoke('keychain_delete', { service: 'hexfield', account: 'identity_dh_secret' })
    keychainProtected.value = false
  }

  /**
   * Disable passphrase protection: re-write the raw secrets back to key_store.
   * Caller must have already unlocked (keys must be in memory).
   */
  async function removePassphrase(): Promise<void> {
    const raw = cryptoService.getRawIdentitySecrets()
    if (!raw) throw new Error('Keys not in memory — unlock first')
    await invoke('db_save_key', { keyId: 'local_sign_secret', keyType: 'sign_secret', keyData: raw.signSecret })
    await invoke('db_save_key', { keyId: 'local_dh_secret',   keyType: 'dh_secret',   keyData: raw.dhSecret })
    passphraseProtected.value = false
  }

  return {
    userId,
    displayName,
    publicSignKey,
    publicDHKey,
    avatarDataUrl,
    avatarHash,
    bio,
    bannerColor,
    bannerDataUrl,
    bannerHash,
    isRegistered,
    passphraseProtected,
    keychainProtected,
    initializeIdentity,
    updateDisplayName,
    updateAvatar,
    updateAvatarHash,
    updateBio,
    updateBannerHash,
    updateBanner,
    exportIdentity,
    importIdentity,
    unlockWithPassphrase,
    setPassphrase,
    removePassphrase,
    saveToKeychain,
    removeFromKeychain,
  }
})
