<template>
  <main class="main-pane">
    <!-- Voice content pane takes over when in a voice session -->
    <VoiceContentPane v-if="voiceStore.session" />

    <!-- Normal text channel view -->
    <template v-else-if="activeChannel">
      <div class="channel-header">
        <span class="channel-hash">#</span>
        <span class="channel-name">{{ activeChannel.name }}</span>
        <span v-if="activeChannel.topic" class="channel-topic">{{ activeChannel.topic }}</span>
        <div class="channel-header-actions">
          <button class="icon-btn" title="Toggle member list" @click="uiStore.memberListOpen = !uiStore.memberListOpen">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
          </button>
        </div>
      </div>

      <MessageHistory :channel-id="activeChannel.id" />
      <MessageInput :channel-id="activeChannel.id" :server-id="activeChannel.serverId" />
    </template>

    <div v-else class="empty-state">
      <div class="empty-icon">💬</div>
      <div class="empty-title">No channel selected</div>
      <div class="empty-sub">Pick a channel from the sidebar to get started</div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useChannelsStore } from '@/stores/channelsStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceStore } from '@/stores/voiceStore'
import MessageHistory from '@/components/chat/MessageHistory.vue'
import MessageInput from '@/components/chat/MessageInput.vue'
import VoiceContentPane from '@/components/chat/VoiceContentPane.vue'

const channelsStore = useChannelsStore()
const uiStore       = useUIStore()
const voiceStore    = useVoiceStore()

const activeChannel = computed(() => {
  const id = channelsStore.activeChannelId
  if (!id) return null
  for (const list of Object.values(channelsStore.channels)) {
    const ch = list.find(c => c.id === id)
    if (ch) return ch
  }
  return null
})
</script>

<style scoped>
.main-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  min-width: 0;
}

.channel-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-md);
  height: 48px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.channel-hash {
  color: var(--text-tertiary);
  font-size: 20px;
  flex-shrink: 0;
}

.channel-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--text-primary);
}

.channel-topic {
  font-size: 13px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: var(--spacing-sm);
  padding-left: var(--spacing-sm);
  border-left: 1px solid var(--border-color);
}

.channel-header-actions {
  margin-left: auto;
  display: flex;
  gap: var(--spacing-xs);
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--text-tertiary);
}

.empty-icon {
  font-size: 48px;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-secondary);
}

.empty-sub {
  font-size: 14px;
}
</style>
