import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AvatarImage from '../AvatarImage.vue'

vi.mock('@/utils/imageCache', () => ({
  resolveImageHash: vi.fn(),
}))

import { resolveImageHash } from '@/utils/imageCache'
const mockedResolve = resolveImageHash as ReturnType<typeof vi.fn>

describe('AvatarImage', () => {
  beforeEach(() => {
    mockedResolve.mockReset()
  })

  it('renders initials when no src and no hash', () => {
    const wrapper = mount(AvatarImage, { props: { name: 'Alice Bob' } })
    expect(wrapper.find('.avatar-initials').text()).toBe('AB')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('renders img when src is provided (backward compat)', () => {
    const wrapper = mount(AvatarImage, {
      props: { src: 'data:image/png;base64,abc', name: 'Test' },
    })
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,abc')
  })

  it('resolves hash via imageCache and renders img', async () => {
    mockedResolve.mockResolvedValueOnce('data:image/png;base64,resolved')

    const wrapper = mount(AvatarImage, {
      props: { hash: 'deadbeef', name: 'Hash User' },
    })

    expect(mockedResolve).toHaveBeenCalledWith('deadbeef')

    await flushPromises()

    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,resolved')
  })

  it('shows initials when hash resolves to null', async () => {
    mockedResolve.mockResolvedValueOnce(null)

    const wrapper = mount(AvatarImage, {
      props: { hash: 'missing', name: 'No Avatar' },
    })

    await flushPromises()

    expect(wrapper.find('.avatar-initials').text()).toBe('NA')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('prefers hash over src when both provided', async () => {
    mockedResolve.mockResolvedValueOnce('data:image/png;base64,from-hash')

    const wrapper = mount(AvatarImage, {
      props: { src: 'data:image/png;base64,from-src', hash: 'abc', name: 'T' },
    })

    await flushPromises()

    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,from-hash')
  })
})
