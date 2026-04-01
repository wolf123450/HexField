# Spec 04 — UI Architecture

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Layout — 4-Column Discord-style

```
┌──────────────────────────────────────────────────────────────────────┐
│ TitleBar (frameless, drag region)                     [─] [□] [×]    │
├──────┬────────────┬───────────────────────────┬──────────────────────┤
│      │            │                           │                      │
│  S   │  Channel   │   MessageHistory          │  MemberList          │
│  e   │  Sidebar   │   (virtual scroll)        │  (collapsible)       │
│  r   │            │                           │                      │
│  v   │  # general │   [Avatar] UserName 2:34  │  ONLINE              │
│  e   │  # random  │   Hello everyone!         │    Alice             │
│  r   │  ────────  │                           │    Bob               │
│  R   │  🔊 gaming │   [Avatar] Alice 2:36     │  OFFLINE             │
│  a   │  🔊 music  │   Hey! 👍                 │    Charlie           │
│  i   │            │   ┌──────────────────┐    │                      │
│  l   │            │   │ MessageInput     │    │                      │
│      │            │   │  📎  😀  [Send]  │    │                      │
│      │            │   └──────────────────┘    │                      │
├──────┴────────────┴───────────────────────────┴──────────────────────┤
│ VoiceBar: 🔇 📹 🖥  Alice  [Disconnect]      (shown while in voice) │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Tree

```
App.vue
├── TitleBar.vue                      (extend skeleton: show server name)
├── div.app-layout (CSS Grid)
│   ├── ServerRail.vue                NEW — replaces Sidebar.vue
│   │   ├── ServerIcon.vue × N        (avatar pill, active indicator, unread badge)
│   │   ├── AddServerButton.vue
│   │   └── UserStatusBadge.vue
│   │
│   ├── ChannelSidebar.vue            NEW
│   │   ├── ServerHeader.vue
│   │   ├── ChannelCategory.vue × N
│   │   │   └── ChannelItem.vue × N
│   │   └── SelfPanel.vue             (mute/deafen/settings at bottom)
│   │
│   ├── MainPane.vue                  NEW
│   │   ├── ChannelHeader.vue
│   │   ├── MessageHistory.vue
│   │   │   ├── VirtualList (TanStack Virtual)
│   │   │   │   └── MessageGroup.vue → MessageBubble.vue
│   │   │   │       ├── MessageContent.vue
│   │   │   │       ├── AttachmentPreview.vue
│   │   │   │       └── ReactionBar.vue
│   │   │   └── TypingIndicator.vue
│   │   └── MessageInput.vue
│   │       ├── AttachmentButton.vue
│   │       └── EmojiButton.vue
│   │
│   └── MemberList.vue                NEW (collapsible right panel)
│       └── MemberRow.vue × N
│
├── VoiceBar.vue                      NEW (bottom strip, v-if session)
│   └── VoicePeerTile.vue × N         (speaking ring animation, screen share preview)
│
├── EmojiPicker.vue                   NEW (Teleport to body)
├── ServerCreateModal.vue             NEW (Teleport to body)
├── InviteModal.vue                   NEW (Teleport to body)
├── ScreenSharePicker.vue             NEW (Teleport to body, Phase 5 — Windows only if chromeMediaSourceId works)
├── Settings.vue                      (extend skeleton shell)
│   ├── SettingsProfileTab.vue        NEW
│   ├── SettingsVoiceTab.vue          NEW (device picker, TURN config)
│   ├── SettingsPrivacyTab.vue        NEW (key management, deletion behaviour, storage limit)
│   ├── SettingsNotificationsTab.vue  NEW
│   ├── SettingsAppearanceTab.vue     (existing)
│   └── SettingsShortcutsTab.vue      (existing)
├── Notification.vue                  (extend skeleton)
└── ContextMenu.vue                   (unchanged)
```

---

## 3. CSS Layout

Extend `src/styles/global.css` — keep all existing CSS variables, add:

```css
:root {
  --server-rail-width:      72px;
  --channel-sidebar-width:  240px;
  --member-list-width:      240px;
  --voice-bar-height:        52px;
}

.app-layout {
  display: grid;
  grid-template-columns:
    var(--server-rail-width)
    var(--channel-sidebar-width)
    1fr
    var(--member-list-active-width, var(--member-list-width));
  grid-template-rows: 1fr auto;
  height: calc(100vh - var(--titlebar-height, 32px));
}

/* Member list collapse: toggle CSS class, no JS layout recomputation */
.app-layout.member-list-hidden {
  --member-list-active-width: 0px;
}
```

---

## 4. Virtual Scrolling (MessageHistory.vue)

Use **TanStack Virtual** (`@tanstack/virtual-core`) for virtual rendering of message lists. TanStack is headless — we own the scroll container and row rendering.

```typescript
import { useVirtualizer } from '@tanstack/vue-virtual'

const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => scrollContainerRef.value,
  estimateSize: () => 60,          // estimated row height; measured after mount
  overscan: 5,
})
```

Key behaviours:
- **Stick-to-bottom**: watch `messages.length`; if user was at bottom, call `virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })` after render
- **Load-more on scroll-up**: IntersectionObserver on top sentinel triggers `messagesStore.loadMessages(channelId, cursor)`
- **Variable heights**: `measureElement` callback feeds real row heights back after mount
- **Message grouping**: consecutive same-author messages within 5 minutes share one avatar header; computed in `messagesStore` before passing to virtualizer

---

## 5. Deleted Message Rendering

**Default**: deleted messages (`message.content === null`) are omitted from the rendered list entirely.

**Optional placeholder** (Settings → Privacy → "Show deleted message indicator"):

```vue
<!-- MessageBubble.vue -->
<template v-if="message.content === null">
  <div v-if="settingsStore.showDeletedMessagePlaceholder" class="message-deleted">
    <span class="deleted-label">message deleted</span>
  </div>
  <!-- else: render nothing at all -->
</template>
```

The tombstone shows no author, no timestamp, no "by whom". Defaults to **off**.

---

## 6. Privacy Settings Tab

`SettingsPrivacyTab.vue` must include this plain-language explanation:

> **How message deletion works**
>
> When you delete a message, GameChat immediately erases the message content on your device and sends a delete notice to all currently online members. Each member's app erases the content from their device when they receive the notice. Members who are offline will have the content erased the next time they connect.
>
> Because GameChat is peer-to-peer, deleted content cannot be recovered from any GameChat server — there isn't one. However, peers who received your message before the delete notice arrived may retain a copy if they are running a modified version of the app. GameChat makes a good-faith effort to delete content on all connected devices but cannot guarantee deletion on non-standard clients.

Settings in this tab:
- `[ ]` Show "message deleted" placeholder *(default: off)*
- `[x]` Confirm before deleting a message *(default: on)*
- Storage limit slider: 1–10 GB *(default: 5 GB)*
- Storage usage display (current usage vs limit)
- Key management: export identity, link new device, revoke device

---

## 7. Router Setup — `src/router/index.ts`

```typescript
const routes = [
  { path: '/',              component: MainLayout },   // 4-column layout
  { path: '/setup',         component: SetupWizard },  // first-launch identity creation
  { path: '/join/:code',    component: JoinServer },   // deep-link join flow
  { path: '/pair/:token',   component: PairDevice },   // deep-link device pairing
]
```
