import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  TERMINAL_RAIL_WIDTH,
  TERMINAL_TOP_STRIP_HEIGHT,
} from './terminal-constants'
import { TerminalRail } from './terminal-rail'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { TrendingUp } from 'lucide-react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
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
    // 常量契约：顶部基准带跟随 Header 高度（48），而非 Rail 宽度
    expect(TERMINAL_TOP_STRIP_HEIGHT).not.toBe(TERMINAL_RAIL_WIDTH)
  })
})
