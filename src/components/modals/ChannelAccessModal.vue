<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-box" role="dialog" aria-modal="true">
        <h2 class="modal-title">Channel Access Settings</h2>

        <!-- Visibility mode -->
        <div class="field-group">
          <label class="field-label">Visibility</label>
          <div class="radio-group">
            <label>
              <input v-model="mode" type="radio" value="public" />
              Public <span class="hint">— everyone may access this channel</span>
            </label>
            <label>
              <input v-model="mode" type="radio" value="role" />
              Role-gated <span class="hint">— only members with allowed roles</span>
            </label>
            <label>
              <input v-model="mode" type="radio" value="private" />
              Private <span class="hint">— only explicitly allowed users</span>
            </label>
          </div>
        </div>

        <!-- Role gate checkboxes -->
        <div v-if="mode === 'role'" class="field-group">
          <label class="field-label">Allowed roles</label>
          <div v-if="availableRoles.length === 0" class="hint">No roles defined on this server.</div>
          <div v-for="role in availableRoles" :key="role" class="checkbox-row">
            <label>
              <input v-model="selectedRoles" type="checkbox" :value="role" />
              {{ role }}
            </label>
          </div>
        </div>

        <!-- Allowed users picker -->
        <div v-if="mode === 'private' || mode === 'role'" class="field-group">
          <label class="field-label">Allowed users</label>
          <div class="hint">Select members allowed regardless of role</div>
          <div v-for="m in otherMembers" :key="m.userId" class="checkbox-row member-row">
            <label>
              <input v-model="allowedUsers" type="checkbox" :value="m.userId" />
              <AvatarImage :src="m.avatarDataUrl ?? null" :name="m.displayName" :size="20" class="member-avatar" />
              {{ m.displayName }}
            </label>
          </div>
        </div>

        <!-- Denied users picker -->
        <div class="field-group">
          <label class="field-label">Blocked users</label>
          <div class="hint">These users are always denied access</div>
          <div v-for="m in otherMembers" :key="m.userId" class="checkbox-row member-row">
            <label>
              <input v-model="deniedUsers" type="checkbox" :value="m.userId" />
              <AvatarImage :src="m.avatarDataUrl ?? null" :name="m.displayName" :size="20" class="member-avatar" />
              {{ m.displayName }}
            </label>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="$emit('close')">Cancel</button>
          <button class="btn-primary" :disabled="saving" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import AvatarImage from '@/components/AvatarImage.vue'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useIdentityStore } from '@/stores/identityStore'
import type { ChannelACL } from '@/types/core'

const props = defineProps<{
  show:      boolean
  channelId: string
  serverId:  string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const identityStore = useIdentityStore()

type VisMode = 'public' | 'role' | 'private'

const mode         = ref<VisMode>('public')
const selectedRoles = ref<string[]>([])
const allowedUsers  = ref<string[]>([])
const deniedUsers   = ref<string[]>([])
const saving        = ref(false)

// Collect distinct roles from all server members (excluding owner/admin which are built-in)
const availableRoles = computed<string[]>(() => {
  const memberMap = serversStore.members[props.serverId] ?? {}
  const roleSet = new Set<string>()
  for (const m of Object.values(memberMap)) {
    for (const r of m.roles) roleSet.add(r)
  }
  return Array.from(roleSet).sort()
})

const otherMembers = computed(() => {
  const memberMap = serversStore.members[props.serverId] ?? {}
  const myId = identityStore.userId
  return Object.values(memberMap).filter(m => m.userId !== myId)
})

// Populate form from existing ACL whenever the modal opens
watch(() => props.show, (open) => {
  if (!open) return
  const acl = channelsStore.channelAcls[props.channelId]
  if (!acl) {
    mode.value          = 'public'
    selectedRoles.value = []
    allowedUsers.value  = []
    deniedUsers.value   = []
    return
  }
  if (acl.privateChannel) {
    mode.value = 'private'
  } else if ((acl.allowedRoles ?? []).length > 0) {
    mode.value = 'role'
  } else {
    mode.value = 'public'
  }
  selectedRoles.value = [...(acl.allowedRoles ?? [])]
  allowedUsers.value  = [...(acl.allowedUsers ?? [])]
  deniedUsers.value   = [...(acl.deniedUsers  ?? [])]
})

async function save() {
  saving.value = true
  try {
    const acl: ChannelACL = {
      channelId:     props.channelId,
      privateChannel: mode.value === 'private',
      allowedRoles:  mode.value === 'role' ? [...selectedRoles.value] : [],
      allowedUsers:  mode.value !== 'public' ? [...allowedUsers.value] : [],
      deniedUsers:   [...deniedUsers.value],
    }
    await serversStore.updateChannelAcl(props.serverId, acl)
    emit('close')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
}

.modal-box {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  width: 440px;
  max-width: 95vw;
  max-height: 80vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.hint {
  font-size: 12px;
  color: var(--text-muted, var(--text-secondary));
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.radio-group label,
.checkbox-row label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.member-row label {
  gap: 8px;
}

.member-avatar {
  flex-shrink: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.btn-primary {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  background: var(--accent-color);
  color: white;
  border: none;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn-secondary {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-color, rgba(255,255,255,0.12));
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.06);
}
</style>
