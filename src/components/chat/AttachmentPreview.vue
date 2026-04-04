<template>
  <div class="attachment-preview" :class="`state-${attachment.transferState}`">
    <!-- ── Complete: inline base64 image ──────────────────────────────── -->
    <template v-if="attachment.transferState === 'inline' && attachment.inlineData">
      <img
        v-if="attachment.mimeType.startsWith('image/')"
        :src="`data:${attachment.mimeType};base64,${attachment.inlineData}`"
        class="preview-image"
        :alt="attachment.name"
        loading="lazy"
        @click="openLightbox"
      />
      <div v-else class="file-chip">
        <AppIcon :path="mdiFile" :size="18" />
        <span class="file-name">{{ attachment.name }}</span>
        <span class="file-size">{{ formatSize(attachment.size) }}</span>
        <a :download="attachment.name" :href="`data:${attachment.mimeType};base64,${attachment.inlineData}`" class="dl-btn">
          <AppIcon :path="mdiDownload" :size="16" />
        </a>
      </div>
    </template>

    <!-- ── Complete: P2P (blob URL available) ─────────────────────────── -->
    <template v-else-if="attachment.transferState === 'complete' && blobUrl">
      <img
        v-if="attachment.mimeType.startsWith('image/')"
        :src="blobUrl"
        class="preview-image"
        :alt="attachment.name"
        loading="lazy"
        @click="openLightbox"
      />
      <video
        v-else-if="attachment.mimeType.startsWith('video/')"
        :src="blobUrl"
        class="preview-video"
        controls
        preload="metadata"
      />
      <audio
        v-else-if="attachment.mimeType.startsWith('audio/')"
        :src="blobUrl"
        class="preview-audio"
        controls
      />
      <div v-else class="file-chip">
        <AppIcon :path="mdiFile" :size="18" />
        <span class="file-name">{{ attachment.name }}</span>
        <span class="file-size">{{ formatSize(attachment.size) }}</span>
        <a :download="attachment.name" :href="blobUrl" class="dl-btn">
          <AppIcon :path="mdiDownload" :size="16" />
        </a>
      </div>
    </template>

    <!-- ── Transferring ────────────────────────────────────────────────── -->
    <div v-else-if="attachment.transferState === 'transferring'" class="transfer-chip">
      <AppIcon :path="mdiLoading" :size="16" class="spin" />
      <span class="file-name">{{ attachment.name }}</span>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: `${progress}%` }" />
      </div>
      <span class="progress-label">{{ progress }}%</span>
    </div>

    <!-- ── Pending (not yet started / waiting for seeder) ─────────────── -->
    <div
      v-else-if="attachment.transferState === 'pending'"
      class="transfer-chip clickable"
      @click="startDownload"
    >
      <AppIcon :path="mdiDownloadCircle" :size="16" />
      <span class="file-name">{{ attachment.name }}</span>
      <span class="file-size">{{ formatSize(attachment.size) }}</span>
    </div>

    <!-- ── Failed ──────────────────────────────────────────────────────── -->
    <div v-else-if="attachment.transferState === 'failed'" class="transfer-chip failed">
      <AppIcon :path="mdiAlertCircle" :size="16" />
      <span class="file-name">{{ attachment.name }}</span>
      <span class="file-size">unavailable</span>
    </div>

    <!-- ── Lightbox overlay ────────────────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="lightboxOpen" class="lightbox" @click="lightboxOpen = false">
        <img
          :src="lightboxSrc"
          class="lightbox-img"
          :alt="attachment.name"
          @click.stop
        />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { mdiFile, mdiDownload, mdiDownloadCircle, mdiAlertCircle, mdiLoading } from '@mdi/js'
import type { Attachment } from '@/types/core'
import { createBlobUrl } from '@/services/attachmentService'
import { useNetworkStore } from '@/stores/networkStore'

const props = defineProps<{
  attachment: Attachment
  messageId:  string
  serverId:   string
}>()

const networkStore = useNetworkStore()

// ── Blob URL management ───────────────────────────────────────────────────────

const blobUrl    = ref<string | null>(null)
const progress   = ref(0)
const lightboxOpen = ref(false)
const lightboxSrc  = ref('')

async function tryLoadBlobUrl() {
  if (props.attachment.transferState !== 'complete' || !props.attachment.contentHash) return
  const url = await createBlobUrl(props.attachment.contentHash, props.attachment.mimeType)
  if (url) blobUrl.value = url
}

onMounted(tryLoadBlobUrl)

watch(() => props.attachment.transferState, (newState) => {
  if (newState === 'complete') tryLoadBlobUrl()
})

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
})

// ── Download ──────────────────────────────────────────────────────────────────

const _att = computed(() => props.attachment)

async function startDownload() {
  if (!_att.value.contentHash) return
  // Tell everyone we want this file
  networkStore.broadcastAttachmentWant(_att.value.contentHash, props.messageId)
  // Wait for a peer to respond with attachment_have (handled in networkStore)
  // In the meantime track progress via polling (simple approach)
  pollProgress()
}

let _pollTimer: ReturnType<typeof setInterval> | null = null

function pollProgress() {
  if (_pollTimer) return
  _pollTimer = setInterval(async () => {
    if (!_att.value.contentHash) return
    const hashHex = _att.value.contentHash.replace('blake3:', '')
    const { invoke } = await import('@tauri-apps/api/core')
    const received  = await invoke<number[]>('get_received_chunks', { contentHash: hashHex })
    const total     = Math.ceil(_att.value.size / (256 * 1024))
    progress.value  = total > 0 ? Math.round((received.length / total) * 100) : 0
    if (progress.value >= 100) {
      clearInterval(_pollTimer!)
      _pollTimer = null
      await tryLoadBlobUrl()
    }
  }, 500)
}

onBeforeUnmount(() => {
  if (_pollTimer) clearInterval(_pollTimer)
})

// ── Lightbox ──────────────────────────────────────────────────────────────────

function openLightbox() {
  if (props.attachment.inlineData) {
    lightboxSrc.value = `data:${props.attachment.mimeType};base64,${props.attachment.inlineData}`
  } else if (blobUrl.value) {
    lightboxSrc.value = blobUrl.value
  }
  lightboxOpen.value = true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<style scoped>
.attachment-preview {
  max-width: 400px;
  margin-top: var(--spacing-xs);
}

.preview-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: 6px;
  cursor: zoom-in;
  display: block;
}

.preview-video {
  max-width: 100%;
  max-height: 300px;
  border-radius: 6px;
  display: block;
}

.preview-audio {
  width: 100%;
  min-width: 200px;
}

.file-chip,
.transfer-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 320px;
}

.clickable {
  cursor: pointer;
}

.clickable:hover {
  background: var(--bg-hover);
  border-color: var(--accent-color);
  color: var(--text-primary);
}

.failed {
  color: var(--color-error, #f04747);
  border-color: var(--color-error, #f04747);
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
  color: var(--text-primary);
}

.file-size {
  color: var(--text-tertiary);
  font-size: 11px;
  flex-shrink: 0;
}

.dl-btn {
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.dl-btn:hover {
  color: var(--accent-color);
}

.progress-bar {
  height: 4px;
  width: 80px;
  background: var(--bg-primary);
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
}

.progress-fill {
  height: 100%;
  background: var(--accent-color);
  transition: width 0.3s ease;
}

.progress-label {
  font-size: 11px;
  color: var(--text-tertiary);
  flex-shrink: 0;
  min-width: 32px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}

/* ── Lightbox ─────────────────────────────────────────────────────────────── */

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}

.lightbox-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 6px;
  cursor: default;
}
</style>
