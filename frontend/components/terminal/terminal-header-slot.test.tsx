import * as React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'

import {
  HeaderSlotMount,
  TerminalHeaderSlotProvider,
  useHeaderRefresh,
  useHeaderSlot,
  useTerminalHeaderSlot,
} from './terminal-header-slot'

/** 探针：把 context 当前值渲染到 DOM，供断言 */
function Probe() {
  const ctx = useTerminalHeaderSlot()
  return (
    <div>
      <span data-testid="has-anchor">{ctx.anchor == null ? 'none' : 'present'}</span>
      <span data-testid="refresh-registered">{String(ctx.refreshRegistered)}</span>
      <span data-testid="refresh-loading">{String(ctx.refreshLoading)}</span>
      <span role="status" data-testid="refresh-announcement">{ctx.refreshFeedback.message}</span>
      <button type="button" onClick={ctx.triggerRefresh}>
        trigger
      </button>
    </div>
  )
}

/**
 * 模拟 TerminalHeader：挂 HeaderSlotMount（真实容器），页面内容会 portal 进来。
 */
function FakeHeader() {
  return (
    <header data-testid="fake-header">
      <HeaderSlotMount className="flex items-center gap-1.5" />
    </header>
  )
}

/** 模拟页面：portal 筛选控件进 head + 注册刷新回调 */
function Page({
  slotContent,
  onRefresh,
  loading,
}: {
  slotContent?: React.ReactNode
  onRefresh?: () => void
  loading?: boolean
}) {
  const portal = useHeaderSlot(slotContent ?? null)
  // hooks 规则：useHeaderRefresh 不能条件调用；onRefresh 为空时注册 no-op handler，
  // loading 也归零 —— 行为上等价于旧的条件注册（无回调时按钮不触发任何动作）。
  const noopRef = useRef(() => {})
  const handlerRef = useRef(onRefresh ?? (() => {}))
  handlerRef.current = onRefresh ?? (() => {})
  useHeaderRefresh(onRefresh ? handlerRef.current : noopRef.current, {
    loading: onRefresh ? loading : false,
  })
  return <div data-testid="page">{portal}</div>
}

/**
 * 稳定测试外壳：rerender 时保持同一根组件，避免整树卸载重建。
 */
function Harness({ children }: { children?: React.ReactNode }) {
  return (
    <TerminalHeaderSlotProvider>
      <FakeHeader />
      {children}
    </TerminalHeaderSlotProvider>
  )
}

