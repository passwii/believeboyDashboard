import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_RAIL_WIDTH,
  TERMINAL_TOP_STRIP_HEIGHT,
  TERMINAL_RAIL_ICON_SIZE,
} from './terminal-constants'
import { TerminalRail } from './terminal-rail'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { TrendingUp } from 'lucide-react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }),
}))

const GROUPS: SidebarTopGroup[] = [
  {
    id: 'operations',
    label: '运营',
    icon: TrendingUp,
    accent: '',
    activeAccent: '',
    items: [
      { title: '销售数据', url: '/dashboard/operations/daily-analysis' },
    ],
  },
]

describe('TerminalRail', () => {
  it('BLF-832 Logo 位高度引用顶部基准带常量（不再借用 Rail 宽度）', () => {
    const { container } = render(
      <TerminalRail groups={GROUPS} activeGroupId="operations" onGroupNavigate={vi.fn()} />
    )
    const logoSlot = container.querySelector('aside > div:first-child') as HTMLElement
    expect(logoSlot.style.height).toBe(`${TERMINAL_TOP_STRIP_HEIGHT}px`)
    // 常量契约：顶部基准带跟随 Header 高度（56），而非 Rail 宽度
    expect(TERMINAL_TOP_STRIP_HEIGHT).not.toBe(TERMINAL_RAIL_WIDTH)
  })

  it('BLF-1075 logo 块整格满铺：按钮 h-full w-full，容器无居中留白', () => {
    const { container } = render(
      <TerminalRail groups={GROUPS} activeGroupId="operations" onGroupNavigate={vi.fn()} />
    )
    const logoSlot = container.querySelector('aside > div:first-child') as HTMLElement
    const logoButton = logoSlot.querySelector('button') as HTMLElement

    // 容器不再用 items-center / justify-center 把固定尺寸的小方块居中（旧 h-10 w-10 四周留白）
    expect(logoSlot.className).not.toContain('items-center')
    expect(logoSlot.className).not.toContain('justify-center')
    // 容器与按钮均无 padding（Tailwind 间距类一个都不许出现，含 px-0/p-0 这类无实际留白的写法）
    for (const cls of [logoSlot.className, logoButton.className]) {
      expect(cls, cls).not.toMatch(/\b(?:p|px|py|pt|pb|pl|pr)-\S+/)
    }

    // 按钮撑满整个左上角方块（宽度 = Rail 宽度，高度 = 顶部基准带），四边贴合零间隙
    expect(logoButton.className).toContain('h-full')
    expect(logoButton.className).toContain('w-full')
    // 不再有固定尺寸旧档（h-10 w-10 会在容器内留下 12px / 8px 空隙）
    expect(logoButton.className).not.toMatch(/\b[hw]-10\b/)

    // 面板分割线对齐契约（BLF-832）不被本次改动破坏：格高仍等于顶部基准带
    expect(logoSlot.style.height).toBe(`${TERMINAL_TOP_STRIP_HEIGHT}px`)
  })

  it('主题选择入口提供三态设置的可访问名称', () => {
    const { container } = render(
      <TerminalRail groups={GROUPS} activeGroupId="operations" onGroupNavigate={vi.fn()} />
    )
    const themeButton = container.querySelector('aside > div:last-child > button:first-child')
    expect(themeButton).toHaveAttribute('aria-label', '主题设置：浅色')
  })

  it('BLF-850 Rail 图标尺寸引用单一常量 TERMINAL_RAIL_ICON_SIZE（内联 style，非动态类）', () => {
    const { container } = render(
      <TerminalRail groups={GROUPS} activeGroupId="operations" onGroupNavigate={vi.fn()} />
    )
    // 业务域图标（L1 Rail 主轨）：经内联 style 应用（Tailwind JIT 不编译模板字符串拼出的类）
    const domainIcon = container.querySelector('#main-navigation svg') as HTMLElement
    expect(domainIcon.style.height).toBe(`${TERMINAL_RAIL_ICON_SIZE}px`)
    expect(domainIcon.style.width).toBe(`${TERMINAL_RAIL_ICON_SIZE}px`)
    // 主题切换图标（底部）
    const themeIcon = container.querySelector('aside > div:last-child > button:first-child svg') as HTMLElement
    expect(themeIcon.style.height).toBe(`${TERMINAL_RAIL_ICON_SIZE}px`)
    expect(themeIcon.style.width).toBe(`${TERMINAL_RAIL_ICON_SIZE}px`)
    expect(themeIcon.getAttribute('stroke-width')).toBe('1.75')
    // 常量已上档（BLF-887），不再是早期写死的 18px
    expect(TERMINAL_RAIL_ICON_SIZE).not.toBe(18)
  })
})
