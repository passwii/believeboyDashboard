import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, within, cleanup } from '@testing-library/react'

import { AdAnalysisTabNav } from '@/components/dashboard/ad-analysis/tab-nav'

// ── mocks ────────────────────────────────────────────────────────────────────

let mockPathname = '/dashboard/advertising/ad-analysis/overview'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams('projectId=1&country=US'),
}))

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode
    href: string
    [key: string]: unknown
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('@/components/dashboard/route-loading-link', () => ({
  RouteLoadingLink: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode
    href: string
    [key: string]: unknown
  }) => (
    <a href={href} data-testid="route-link" {...rest}>
      {children}
    </a>
  ),
}))

afterEach(() => {
  cleanup()
})

/** 在 nav 容器内取 tab 链接（避免跨测试残留 DOM 干扰 getByText） */
function getTab(label: string): HTMLAnchorElement {
  const nav = screen.getByLabelText('广告分析子页面')
  return within(nav).getByText(label).closest('a') as HTMLAnchorElement
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AdAnalysisTabNav Warm Ledger 子 Tab 栏', () => {
  it('渲染全部 tab 且激活项带 aria-current 与底部 accent 指示条', () => {
    render(<AdAnalysisTabNav />)
    const nav = screen.getByLabelText('广告分析子页面')
    expect(nav).toBeTruthy()
    expect(nav).toHaveAttribute('data-warm-tablist', 'true')

    const active = getTab('总览')
    expect(active.getAttribute('aria-current')).toBe('page')

    // 激活指示条：绝对定位的 2px accent 条，不占布局空间（切换零抖动）
    const indicator = active.querySelector('span[aria-hidden]')
    expect(indicator).toBeTruthy()
    expect(indicator!.className).not.toContain('term-')
    expect(indicator!.className).not.toContain('rounded-none')

    // 非激活项无 aria-current、无指示条
    const inactive = getTab('活动')
    expect(inactive.getAttribute('aria-current')).toBeNull()
    expect(inactive.querySelector('span[aria-hidden]')).toBeNull()
  })

  it('tab 链接携带当前筛选 search params', () => {
    render(<AdAnalysisTabNav />)
    const link = getTab('活动')
    expect(link.getAttribute('href')).toBe(
      '/dashboard/advertising/ad-analysis/campaigns?projectId=1&country=US'
    )
  })

  it('路径变化时激活态跟随', () => {
    mockPathname = '/dashboard/advertising/ad-analysis/search-terms'
    render(<AdAnalysisTabNav />)
    const active = getTab('搜索词')
    expect(active.getAttribute('aria-current')).toBe('page')
  })

  it('tab 和页面壳只使用 Warm tokens，手机断点只新增 640px 适配', () => {
    const css = readFileSync(
      resolve(
        process.cwd(),
        'app/dashboard/advertising/ad-analysis/ad-analysis-warm.module.css'
      ),
      'utf8'
    )
    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-focus-color)')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('rounded-none')
    expect(css).toContain('@media (max-width: 640px)')
    const media = css.match(/@media\s*\([^)]*\)/g) ?? []
    for (const rule of media) {
      expect([
        '@media (prefers-reduced-motion: reduce)',
        '@media (max-width: 640px)',
      ]).toContain(rule)
    }
  })
})
