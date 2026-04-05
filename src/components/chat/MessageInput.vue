<template>
  <div ref="wrapRef" class="message-input-wrap">
    <form class="message-form" @submit.prevent="submit">
      <div class="input-area">
        <!-- Attachment button -->
        <label class="attach-btn" title="Attach file">
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*,*/*"
            style="display: none"
            @change="onFileSelected"
          />
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
          </svg>
        </label>

        <!-- Attachment preview chips -->
        <div v-if="pendingAttachments.length > 0" class="attachment-chips">
          <div
            v-for="(att, i) in pendingAttachments"
            :key="att.id"
            class="attachment-chip"
          >
            <img
              v-if="att.mimeType.startsWith('image/') && att.inlineData"
              :src="`data:${att.mimeType};base64,${att.inlineData}`"
              class="chip-thumb"
              alt=""
            />
            <span class="chip-name">{{ att.name }}</span>
            <button class="chip-remove" type="button" @click="removeAttachment(i)">×</button>
          </div>
        </div>

        <textarea
          ref="inputRef"
          v-model="draft"
          class="message-textarea"
          :placeholder="`Message #${channelName}`"
          rows="1"
          @keydown.enter.exact.prevent="submit"
          @keydown.enter.shift.exact="draft += '\n'"
          @input="onInput"
        />
        <button type="submit" class="send-btn" :disabled="!canSend" title="Send message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useMessagesStore } from '@/stores/messagesStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useNetworkStore } from '@/stores/networkStore'
import type { Attachment } from '@/types/core'
import { v7 as uuidv7 } from 'uuid'
import { prepareAttachment } from '@/services/attachmentService'

const MAX_INLINE_BYTES = 100 * 1024  // 100 KB
const MAX_IMAGE_DIMENSION = 1920      // px — downscale larger images before embed

const props = defineProps<{
  channelId: string
  serverId:  string
}>()

const messagesStore   = useMessagesStore()
const channelsStore   = useChannelsStore()
const networkStore    = useNetworkStore()
const inputRef        = ref<HTMLTextAreaElement | null>(null)
const fileInputRef    = ref<HTMLInputElement | null>(null)
const wrapRef         = ref<HTMLDivElement | null>(null)
const draft           = ref('')
const pendingAttachments = ref<Attachment[]>([])

let typingTimeout: ReturnType<typeof setTimeout> | null = null
let isTyping = false

// ── Visual Viewport — keep input above software keyboard on mobile ────────────
onMounted(() => {
  const vv = window.visualViewport
  if (!vv) return
  function onVVResize() {
    if (!wrapRef.value) return
    const offset = window.innerHeight - vv!.offsetTop - vv!.height
    wrapRef.value.style.marginBottom = offset > 0 ? `${offset}px` : ''
  }
  vv.addEventListener('resize', onVVResize)
  vv.addEventListener('scroll', onVVResize)
  onUnmounted(() => {
    vv.removeEventListener('resize', onVVResize)
    vv.removeEventListener('scroll', onVVResize)
  })
})

const canSend = computed(() =>
  draft.value.trim().length > 0 || pendingAttachments.value.length > 0
)

const channelName = computed(() => {
  for (const list of Object.values(channelsStore.channels)) {
    const ch = list.find(c => c.id === props.channelId)
    if (ch) return ch.name
  }
  return props.channelId
})

// ── Typing indicator ────────────────────────────────────────────────────────

function onInput() {
  autoResize()
  if (!isTyping) {
    isTyping = true
    networkStore.sendTypingStart(props.channelId)
  }
  // Reset the stop-typing timer
  if (typingTimeout) clearTimeout(typingTimeout)
  typingTimeout = setTimeout(() => {
    isTyping = false
    networkStore.sendTypingStop(props.channelId)
    typingTimeout = null
  }, 3000)
}

// ── Send ────────────────────────────────────────────────────────────────────

async function submit() {
  const content = draft.value.trim()
  if (!canSend.value) return

  // Stop typing indicator immediately
  if (typingTimeout) clearTimeout(typingTimeout)
  typingTimeout = null
  if (isTyping) {
    isTyping = false
    networkStore.sendTypingStop(props.channelId)
  }

  draft.value = ''
  autoResize()
  const atts = pendingAttachments.value.slice()
  pendingAttachments.value = []

  await messagesStore.sendMessage(props.channelId, props.serverId, content, atts)
}

// ── File attachments ────────────────────────────────────────────────────────

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // Reset so the same file can be selected again
  input.value = ''

  const att = await buildAttachment(file)
  if (att) pendingAttachments.value.push(att)
}

function removeAttachment(index: number) {
  pendingAttachments.value.splice(index, 1)
}

async function buildAttachment(file: File): Promise<Attachment | null> {
  const isImage = file.type.startsWith('image/')

  if (isImage) {
    // GIFs must not pass through Canvas (that would flatten animation to a single JPEG frame).
    // Read them as raw bytes and embed as-is if they fit within the inline limit.
    if (file.type === 'image/gif') {
      if (file.size <= MAX_INLINE_BYTES) {
        const inlineData = await fileToBase64(file)
        return {
          id:            uuidv7(),
          name:          file.name,
          size:          file.size,
          mimeType:      'image/gif',
          inlineData,
          transferState: 'inline',
        }
      }
      // GIF too large for inline — use P2P content-addressed transfer (preserves animation)
      return prepareAttachment(file)
    }

    // Downscale if necessary, then embed as base64
    const inlineData = await imageToBase64(file, MAX_IMAGE_DIMENSION)
    const byteLength = Math.ceil(inlineData.length * 0.75) // approx decoded size

    if (byteLength <= MAX_INLINE_BYTES) {
      return {
        id:            uuidv7(),
        name:          file.name,
        size:          file.size,
        mimeType:      file.type,
        inlineData,
        transferState: 'inline',
      }
    }
    // Image too large after downscale — use P2P content-addressed transfer
    return prepareAttachment(file)
  }

  // Non-image: inline only if ≤100KB
  if (file.size <= MAX_INLINE_BYTES) {
    const inlineData = await fileToBase64(file)
    return {
      id:            uuidv7(),
      name:          file.name,
      size:          file.size,
      mimeType:      file.type,
      inlineData,
      transferState: 'inline',
    }
  }

  // Large non-image file — P2P content-addressed transfer
  return prepareAttachment(file)
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip the data: prefix — we store raw base64
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function imageToBase64(file: File, maxDimension: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      let { width, height } = img
      if (width > maxDimension || height > maxDimension) {
        if (width >= height) {
          height = Math.round((height / width) * maxDimension)
          width  = maxDimension
        } else {
          width  = Math.round((width / height) * maxDimension)
          height = maxDimension
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('No canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      // Re-encode as JPEG at 90% quality
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
      resolve(dataUrl.split(',')[1] ?? '')
    }
    img.onerror = reject
    img.src = objectUrl
  })
}

function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}
</script>

<style scoped>
.message-input-wrap {
  flex-shrink: 0;
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.message-form {
  width: 100%;
}

.input-area {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: var(--spacing-sm);
  border: 1px solid var(--border-color);
  transition: border-color 0.15s ease;
  flex-wrap: wrap;
}

.input-area:focus-within {
  border-color: var(--accent-color);
}

.attach-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border-radius: 4px;
  flex-shrink: 0;
  align-self: flex-end;
  margin-bottom: 1px;
  transition: color 0.15s ease;
}

.attach-btn:hover {
  color: var(--text-primary);
}

.attachment-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
  order: -1;
}

.attachment-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 180px;
}

.chip-thumb {
  width: 20px;
  height: 20px;
  object-fit: cover;
  border-radius: 3px;
  flex-shrink: 0;
}

.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.chip-remove {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}

.chip-remove:hover {
  color: var(--error-color);
}

.message-textarea {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  min-height: 22px;
  max-height: 200px;
  overflow-y: auto;
  padding: 0;
  min-width: 0;
}

.message-textarea::placeholder {
  color: var(--text-tertiary);
}

.send-btn {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  color: white;
  padding: 4px 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  align-self: flex-end;
  transition: opacity 0.15s ease;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.send-btn:not(:disabled):hover {
  opacity: 0.85;
}
</style>
