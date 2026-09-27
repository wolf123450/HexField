<template>
  <Teleport to="body">
    <div v-if="uiStore.showDirectConnectModal" class="modal-backdrop" @click.self="close">
      <div class="modal-box" @keydown.esc="close">
        <div class="modal-header">
          <h2>Direct Connect</h2>
          <button class="close-btn" @click="close">
            <AppIcon :path="mdiClose" :size="16" />
          </button>
        </div>

        <p class="modal-hint">
          Connect to someone directly — no server, no shared network. One of you
          creates a code, the other pastes it back. Works best when both of you
          are behind a normal home router.
        </p>

        <div class="tabs">
          <button class="tab" :class="{ active: mode === 'create' }" @click="switchMode('create')">
            Create a code
          </button>
          <button class="tab" :class="{ active: mode === 'accept' }" @click="switchMode('accept')">
            I have a code
          </button>
        </div>

        <!-- ── Create a code (offerer) ─────────────────────────────────────── -->
        <div v-if="mode === 'create'" class="panel">
          <template v-if="!offer">
            <p class="step-text">Generate a code and send it to the other person (chat, email, voice call — any channel works).</p>
            <button class="btn-primary" :disabled="busy" @click="startOffer">
              {{ busy ? 'Generating…' : 'Generate code' }}
            </button>
          </template>

          <template v-else>
            <label class="field-label">YOUR CODE ({{ offerExpiryLabel }})</label>
            <div v-if="offerQrSvg" class="qr-wrapper" v-html="offerQrSvg" />
            <div class="code-row">
              <textarea class="code-box" :value="offer.code" readonly rows="3" />
              <button class="btn-icon" :title="offerCopied ? 'Copied!' : 'Copy'" @click="copy(offer.code, () => (offerCopied = true))">
                <AppIcon :path="offerCopied ? mdiCheck : mdiContentCopy" :size="16" />
              </button>
            </div>

            <label class="field-label">THEIR REPLY CODE</label>
            <textarea
              v-model="answerInput"
              class="text-input code-input"
              rows="3"
              placeholder="hexfield-answer:…"
              :disabled="connecting"
            />
            <button class="btn-primary" :disabled="!answerInput.trim() || connecting" @click="finishOffer">
              {{ connecting ? connectingLabel : 'Connect' }}
            </button>
          </template>

          <p v-if="statusMsg" class="status-msg" :class="{ error: isError, success: isSuccess }">{{ statusMsg }}</p>
        </div>

        <!-- ── I have a code (answerer) ────────────────────────────────────── -->
        <div v-if="mode === 'accept'" class="panel">
          <template v-if="!answer">
            <label class="field-label">THEIR CODE</label>
            <textarea
              v-model="offerInput"
              class="text-input code-input"
              rows="3"
              placeholder="hexfield-offer:…"
              :disabled="busy"
            />
            <button class="btn-primary" :disabled="!offerInput.trim() || busy" @click="acceptOffer">
              {{ busy ? 'Verifying…' : 'Accept code' }}
            </button>
          </template>

          <template v-else>
            <p class="step-text">Send this reply code back to {{ answer.fromDisplayName }}. You'll connect automatically once they apply it.</p>
            <label class="field-label">YOUR REPLY CODE</label>
            <div v-if="answerQrSvg" class="qr-wrapper" v-html="answerQrSvg" />
            <div class="code-row">
              <textarea class="code-box" :value="answer.code" readonly rows="3" />
              <button class="btn-icon" :title="answerCopied ? 'Copied!' : 'Copy'" @click="copy(answer.code, () => (answerCopied = true))">
                <AppIcon :path="answerCopied ? mdiCheck : mdiContentCopy" :size="16" />
              </button>
            </div>
          </template>

          <p v-if="statusMsg" class="status-msg" :class="{ error: isError, success: isSuccess }">{{ statusMsg }}</p>
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="close">{{ isSuccess ? 'Done' : 'Cancel' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { mdiClose, mdiContentCopy, mdiCheck } from '@mdi/js'
import QRCode from 'qrcode'
import { useUIStore } from '@/stores/uiStore'
import { useNetworkStore } from '@/stores/networkStore'
import * as directConnect from '@/services/directConnectService'
import type { CreateOfferResult, AcceptOfferResult } from '@/services/directConnectService'
import { logger } from '@/utils/logger'

const uiStore      = useUIStore()
const networkStore = useNetworkStore()

const mode        = ref<'create' | 'accept'>('create')
const busy        = ref(false)
const connecting  = ref(false)
const connectingLabel = ref('Connecting…')
const statusMsg   = ref('')
const isError     = ref(false)
const isSuccess   = ref(false)

const offer         = ref<CreateOfferResult | null>(null)
const offerQrSvg    = ref('')
const offerCopied   = ref(false)
const answerInput   = ref('')

const offerInput  = ref('')
const answer      = ref<AcceptOfferResult | null>(null)
const answerQrSvg = ref('')
const answerCopied = ref(false)

const offerExpiryLabel = ref('expires in 10 min')
let expiryTimer: ReturnType<typeof setInterval> | null = null

watch(() => uiStore.showDirectConnectModal, async (open) => {
  if (open) {
    resetState()
  } else {
    await teardown()
  }
})

function resetState() {
  mode.value = 'create'
  busy.value = false
  connecting.value = false
  statusMsg.value = ''
  isError.value = false
  isSuccess.value = false
  offer.value = null
  offerQrSvg.value = ''
  offerCopied.value = false
  answerInput.value = ''
  offerInput.value = ''
  answer.value = null
  answerQrSvg.value = ''
  answerCopied.value = false
}

async function teardown() {
  if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null }
  if (offer.value && !isSuccess.value) {
    await directConnect.cancelOfferSession(offer.value.sessionId)
  }
}

function switchMode(next: 'create' | 'accept') {
  if (mode.value === next) return
  mode.value = next
  statusMsg.value = ''
  isError.value = false
}

async function startOffer() {
  busy.value = true
  statusMsg.value = ''
  isError.value = false
  try {
    const result = await directConnect.createOfferCode()
    offer.value = result
    await renderQr(result.code, offerQrSvg)
    startExpiryCountdown(result.expiresAt)
  } catch (e: unknown) {
    statusMsg.value = e instanceof Error ? e.message : 'Could not generate a code.'
    isError.value = true
  } finally {
    busy.value = false
  }
}

function startExpiryCountdown(expiresAt: number) {
  if (expiryTimer) clearInterval(expiryTimer)
  const update = () => {
    const remainingMs = expiresAt - Date.now()
    if (remainingMs <= 0) {
      offerExpiryLabel.value = 'expired'
      if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null }
      return
    }
    offerExpiryLabel.value = `expires in ${Math.ceil(remainingMs / 60000)} min`
  }
  update()
  expiryTimer = setInterval(update, 15000)
}