function renderShell(ui: React.ReactNode) {
  return render(<Harness>{ui}</Harness>)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalHeaderSlotProvider', () => {
  it('初始状态：anchor 就绪、刷新未注册、非 loading', () => {
    renderShell(<Probe />)
    expect(screen.getByTestId('has-anchor')).toHaveTextContent('present')
    expect(screen.getByTestId('terminal-header-slot')).toBeInTheDocument()
    expect(screen.getByTestId('refresh-registered')).toHaveTextContent('false')
    expect(screen.getByTestId('refresh-loading')).toHaveTextContent('false')
  })

  it('useHeaderSlot 把控件 portal 进 head；页面 unmount 自动清除', async () => {
    const { unmount } = renderShell(<Page slotContent={<span>项目筛选控件</span>} />)
    const slot = screen.getByTestId('terminal-header-slot')
    await waitFor(() => expect(slot).toHaveTextContent('项目筛选控件'))
    // portal 内容确实在 header 容器 DOM 内
    expect(screen.getByTestId('fake-header')).toContainElement(slot)

    unmount()
    // 重挂后无残留
    render(
      <TerminalHeaderSlotProvider>
        <FakeHeader />
        <Probe />
      </TerminalHeaderSlotProvider>
    )
    expect(screen.getByTestId('terminal-header-slot')).toBeEmptyDOMElement()
  })

  it('slot 内容变化时同步更新（受控 state 实时反映）', async () => {
    const { rerender } = renderShell(<Page slotContent={<span>A</span>} />)
    await waitFor(() =>
      expect(screen.getByTestId('terminal-header-slot')).toHaveTextContent('A')
    )
    rerender(
      <Harness>
        <Page slotContent={<span>B</span>} />
      </Harness>
    )
    await waitFor(() =>
      expect(screen.getByTestId('terminal-header-slot')).toHaveTextContent('B')
    )
  })

  it('triggerRefresh 调用已注册的 handler；未注册时 no-op 不抛错', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()

    const { unmount } = renderShell(
      <>
        <Page onRefresh={handler} />
        <Probe />
      </>
    )
    await waitFor(() =>
      expect(screen.getByTestId('refresh-registered')).toHaveTextContent('true')
    )
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(handler).toHaveBeenCalledTimes(1)

    // 卸载整棵树 → 重新挂 Provider 验证注册已随 unmount 清理
    unmount()
    const second = render(
      <TerminalHeaderSlotProvider>
        <FakeHeader />
        <Probe />
      </TerminalHeaderSlotProvider>
    )
    expect(second.getByTestId('refresh-registered')).toHaveTextContent('false')
    await user.click(second.getByRole('button', { name: 'trigger' }))
    expect(handler).toHaveBeenCalledTimes(1)
    second.unmount()
  })

  it('useHeaderRefresh 的 loading 上报反映到 context；卸载时复位', async () => {
    const { rerender, unmount } = renderShell(
      <>
        <Page onRefresh={() => {}} loading />
        <Probe />
      </>
    )
    await waitFor(() => expect(screen.getByTestId('refresh-loading')).toHaveTextContent('true'))

    rerender(
      <Harness>
        <Page onRefresh={() => {}} loading={false} />
        <Probe />
      </Harness>
    )
    await waitFor(() => expect(screen.getByTestId('refresh-loading')).toHaveTextContent('false'))

    rerender(
      <Harness>
        <Page onRefresh={() => {}} loading />
        <Probe />
      </Harness>
    )
    await waitFor(() => expect(screen.getByTestId('refresh-loading')).toHaveTextContent('true'))
    unmount()

    const second = render(      <TerminalHeaderSlotProvider>
        <FakeHeader />
        <Probe />
      </TerminalHeaderSlotProvider>
    )
    expect(second.getByTestId('refresh-loading')).toHaveTextContent('false')
    second.unmount()
  })

  it('handler 引用变化不会重复注册（ref 桥接），触发执行最新闭包', async () => {
    const calls: number[] = []
    function ChangingPage({ n }: { n: number }) {
      useHeaderRefresh(() => {
        calls.push(n)
      })
      return null
    }
    const user = userEvent.setup()
    const { rerender } = renderShell(
      <>
        <ChangingPage n={1} />
        <Probe />
      </>
    )
    rerender(
      <Harness>
        <ChangingPage n={2} />
        <Probe />
      </Harness>
    )
    rerender(
      <Harness>
        <ChangingPage n={3} />
        <Probe />
      </Harness>
    )
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    // ref 桥接：触发的是最新闭包，且只注册了一次
    expect(calls).toEqual([3])
  })

  it('异步刷新回调执行期间保持 busy，完成后复位', async () => {
    let resolveRefresh: (() => void) | undefined
    const handler = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
    )

    renderShell(
      <>
        <Page onRefresh={handler} />
        <Probe />
      </>
    )

    await waitFor(() => expect(screen.getByTestId('refresh-registered')).toHaveTextContent('true'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'trigger' }))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('refresh-announcement')).toHaveTextContent('正在刷新当前页。')

    await act(async () => resolveRefresh?.())
    await waitFor(() => expect(screen.getByTestId('refresh-announcement')).toHaveTextContent('刷新请求已返回；请确认页面内容已更新。'))
  })

  it('异步 handler 抛错会结束 busy 并通过状态区提示，不重复页面错误详情', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function AsyncPage() {
      useHeaderRefresh(async () => {
        throw new Error('具体接口错误')
      })
      return null
    }
    renderShell(
      <>
        <AsyncPage />
        <Probe />
      </>
    )
    await waitFor(() =>
      expect(screen.getByTestId('refresh-registered')).toHaveTextContent('true')
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'trigger' }))

    await waitFor(() => {
      expect(screen.getByTestId('refresh-loading')).toHaveTextContent('false')
      expect(screen.getByTestId('refresh-announcement')).toHaveTextContent(
        '刷新失败，请查看页面提示并重试。'
      )
    })
    expect(screen.getByTestId('refresh-announcement')).not.toHaveTextContent('具体接口错误')
    expect(errorSpy).toHaveBeenCalledWith('[header-slot] 刷新回调执行失败:', expect.any(Error))
  })

  it('刷新 callback 失败后，延迟的 loading=false 不会覆盖错误反馈', async () => {
    function RejectingPage() {
      const [loading, setLoading] = React.useState(false)
      useHeaderRefresh(async () => {
        setLoading(true)
        await Promise.resolve()
        setLoading(false)
        throw new Error('request failed')
      }, { loading })
      return null
    }

    renderShell(
      <>
        <RejectingPage />
        <Probe />
      </>
    )

    await waitFor(() => expect(screen.getByTestId('refresh-registered')).toHaveTextContent('true'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'trigger' }))
    await waitFor(() =>
      expect(screen.getByTestId('refresh-announcement')).toHaveTextContent(
        '刷新失败，请查看页面提示并重试。'
      )
    )
    expect(screen.getByTestId('refresh-loading')).toHaveTextContent('false')
  })

  it('同步刷新 callback 的 loading 状态决定成功播报，不依据函数返回时机', async () => {
    let setLoading: ((loading: boolean) => void) | undefined
    function SyncPage() {
      const refresh = useHeaderRefresh(() => {})
      setLoading = refresh.setLoading
      return null
    }
    renderShell(
      <>
        <SyncPage />
        <Probe />
      </>
    )
    await waitFor(() =>
      expect(screen.getByTestId('refresh-registered')).toHaveTextContent('true')
    )

    await userEvent.setup().click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByTestId('refresh-announcement')).toHaveTextContent('刷新请求已发起。')

    act(() => setLoading?.(true))
    expect(screen.getByTestId('refresh-announcement')).toHaveTextContent('正在刷新当前页。')
    act(() => setLoading?.(false))
    expect(screen.getByTestId('refresh-announcement')).toHaveTextContent('刷新请求已返回；请确认页面内容已更新。')
  })
})
