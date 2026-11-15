import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PWA_INSTALL_DISMISSED_KEY,
  PWA_PROMPT_AVAILABLE_EVENT,
  PwaInstallPrompt,
} from './pwa-install-prompt'

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1'
const IPAD_SAFARI_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

type NavigatorStubOptions = {
  userAgent: string
  maxTouchPoints?: number
  standalone?: boolean
  mobileHint?: boolean
}

function stubNavigator({
  userAgent,
  maxTouchPoints = 0,
  standalone,
  mobileHint,
}: NavigatorStubOptions) {
  const register = vi.fn().mockResolvedValue(undefined)

  vi.stubGlobal('navigator', {
    userAgent,
    maxTouchPoints,
    standalone,
    userAgentData: mobileHint === undefined ? undefined : { mobile: mobileHint },
    serviceWorker: { register },
  })

  return register
}

function stubMatchMedia(matches: (query: string) => boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: matches(query),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  )
}

function createPromptEvent(
  outcome: 'accepted' | 'dismissed' = 'accepted'
) {
  const prompt = vi.fn().mockResolvedValue(undefined)
  const event = Object.assign(new Event('beforeinstallprompt'), {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
    platforms: ['web'],
  }) as BeforeInstallPromptEvent

  return { event, prompt }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  delete window.__believeboyPwaPrompt
})

describe('PwaInstallPrompt', () => {
  it('桌面即使收到安装事件也不渲染入口、不注册 service worker', async () => {
    const register = stubNavigator({ userAgent: MAC_UA, maxTouchPoints: 0 })
    stubMatchMedia(() => false)
    const { event } = createPromptEvent()
    window.__believeboyPwaPrompt = event

    render(<PwaInstallPrompt />)

    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument()
    expect(register).not.toHaveBeenCalled()
  })

  it('Android 手机捕获安装事件后显示安装按钮并调用浏览器 prompt', async () => {
    const register = stubNavigator({ userAgent: ANDROID_UA, maxTouchPoints: 5 })
    stubMatchMedia(() => false)
    const { event, prompt } = createPromptEvent()
    window.__believeboyPwaPrompt = event

    render(<PwaInstallPrompt />)

    expect(await screen.findByTestId('pwa-install-prompt')).toBeInTheDocument()
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })

    await userEvent.click(screen.getByRole('button', { name: '安装' }))

    expect(prompt).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument()
    )
  })

  it('安装事件晚于组件挂载时仍会显示', async () => {
    stubNavigator({ userAgent: ANDROID_UA, maxTouchPoints: 5 })
    stubMatchMedia(() => false)
    render(<PwaInstallPrompt />)
    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument()

    const { event } = createPromptEvent()
    act(() => {
      window.__believeboyPwaPrompt = event
      window.dispatchEvent(new Event(PWA_PROMPT_AVAILABLE_EVENT))
    })

    expect(await screen.findByTestId('pwa-install-prompt')).toBeInTheDocument()
  })

  it('iPad Safari 显示添加到主屏幕指引', async () => {
    stubNavigator({ userAgent: IPAD_SAFARI_UA, maxTouchPoints: 5 })
    stubMatchMedia(() => false)

    render(<PwaInstallPrompt />)

    expect(await screen.findByTestId('pwa-install-prompt')).toHaveTextContent(
      '在 Safari 中点「分享」，再选择「添加到主屏幕」'
    )
    expect(
      screen.queryByRole('button', { name: '安装' })
    ).not.toBeInTheDocument()
  })

  it('iPadOS 桌面 UA 的 Safari 也会显示安装指引', async () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15',
      maxTouchPoints: 5,
    })
    stubMatchMedia(() => false)

    render(<PwaInstallPrompt />)

    expect(await screen.findByTestId('pwa-install-prompt')).toBeInTheDocument()
  })

  it('已处于 standalone 模式时不再提示', () => {
    stubNavigator({ userAgent: IPHONE_SAFARI_UA, maxTouchPoints: 5 })
    stubMatchMedia((query) => query === '(display-mode: standalone)')

    render(<PwaInstallPrompt />)

    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument()
  })

  it('关闭后本次会话不再提示', async () => {
    stubNavigator({ userAgent: IPHONE_SAFARI_UA, maxTouchPoints: 5 })
    stubMatchMedia(() => false)

    render(<PwaInstallPrompt />)
    await userEvent.click(screen.getByRole('button', { name: '关闭安装提示' }))

    expect(screen.queryByTestId('pwa-install-prompt')).not.toBeInTheDocument()
    expect(sessionStorage.getItem(PWA_INSTALL_DISMISSED_KEY)).toBe('1')
  })
})
