import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MobileStripMount,
  TerminalHeaderSlotProvider,
  useHeaderSlot,
  useMobileFilterStrip,
} from './terminal-header-slot'
import { useIsMobile } from '@/hooks/use-mobile'

/**
 * BLF-933 · 移动端筛选条挂载机制测试：
 * - MobileStripMount 注册正文顶部挂载点（md:hidden，仅 <768px 可见）
 * - useMobileFilterStrip：isMobile 时 portal 进正文顶部；桌面端返回 null（零影响）
 * - 与 useHeaderSlot 并存互不干扰
 */

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockIsMobile = vi.mocked(useIsMobile)

/** 模拟 TerminalShell 正文：挂 MobileStripMount（main 顶部）+ 页面内容 */
function FakeBody({ children }: { children?: React.ReactNode }) {
  return (
    <main data-testid="fake-main">
      <MobileStripMount />
      <div data-testid="page-content">{children}</div>
    </main>
  )
}

/** 模拟页面：同时注册桌面端 header 插槽 + 移动端筛选条 */
function Page({
  desktopSlot,
  mobileStrip,
}: {
  desktopSlot?: React.ReactNode
  mobileStrip?: React.ReactNode
}) {
  const headerPortal = useHeaderSlot(desktopSlot ?? null)
  const stripPortal = useMobileFilterStrip(mobileStrip ?? null)
  return (
    <div data-testid="page">
      {headerPortal}
      {stripPortal}
    </div>
  )
}

function Harness({ children }: { children?: React.ReactNode }) {
  return (
    <TerminalHeaderSlotProvider>
      <FakeBody>{children}</FakeBody>
    </TerminalHeaderSlotProvider>
  )
}

function renderShell(ui: React.ReactNode) {
  return render(<Harness>{ui}</Harness>)
}

beforeEach(() => {
  mockIsMobile.mockReturnValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MobileStripMount', () => {
  it('注册正文顶部挂载点，md:hidden 仅移动端可见', () => {
    renderShell(<Page />)
    const mount = screen.getByTestId('terminal-mobile-strip')
    expect(mount).toBeInTheDocument()
    expect(mount).toHaveClass('md:hidden')
    // 挂载点在 main 内、页面内容之前（正文顶部）
    const main = screen.getByTestId('fake-main')
    expect(main).toContainElement(mount)
    expect(main.compareDocumentPosition(mount) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('useMobileFilterStrip', () => {
  it('isMobile 时：折叠条 portal 进正文顶部挂载点', async () => {
    mockIsMobile.mockReturnValue(true)
    renderShell(
      <Page mobileStrip={<div data-testid="mobile-strip-content">移动端筛选条</div>} />
    )

    await waitFor(() => {
      expect(screen.getByTestId('terminal-mobile-strip')).toHaveTextContent('移动端筛选条')
    })
    // 内容确实在挂载点 DOM 内，不在页面组件树里
    expect(screen.getByTestId('fake-main')).toContainElement(
      screen.getByTestId('mobile-strip-content')
    )
  })

  it('桌面端（非 isMobile）：不渲染任何内容，header 插槽不受影响', async () => {
    mockIsMobile.mockReturnValue(false)
    renderShell(
      <Page
        desktopSlot={<span>桌面端筛选</span>}
        mobileStrip={<div data-testid="mobile-strip-content">移动端筛选条</div>}
      />
    )

    // 移动端内容完全没有渲染
    expect(screen.queryByTestId('mobile-strip-content')).not.toBeInTheDocument()
    expect(screen.getByTestId('terminal-mobile-strip')).toBeEmptyDOMElement()
  })

  it('isMobile 变化时：从移动端形态切换回桌面端，内容自动清除', async () => {
    mockIsMobile.mockReturnValue(true)
    const { unmount } = renderShell(
      <Page mobileStrip={<div data-testid="mobile-strip-content">移动端筛选条</div>} />
    )
    await waitFor(() => {
      expect(screen.getByTestId('terminal-mobile-strip')).toHaveTextContent('移动端筛选条')
    })

    // 视口切到桌面：unmount 后重新挂载，内容应清除
    mockIsMobile.mockReturnValue(false)
    unmount()
    const second = render(
      <Harness>
        <Page mobileStrip={<div data-testid="mobile-strip-content">移动端筛选条</div>} />
      </Harness>
    )
    expect(second.queryByTestId('mobile-strip-content')).not.toBeInTheDocument()
    expect(second.getByTestId('terminal-mobile-strip')).toBeEmptyDOMElement()
    second.unmount()
  })

  it('挂载点未就绪（SSR / 首帧）时返回 null，不抛错', async () => {
    mockIsMobile.mockReturnValue(true)
    // 不挂 MobileStripMount：anchor 为 null
    render(
      <TerminalHeaderSlotProvider>
        <Page mobileStrip={<div data-testid="mobile-strip-content">移动端筛选条</div>} />
      </TerminalHeaderSlotProvider>
    )
    expect(screen.queryByTestId('mobile-strip-content')).not.toBeInTheDocument()
  })
})