async function finishOffer() {
  if (!offer.value || !answerInput.value.trim()) return
  connecting.value = true
  statusMsg.value = ''
  isError.value = false
  try {
    connectingLabel.value = 'Verifying reply code…'
    const result = await directConnect.applyAnswerCode(offer.value.sessionId, answerInput.value)
    connectingLabel.value = `Connecting to ${result.fromDisplayName}…`
    await networkStore.waitForPeer(result.fromUserId, 20000)
    statusMsg.value = `Connected to ${result.fromDisplayName}! You can now join a server or share an invite.`
    isSuccess.value = true
  } catch (e: unknown) {
    statusMsg.value = e instanceof Error ? e.message : 'Could not connect.'
    isError.value = true
  } finally {
    connecting.value = false
  }
}

async function acceptOffer() {
  if (!offerInput.value.trim()) return
  busy.value = true
  statusMsg.value = ''
  isError.value = false
  try {
    const result = await directConnect.acceptOfferCode(offerInput.value)
    answer.value = result
    await renderQr(result.code, answerQrSvg)
    // Don't block the UI on this — it just upgrades the status line once the
    // other side applies the answer and ICE finishes connecting.
    networkStore.waitForPeer(result.fromUserId, 30000).then(() => {
      statusMsg.value = `Connected to ${result.fromDisplayName}!`
      isError.value = false
      isSuccess.value = true
    }).catch(() => {
      if (!isSuccess.value) {
        statusMsg.value = `Sent. Waiting for ${result.fromDisplayName} to apply the reply code…`
      }
    })
    statusMsg.value = `Sent. Waiting for ${result.fromDisplayName} to apply the reply code…`
  } catch (e: unknown) {
    statusMsg.value = e instanceof Error ? e.message : 'Could not read that code.'
    isError.value = true
  } finally {
    busy.value = false
  }
}

async function renderQr(text: string, target: { value: string }) {
  try {
    target.value = await QRCode.toString(text, { type: 'svg', margin: 1, width: 160, errorCorrectionLevel: 'L' })
  } catch (e) {
    logger.warn('directConnect', 'QR render failed:', e)
    target.value = ''
  }
}

async function copy(text: string, onCopied: () => void) {
  try {
    await navigator.clipboard.writeText(text)
    onCopied()
    setTimeout(() => { offerCopied.value = false; answerCopied.value = false }, 2000)
  } catch {
    // clipboard not available
  }
}

async function close() {
  uiStore.showDirectConnectModal = false
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-xl);
  width: 460px;
  max-width: 90vw;
  max-height: 85vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-header h2 { margin: 0; font-size: 20px; color: var(--text-primary); }

.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0;
  transform: none;
  border-radius: 4px;
  display: flex;
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.modal-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.tabs {
  display: flex;
  gap: 4px;
  background: var(--bg-primary);
  border-radius: 6px;
  padding: 4px;
}

.tab {
  flex: 1;
  background: none;
  border: none;
  border-radius: 4px;
  padding: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.tab.active { background: var(--bg-tertiary); color: var(--text-primary); }

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.step-text {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.qr-wrapper {
  display: flex;
  justify-content: center;
  background: white;
  border-radius: 8px;
  padding: var(--spacing-md);
}
.qr-wrapper :deep(svg) {
  width: 160px;
  height: 160px;
}

.code-row {
  display: flex;
  gap: var(--spacing-sm);
  align-items: flex-start;
}

.code-box {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: monospace;
  resize: vertical;
  word-break: break-all;
}

.text-input.code-input {
  font-family: monospace;
  font-size: 12px;
  resize: vertical;
  word-break: break-all;
}

.text-input {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 10px var(--spacing-md);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
.text-input:focus { border-color: var(--accent-color); }

.btn-icon {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  transform: none;
}
.btn-icon:hover { background: var(--bg-primary); }

.status-msg {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}
.status-msg.error { color: var(--error-color); }
.status-msg.success { color: var(--success-color, #3ba55d); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.btn-secondary {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 16px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}
.btn-secondary:hover { background: var(--bg-tertiary); }

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 16px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
