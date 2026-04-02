<template>
  <div v-if="typingNames.length > 0" class="typing-indicator">
    <span class="typing-dots">
      <span /><span /><span />
    </span>
    <span class="typing-text">{{ typingText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useNetworkStore } from '@/stores/networkStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'

const props = defineProps<{ channelId: string }>()

const networkStore  = useNetworkStore()
const serversStore  = useServersStore()
const identityStore = useIdentityStore()

const typingNames = computed(() => {
  const typingUserIds = networkStore.getTypingUsers(props.channelId)
  const myId = identityStore.userId

  return typingUserIds
    .filter(uid => uid !== myId)
    .map(uid => {
      // Find display name across all server member maps
      for (const memberMap of Object.values(serversStore.members)) {
        if (memberMap[uid]) return memberMap[uid].displayName
      }
      return uid.slice(0, 8)
    })
})

const typingText = computed(() => {
  const names = typingNames.value
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
})
</script>

<style scoped>
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px var(--spacing-md) 8px;
  min-height: 28px;
  font-size: 12px;
  color: var(--text-secondary);
}

.typing-dots {
  display: flex;
  gap: 3px;
  align-items: center;
}

.typing-dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-tertiary);
  animation: typing-bounce 1.2s infinite ease-in-out;
}

.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30%           { transform: translateY(-4px); opacity: 1; }
}

.typing-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
