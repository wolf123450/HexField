<template>
  <transition name="notification-fade">
    <div
      v-if="isVisible"
      class="notification"
      :class="`notification-${type}`"
      role="alert"
      aria-live="assertive"
    >
      <span class="notification-icon"><AppIcon :path="getIconPath()" :size="18" /></span>
      <span class="notification-message">{{ message }}</span>
      <button v-if="action" class="notification-action" @click="onAction">{{ action.label }}</button>
      <button class="notification-close" @click="hideNotification"><AppIcon :path="mdiClose" :size="14" /></button>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  mdiCheckCircleOutline,
  mdiCloseCircleOutline,
  mdiAlertCircleOutline,
  mdiInformationOutline,
  mdiClose,
} from '@mdi/js'
import { useUIStore } from '@/stores/uiStore'

const uiStore = useUIStore()

const isVisible = computed(() => uiStore.isNotificationVisible)
const message   = computed(() => uiStore.notificationMessage)
const type      = computed(() => uiStore.notificationType)
const action    = computed(() => uiStore.notificationAction)

const onAction = () => { action.value?.callback() }

const getIconPath = () => {
  switch (type.value) {
    case 'success': return mdiCheckCircleOutline
    case 'error':   return mdiCloseCircleOutline
    case 'warning': return mdiAlertCircleOutline
    default:        return mdiInformationOutline
  }
}

const hideNotification = () => { uiStore.hideNotification() }
</script>

<style scoped>
.notification {
  position: fixed;
  bottom: var(--spacing-lg);
  right: var(--spacing-lg);
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 1000;
  animation: slideInRight var(--transition-normal);
}

.notification-icon {
  font-weight: 600;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}

.notification-success { border-left: 4px solid var(--success-color); }
.notification-success .notification-icon { color: var(--success-color); }
.notification-error   { border-left: 4px solid var(--error-color); }
.notification-error   .notification-icon { color: var(--error-color); }
.notification-warning { border-left: 4px solid var(--warning-color); }
.notification-warning .notification-icon { color: var(--warning-color); }
.notification-info    { border-left: 4px solid var(--info-color); }
.notification-info    .notification-icon { color: var(--info-color); }

.notification-message { flex: 1; font-size: 14px; color: var(--text-primary); }

.notification-action {
  background: var(--accent-color);
  border: none;
  border-radius: var(--radius-sm);
  color: #fff;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s;
}
.notification-action:hover { opacity: 0.85; }

.notification-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 20px;
  padding: 0;
  line-height: 1;
  transition: color var(--transition-fast);
}
.notification-close:hover { color: var(--text-primary); }

.notification-fade-enter-active,
.notification-fade-leave-active {
  transition: opacity var(--transition-normal), transform var(--transition-normal);
}
.notification-fade-enter-from,
.notification-fade-leave-to { opacity: 0; transform: translateX(100px); }
</style>
