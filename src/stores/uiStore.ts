import { defineStore } from "pinia";
import { ref } from "vue";
import { useSettingsStore } from "./settingsStore";

// ─── Context menu types ───────────────────────────────────────────────────────
export type MenuItem =
  | { type: 'action'; label: string; shortcut?: string; danger?: boolean; callback: () => void }
  | { type: 'separator' }
  | { type: 'disabled'; label: string }

export interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  theme: "dark" | "light";
  showSettings: boolean;
  activePanel: string;
  notificationMessage: string;
  notificationType: "success" | "error" | "info" | "warning";
  isNotificationVisible: boolean;
}

export const useUIStore = defineStore("ui", () => {
  const sidebarOpen = ref<boolean>(true);
  const sidebarWidth = ref<number>(250);
  const theme = ref<"dark" | "light">("dark");
  const showSettings = ref<boolean>(false);
  const activePanel = ref<string>("main");
  const notificationMessage = ref<string>("");
  const notificationType = ref<"success" | "error" | "info" | "warning">("info");
  const isNotificationVisible = ref<boolean>(false);
  const notificationAction = ref<{ label: string; callback: () => void } | null>(null);
  let _notificationTimer: number | undefined;

  const toggleSidebar = () => {
    sidebarOpen.value = !sidebarOpen.value;
  };

  const setSidebarWidth = (width: number) => {
    sidebarWidth.value = width;
  };

  const setTheme = (newTheme: "dark" | "light") => {
    theme.value = newTheme;
    document.documentElement.setAttribute("data-theme", newTheme);
    const settingsStore = useSettingsStore();
    if (settingsStore.settings.theme !== newTheme) {
      settingsStore.updateSetting('theme', newTheme);
    }
  };

  const toggleSettings = () => {
    showSettings.value = !showSettings.value;
  };

  const setActivePanel = (panel: string) => {
    activePanel.value = panel;
  };

  const showNotification = (
    message: string,
    type: "success" | "error" | "info" | "warning" = "info",
    duration: number = 3000,
    action?: { label: string; callback: () => void }
  ) => {
    notificationMessage.value = message;
    notificationType.value = type;
    notificationAction.value = action ?? null;
    isNotificationVisible.value = true;

    if (_notificationTimer !== undefined) clearTimeout(_notificationTimer);
    if (duration > 0) {
      _notificationTimer = window.setTimeout(() => {
        isNotificationVisible.value = false;
        _notificationTimer = undefined;
      }, duration);
    }
  };

  const hideNotification = () => {
    isNotificationVisible.value = false;
    notificationAction.value = null;
  };

  // ─── Context menu ─────────────────────────────────────────────────────
  const contextMenuVisible = ref(false)
  const contextMenuX       = ref(0)
  const contextMenuY       = ref(0)
  const contextMenuItems   = ref<MenuItem[]>([])

  const showContextMenu = (x: number, y: number, items: MenuItem[]) => {
    contextMenuItems.value  = items
    contextMenuX.value      = x
    contextMenuY.value      = y
    contextMenuVisible.value = true
  }

  const hideContextMenu = () => {
    contextMenuVisible.value = false
  }

  // ─── HexField layout state ────────────────────────────────────────────
  const voicePanelOpen    = ref<boolean>(false)
  const memberListOpen    = ref<boolean>(true)
  const emojiPickerAnchor = ref<HTMLElement | null>(null)
  const emojiPickerTarget = ref<string | null>(null)   // channelId or messageId

  // Mobile panel navigation: which panel is currently in view on small screens.
  // 'servers' → ServerRail drawer, 'channels' → ChannelSidebar, 'chat' → MainPane (default), 'members' → MemberList sheet
  const mobilePanelView = ref<'servers' | 'channels' | 'chat' | 'members'>('chat')
  function setMobilePanelView(panel: 'servers' | 'channels' | 'chat' | 'members') {
    mobilePanelView.value = panel
  }

  // ─── Modals ───────────────────────────────────────────────────────────
  const showServerCreateModal = ref(false)
  const showJoinModal         = ref(false)
  const showInviteModal       = ref(false)
  const inviteServerId        = ref<string | null>(null)
  const showDeviceLinkModal   = ref(false)
  const showServerSettingsModal = ref(false)
  const settingsServerId        = ref<string | null>(null)

  function openInviteModal(serverId: string) {
    inviteServerId.value  = serverId
    showInviteModal.value = true
  }

  function openDeviceLinkModal() {
    showDeviceLinkModal.value = true
  }

  function openServerSettings(serverId: string) {
    settingsServerId.value        = serverId
    showServerSettingsModal.value = true
  }

  const showJoinCapsuleModal = ref(false)
  const joinCapsuleServerId  = ref<string | null>(null)

  function openJoinCapsuleModal(serverId: string) {
    joinCapsuleServerId.value  = serverId
    showJoinCapsuleModal.value = true
  }

  // ─── User profile modal ────────────────────────────────────────────
  const showUserProfile    = ref(false)
  const userProfileUserId  = ref<string | null>(null)
  const userProfileServerId = ref<string | null>(null)
  const userProfileReadOnly = ref(false)

  function openUserProfile(userId: string, serverId: string | null, readOnly = false) {
    userProfileUserId.value   = userId
    userProfileServerId.value = serverId
    userProfileReadOnly.value = readOnly
    showUserProfile.value     = true
  }

  function closeUserProfile() {
    showUserProfile.value = false
  }

  // ─── Source picker modal (screen share) ────────────────────────────────
  const sourcePickerOpen    = ref(false)
  let sourcePickerResolve: ((sourceId: string | null) => void) | null = null

  function openSourcePicker(): Promise<string | null> {
    return new Promise(resolve => {
      sourcePickerResolve = resolve
      sourcePickerOpen.value = true
    })
  }

  function closeSourcePicker(sourceId: string | null = null) {
    sourcePickerResolve?.(sourceId)
    sourcePickerResolve = null
    sourcePickerOpen.value = false
  }

  // ─── Alert modal (requires explicit acknowledgement) ──────────────────
  const alertTitle   = ref<string>('')
  const alertMessage = ref<string>('')
  const alertVisible = ref(false)

  function showAlert(title: string, message: string) {
    alertTitle.value   = title
    alertMessage.value = message
    alertVisible.value = true
  }

  function dismissAlert() {
    alertVisible.value = false
  }

  return {
    // State
    sidebarOpen,
    sidebarWidth,
    theme,
    showSettings,
    activePanel,
    notificationMessage,
    notificationType,
    isNotificationVisible,
    notificationAction,
    // Methods
    toggleSidebar,
    setSidebarWidth,
    setTheme,
    toggleSettings,
    setActivePanel,
    showNotification,
    hideNotification,
    // Context menu
    contextMenuVisible,
    contextMenuX,
    contextMenuY,
    contextMenuItems,
    showContextMenu,
    hideContextMenu,
    // Layout
    voicePanelOpen,
    memberListOpen,
    emojiPickerAnchor,
    emojiPickerTarget,
    mobilePanelView,
    setMobilePanelView,
    // Modals
    showServerCreateModal,
    showJoinModal,
    showInviteModal,
    inviteServerId,
    openInviteModal,
    showDeviceLinkModal,
    openDeviceLinkModal,
    showServerSettingsModal,
    settingsServerId,
    openServerSettings,
    showJoinCapsuleModal,
    joinCapsuleServerId,
    openJoinCapsuleModal,
    // User profile
    showUserProfile,
    userProfileUserId,
    userProfileServerId,
    userProfileReadOnly,
    openUserProfile,
    closeUserProfile,
    // Source picker
    sourcePickerOpen,
    openSourcePicker,
    closeSourcePicker,
    // Alert modal
    alertTitle,
    alertMessage,
    alertVisible,
    showAlert,
    dismissAlert,
  };
});
