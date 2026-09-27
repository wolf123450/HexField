<template>
  <div class="attachment-preview" :class="`state-${attachment.transferState}`">
    <!-- ── Original available locally ──────────────────────────────────── -->
    <template v-if="blobUrl">
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

    <!-- ── Inline preview until the original arrives (relay policy, 3d) ── -->
    <div
      v-else-if="previewUrl"
      class="preview-wrap"
      :title="`Preview of ${attachment.name}: the full image loads when a direct connection to someone who has it is available`"
    >
      <img
        :src="previewUrl"
        class="preview-image is-preview"
        :alt="attachment.name"
        @click="openLightbox"
      />
      <span class="preview-badge">
        <AppIcon :path="downloading ? mdiLoading : mdiImageFilterHdr" :size="12" :class="{ spin: downloading }" />
        Preview
      </span>
    </div>

    <!-- ── Transferring ────────────────────────────────────────────────── -->
    <div v-else-if="downloading" class="transfer-chip">
      <AppIcon :path="mdiLoading" :size="16" class="spin" />
      <span class="file-name">{{ attachment.name }}</span>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: `${progress}%` }" />
      </div>
      <span class="progress-label">{{ progress }}%</span>
    </div>

    <!-- ── Failed ──────────────────────────────────────────────────────── -->
    <div v-else-if="attachment.transferState === 'failed'" class="transfer-chip failed">
      <AppIcon :path="mdiAlertCircle" :size="16" />
      <span class="file-name">{{ attachment.name }}</span>
      <span class="file-size">unavailable</span>
    </div>

    <!-- ── Not local yet: click to fetch from peers ────────────────────── -->
    <div
      v-else
      class="transfer-chip clickable"
      @click="startDownload"
    >
      <AppIcon :path="mdiDownloadCircle" :size="16" />
      <span class="file-name">{{ attachment.name }}</span>
      <span class="file-size">{{ formatSize(attachment.size) }}</span>
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
import { mdiFile, mdiDownload, mdiDownloadCircle, mdiAlertCircle, mdiLoading, mdiImageFilterHdr } from '@mdi/js'
import type { Attachment } from '@/types/core'
import {
  createBlobUrl,
  downloadAttachment,
  downloadProgress,
  isValidPreviewDataUrl,
} from '@/services/attachmentService'
import { useNetworkStore } from '@/stores/networkStore'

const props = defineProps<{
  attachment: Attachment
  messageId:  string
  serverId:   string
}>()

const networkStore = useNetworkStore()

// ── Blob URL management ───────────────────────────────────────────────────────

const blobUrl      = ref<string | null>(null)
const progress     = ref(0)
const downloading  = ref(false)
const lightboxOpen = ref(false)
const lightboxSrc  = ref('')

const isImage    = computed(() => props.attachment.mimeType.startsWith('image/'))
const previewUrl = computed(() =>
  isImage.value && isValidPreviewDataUrl(props.attachment.previewDataUrl) ? props.attachment.previewDataUrl : null,
)

/** Load the original if it's stored locally (sender, or after a download). */
async function tryLoadBlobUrl(): Promise<boolean> {
  if (blobUrl.value) return true
  if (!props.attachment.contentHash) return false
  const url = await createBlobUrl(props.attachment.contentHash, props.attachment.mimeType)
  if (url) blobUrl.value = url
  return url !== null
}

onMounted(async () => {
  // Images fetch their original automatically; other files wait for a click.
  if (!(await tryLoadBlobUrl()) && isImage.value) startDownload()
})

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
})

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Register the download and ask peers who has the file. Seeders reply with
 * `attachment_have` and are asked for chunks (networkStore). Relayed peers
 * neither answer nor seed (relay policy), so a relayed-only user keeps the
 * preview until a direct connection appears.
 */
function startDownload() {
  const contentHash = props.attachment.contentHash
  if (!contentHash || downloading.value || blobUrl.value) return
  downloading.value = true
  downloadAttachment(props.attachment)
    .then(() => tryLoadBlobUrl())
    .catch(() => { /* stays on preview / download chip */ })
    .finally(() => { downloading.value = false; stopProgress() })
  networkStore.broadcastAttachmentWant(contentHash, props.messageId)
  startProgress()
}

// New peers may hold the file (e.g. a direct connection replacing a relayed
// one), so ask again whenever the connected set changes mid-download.
watch(() => networkStore.connectedPeers, () => {
  if (downloading.value && props.attachment.contentHash) {
    networkStore.broadcastAttachmentWant(props.attachment.contentHash, props.messageId)
  }
})

let _progressTimer: ReturnType<typeof setInterval> | null = null

function startProgress() {
  if (_progressTimer) return
  _progressTimer = setInterval(() => {
    const fraction = props.attachment.contentHash ? downloadProgress(props.attachment.contentHash) : null
    progress.value = fraction === null ? 0 : Math.round(fraction * 100)
  }, 500)
}

function stopProgress() {
  if (_progressTimer) clearInterval(_progressTimer)
  _progressTimer = null
}

onBeforeUnmount(stopProgress)

// ── Lightbox ──────────────────────────────────────────────────────────────────

function openLightbox() {
  const src = blobUrl.value ?? previewUrl.value
  if (!src) return
  lightboxSrc.value = src
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

.preview-wrap {
  position: relative;
  display: inline-block;
}

.preview-image.is-preview {
  filter: saturate(0.9);
}

.preview-badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  pointer-events: none;
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
