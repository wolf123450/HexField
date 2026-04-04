import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/utils/twemoji', () => ({ codepointToChar: (s: string) => s }))

import MessageBubble from '../MessageBubble.vue'
import type { Message } from '@/types/core'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id:          'msg-1',
    channelId:   'ch-1',
    serverId:    'srv-1',
    authorId:    'user-alice',
    content:     'Hello world',
    contentType: 'text',
    attachments: [],
    reactions:   [],
    isEdited:    false,
    logicalTs:   '1000-000000',
    createdAt:   new Date().toISOString(),
    verified:    true,
    ...overrides,
  }
}

function mountBubble(message: Message, myUserId: string, roles: string[] = []) {
  return mount(MessageBubble, {
    props: { message, showHeader: true },
    global: {
      stubs: {
        AppIcon:       true,
        AvatarImage:   true,
        MessageContent: true,
        ReactionBar:   true,
        EmojiPicker:   true,
      },
      plugins: [
        createTestingPinia({
          initialState: {
            identity: { userId: myUserId, displayName: 'Me', avatarDataUrl: null },
            servers:  {
              members: {
                'srv-1': {
                  [myUserId]: { userId: myUserId, displayName: 'Me', roles },
                },
              },
            },
            emoji:    { topEmoji: [], imageCache: {} },
            settings: { settings: { confirmBeforeDelete: false, showDeletedMessagePlaceholder: true } },
            ui:       {},
          },
          createSpy: vi.fn,
        }),
      ],
    },
  })
}

describe('MessageBubble permission guard', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows edit and delete buttons when message belongs to current user', async () => {
    const wrapper = mountBubble(makeMessage({ authorId: 'user-alice' }), 'user-alice')
    await wrapper.find('.message-bubble').trigger('mouseenter')
    expect(wrapper.find('button[title="Edit message"]').exists()).toBe(true)
    expect(wrapper.find('button[title="Delete message"]').exists()).toBe(true)
  })

  it('hides edit button when message belongs to another user', async () => {
    const wrapper = mountBubble(makeMessage({ authorId: 'user-bob' }), 'user-alice')
    await wrapper.find('.message-bubble').trigger('mouseenter')
    expect(wrapper.find('button[title="Edit message"]').exists()).toBe(false)
  })

  it('hides delete button for another user\'s message when current user is not admin', async () => {
    const wrapper = mountBubble(makeMessage({ authorId: 'user-bob' }), 'user-alice', [])
    await wrapper.find('.message-bubble').trigger('mouseenter')
    expect(wrapper.find('button[title="Delete message"]').exists()).toBe(false)
  })

  it('shows delete button for another user\'s message when current user is admin', async () => {
    const wrapper = mountBubble(makeMessage({ authorId: 'user-bob' }), 'user-alice', ['admin'])
    await wrapper.find('.message-bubble').trigger('mouseenter')
    expect(wrapper.find('button[title="Delete message"]').exists()).toBe(true)
  })

  it('shows delete button for another user\'s message when current user is owner', async () => {
    const wrapper = mountBubble(makeMessage({ authorId: 'user-bob' }), 'user-alice', ['owner'])
    await wrapper.find('.message-bubble').trigger('mouseenter')
    expect(wrapper.find('button[title="Delete message"]').exists()).toBe(true)
  })
})
