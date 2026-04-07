<template>
  <div class="approve-view">
    <div class="approve-card">
      <h2>Join Request</h2>

      <div v-if="loading" class="status-row">
        <div class="spinner" />
        <span>Processing…</span>
      </div>

      <template v-else-if="error">
        <p class="error-msg">{{ error }}</p>
        <button class="btn-secondary" @click="goHome">Go back</button>
      </template>

      <template v-else-if="capsule">
        <div class="requester-info">
          <AvatarImage :src="null" :name="capsule.displayName" :size="56" />
          <div class="requester-meta">
            <div class="requester-name">{{ capsule.displayName }}</div>
            <div class="requester-id">{{ capsule.userId.slice(0, 12) }}…</div>
          </div>
        </div>

        <p class="join-hint">
          <strong>{{ capsule.displayName }}</strong> wants to join
          <strong>{{ targetServer?.name ?? capsule.serverName }}</strong>.
        </p>

        <div v-if="!isAdminOfServer" class="warning-box">
          You are not an admin of <strong>{{ capsule.serverName }}</strong> or the server is not open on this device.
        </div>

        <div v-if="approved" class="success-box">
          <strong>{{ capsule.displayName }}</strong> has been added to the server and will receive the server data shortly.
        </div>

        <div class="actions" v-if="!approved">
          <button
            class="btn-approve"
            :disabled="!isAdminOfServer || approving"
            @click="doApprove"
          >
            {{ approving ? 'Approving…' : 'Approve' }}
          </button>
          <button class="btn-deny" @click="goHome">Cancel</button>
        </div>
        <div class="actions" v-else>
          <button class="btn-secondary" @click="goHome">Done</button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import type { JoinCapsule } from '@/types/core'

const route         = useRoute()
const router        = useRouter()
const serversStore  = useServersStore()
const identityStore = useIdentityStore()

const loading   = ref(true)
const error     = ref('')
const capsule   = ref<JoinCapsule | null>(null)
const approving = ref(false)
const approved  = ref(false)

function decodeCapsule(raw: string): JoinCapsule {
  let encoded = raw.trim()
  const prefix = 'hexfield://approve/'
  if (encoded.startsWith(prefix)) encoded = encoded.slice(prefix.length)
  const pad = (4 - (encoded.length % 4)) % 4
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const c = JSON.parse(atob(b64)) as JoinCapsule
  if (c.v !== 1 || !c.userId || !c.serverId) throw new Error('Invalid or malformed join capsule.')
  return c
}

const targetServer = computed(() => {
  if (!capsule.value) return null
  return serversStore.servers[capsule.value.serverId] ?? null
})

const isAdminOfServer = computed(() => {
  if (!capsule.value) return false
  const sid = capsule.value.serverId
  const uid = identityStore.userId
  if (!sid || !uid) return false
  return serversStore.members[sid]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

onMounted(async () => {
  try {
    const param = route.params.capsule as string
    if (!param) throw new Error('No capsule data provided.')
    capsule.value = decodeCapsule(param)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Could not parse join capsule.'
  } finally {
    loading.value = false
  }
})

async function doApprove() {
  if (!capsule.value || !isAdminOfServer.value) return
  approving.value = true
  try {
    await serversStore.approveCapsule(capsule.value)
    approved.value = true
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to approve join request.'
  } finally {
    approving.value = false
  }
}

function goHome() {
  router.replace({ path: '/servers' })
}
</script>

<style scoped>
.approve-view {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--bg-primary);
}

.approve-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  width: 400px;
  max-width: calc(100vw - 32px);
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  text-align: center;
}

.status-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  color: var(--text-secondary);
  font-size: 14px;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--bg-tertiary);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-msg {
  margin: 0;
  font-size: 14px;
  color: var(--error-color);
  text-align: center;
}

.requester-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.requester-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.requester-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.requester-id {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: monospace;
}

.join-hint {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  text-align: center;
}

.warning-box {
  background: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.4);
  border-radius: 6px;
  padding: var(--spacing-md);
  font-size: 13px;
  color: #faa61a;
}

.success-box {
  background: rgba(87, 242, 135, 0.1);
  border: 1px solid rgba(87, 242, 135, 0.4);
  border-radius: 6px;
  padding: var(--spacing-md);
  font-size: 13px;
  color: #57f287;
}

.actions {
  display: flex;
  gap: var(--spacing-sm);
  justify-content: center;
}

.btn-approve {
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  padding: 10px 28px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-approve:hover:not(:disabled) { filter: brightness(1.1); }
.btn-approve:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-deny,
.btn-secondary {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 10px 20px;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
}
.btn-deny:hover,
.btn-secondary:hover { background: var(--bg-primary); color: var(--text-primary); }
</style>
