import { describe, expect, it } from 'vitest'

import {
  isIosSafari,
  isMobileOrTabletDevice,
  isStandalonePwa,
} from './device'

const noMediaMatches = () => false
const touchMediaMatches = (query: string) =>
  query === '(pointer: coarse)' || query === '(hover: none)'

describe('isMobileOrTabletDevice', () => {
  it.each([
    [
      'Android 手机',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    ],
    [
      'Android 平板',
      'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    ],
    [
      'iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1',
    ],
    [
      'iPad',
      'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1',
    ],
  ])('%s 命中（手机 / 平板）', (_label, userAgent) => {
    expect(
      isMobileOrTabletDevice(
        { userAgent, maxTouchPoints: 5 },
        noMediaMatches
      )
    ).toBe(true)
  })

  it('iPadOS 桌面 UA 通过触控点识别为平板', () => {
    expect(
      isMobileOrTabletDevice(
        {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15',
          maxTouchPoints: 5,
        },
        noMediaMatches
      )
    ).toBe(true)
  })

  it.each([
    [
      'macOS 桌面',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      0,
    ],
    [
      'Windows 桌面',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      10,
    ],
  ])('%s 不命中', (_label, userAgent, maxTouchPoints) => {
    expect(
      isMobileOrTabletDevice(
        { userAgent, maxTouchPoints },
        noMediaMatches
      )
    ).toBe(false)
  })

  it('触控笔记本仍有 hover 时不按平板处理', () => {
    expect(
      isMobileOrTabletDevice(
        {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
          maxTouchPoints: 10,
        },
        (query) => query === '(pointer: coarse)'
      )
    ).toBe(false)
  })

  it('无常规 UA 的触控设备按粗指针 + 无 hover 兜底识别', () => {
    expect(
      isMobileOrTabletDevice(
        {
          userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
          maxTouchPoints: 5,
        },
        touchMediaMatches
      )
    ).toBe(true)
  })

  it('优先信任 userAgentData.mobile', () => {
    expect(
      isMobileOrTabletDevice(
        { userAgent: 'CustomBrowser/1.0', userAgentData: { mobile: true } },
        noMediaMatches
      )
    ).toBe(true)
  })
})

describe('isStandalonePwa', () => {
  it('识别 display-mode: standalone', () => {
    expect(
      isStandalonePwa(
        { userAgent: 'Android' },
        (query) => query === '(display-mode: standalone)'
      )
    ).toBe(true)
  })

  it('识别 iOS navigator.standalone', () => {
    expect(
      isStandalonePwa(
        { userAgent: 'iPhone', standalone: true },
        noMediaMatches
      )
    ).toBe(true)
  })
})

describe('isIosSafari', () => {
  it('识别 iPhone / iPad Safari', () => {
    expect(
      isIosSafari({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1',
      })
    ).toBe(true)
  })

  it('排除 iOS 上的 Chrome / Firefox / Edge', () => {
    for (const browser of ['CriOS', 'FxiOS', 'EdgiOS']) {
      expect(
        isIosSafari({
          userAgent: `Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 ${browser}/131.0 Mobile/15E148 Safari/604.1`,
        })
      ).toBe(false)
    }
  })

  it('桌面 Safari 不算移动安装场景', () => {
    expect(
      isIosSafari({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15',
        maxTouchPoints: 0,
      })
    ).toBe(false)
  })
})
