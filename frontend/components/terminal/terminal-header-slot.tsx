'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'

import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

/**
 * BLF-826 · Top Header 中段插槽 + 全局刷新事件总线。
 *
 * 页面通过 `useHeaderSlot(<ReactNode>)` 把本页筛选控件「传送」进
 * TerminalHeader 的 HeaderSlot 区（面包屑与右侧图标组之间），页面 unmount /
 * 路由切换自动清除，避免上一页残留。head 渲染的是页面传来的 ReactNode，
 * 天然做到「每个页面 head 不同」。
 *
 * 实现模型：Provider 持有一个 DOM 锚点（header 内的容器），页面用
 * createPortal 把控件挂进去。相比「Context 存 ReactNode 快照」：
 *  - 控件由页面自身渲染 → 受控 state / 回调闭包永远实时，无过期快照；
 *  - JSX 字面量每次渲染都是新引用也不会触发重复注册；
 *  - 页面卸载时 React 自动摘除 portal 内容。
 *
 * 刷新走同一 Provider 的轻量事件模型（不引入 zustand / mitt 等新依赖）：
 * 页面 `useHeaderRefresh(handler, opts)` 注册回调并上报 loading；Header 统一
 * 管理本次回调的排重、结果状态与非打断播报。无页面注册时由 Header 兜底
 * `router.refresh()` 重取当前路由 server 数据（不丢 client state）。
 * 语义约定：已注册页刷新 = 页面当前筛选条件下的强刷（跳 Redis/客户端缓存）；
 * 未注册页刷新 = 当前路由 server 数据重取。
 */

export interface TerminalHeaderSlotContextValue {
  /** header 内插槽挂载点；null = header 尚未挂载（SSR / 首帧） */
  anchor: HTMLElement | null

  /** 可展开次级筛选插槽挂载点；null = 第二层尚未挂载 */
  secondaryAnchor: HTMLElement | null
  /** 当前页面是否注册了次级筛选内容 */
  secondarySlotActive: boolean

  /** 移动端筛选条挂载点（正文顶部）；null = 尚未挂载（SSR / 首帧） */
  mobileStripAnchor: HTMLElement | null

  /** 刷新回调是否已由当前页面提供（决定头部刷新按钮点击走页面回调还是 router.refresh 兜底） */
  refreshRegistered: boolean
  /** 页面 loader 上报的 loading 状态 */
  refreshLoading: boolean
  /** Header callback 本身仍在执行 */
  refreshHandlerPending: boolean
  /** 最近一次全局刷新结果，供 Header 图标与非打断播报使用 */
  refreshFeedback: {
    status: 'idle' | 'loading' | 'requested' | 'success' | 'error'
    message: string
  }
  announceRefresh: (
    message: string,
    status: 'idle' | 'loading' | 'requested' | 'success' | 'error'
  ) => void
  setRefreshLoading: (loading: boolean) => void
  /** 注册全局刷新回调，返回注销函数 */
  registerRefresh: (handler: () => void | Promise<void>) => () => void
  /** 触发一次全局刷新；无注册方时为 no-op */
  triggerRefresh: () => void
}

const Ctx = React.createContext<TerminalHeaderSlotContextValue | null>(null)

export function TerminalHeaderSlotProvider({ children }: { children: React.ReactNode }) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null)
  const [secondaryAnchor, setSecondaryAnchor] = React.useState<HTMLElement | null>(null)
  const [secondarySlotActive, setSecondarySlotActive] = React.useState(false)
  const [mobileStripAnchor, setMobileStripAnchor] = React.useState<HTMLElement | null>(null)
  const [refreshLoading, setRefreshLoadingState] = React.useState(false)
  const [refreshHandlerPending, setRefreshHandlerPending] = React.useState(false)
  const [refreshRegistered, setRefreshRegistered] = React.useState(false)
  const [refreshFeedback, setRefreshFeedback] = React.useState<TerminalHeaderSlotContextValue['refreshFeedback']>({
    status: 'idle',
    message: '',
  })

  // 刷新回调经 ref 桥接：handler 变化不需要让 triggerRefresh 的消费方重渲染
  const refreshHandlerRef = React.useRef<(() => void | Promise<void>) | null>(null)
  const refreshInvocationPendingRef = React.useRef(false)
  const refreshCycleActiveRef = React.useRef(false)
  const refreshLoaderObservedRef = React.useRef(false)
  const refreshLoaderPendingRef = React.useRef(false)
  // 自增 token：后注册者胜出；注销时只有当前持有者能清状态
  const refreshHandlerIdRef = React.useRef(0)
  const secondarySlotIdRef = React.useRef(0)

  const registerSecondarySlot = React.useCallback(() => {
    const id = ++secondarySlotIdRef.current
    setSecondarySlotActive(true)

    return () => {
      if (secondarySlotIdRef.current !== id) return
      secondarySlotIdRef.current += 1
      setSecondarySlotActive(false)
    }
  }, [])

  const registerRefresh = React.useCallback(
    (handler: () => void | Promise<void>): (() => void) => {
      const id = ++refreshHandlerIdRef.current
      refreshHandlerRef.current = handler
      setRefreshRegistered(true)
      return () => {
        if (refreshHandlerIdRef.current === id) {
          refreshHandlerRef.current = null
          refreshHandlerIdRef.current += 1
          refreshInvocationPendingRef.current = false
          refreshCycleActiveRef.current = false
          refreshLoaderObservedRef.current = false
          refreshLoaderPendingRef.current = false
          setRefreshRegistered(false)
          setRefreshLoadingState(false)
          setRefreshHandlerPending(false)
          setRefreshFeedback({ status: 'idle', message: '' })
        }
      }
    },
    []
  )

  const announceRefresh = React.useCallback(
    (message: string, status: TerminalHeaderSlotContextValue['refreshFeedback']['status']) => {
      setRefreshFeedback({ message, status })
    },
    []
  )

  const completeRefresh = React.useCallback(() => {
    if (!refreshCycleActiveRef.current || refreshLoaderPendingRef.current) return
    refreshCycleActiveRef.current = false
    refreshLoaderObservedRef.current = false
    announceRefresh('刷新请求已返回；请确认页面内容已更新。', 'requested')
  }, [announceRefresh])

  const setRefreshLoading = React.useCallback((loading: boolean) => {
    setRefreshLoadingState(loading)
    if (!refreshCycleActiveRef.current) return

    refreshLoaderPendingRef.current = loading
    if (loading) {
      refreshLoaderObservedRef.current = true
      announceRefresh('正在刷新当前页。', 'loading')
      return
    }

    if (refreshLoaderObservedRef.current && !refreshInvocationPendingRef.current) {
      completeRefresh()
    }
  }, [announceRefresh, completeRefresh])

  const triggerRefresh = React.useCallback(() => {
    const handler = refreshHandlerRef.current
    if (!handler || refreshInvocationPendingRef.current) return

    const invocationId = refreshHandlerIdRef.current
    refreshInvocationPendingRef.current = true
    refreshCycleActiveRef.current = true
    refreshLoaderObservedRef.current = false
    refreshLoaderPendingRef.current = false
    setRefreshHandlerPending(true)
    announceRefresh('正在刷新当前页。', 'loading')

    void (async () => {
      try {
        const result = handler()
        if (result && typeof result.then === 'function') {
          await result
          if (refreshHandlerIdRef.current === invocationId) {
            refreshInvocationPendingRef.current = false
            setRefreshHandlerPending(false)
            if (refreshLoaderObservedRef.current) {
              completeRefresh()
            } else {
              refreshCycleActiveRef.current = false
              announceRefresh('刷新请求已返回；请确认页面内容已更新。', 'requested')
            }
          }
        } else if (refreshHandlerIdRef.current === invocationId) {
          // 同步 callback 通常只是启动 effect/fetch；只确认请求已发起，不宣称数据已更新。
          refreshInvocationPendingRef.current = false
          setRefreshHandlerPending(false)
          if (refreshLoaderObservedRef.current) {
            if (!refreshLoaderPendingRef.current) completeRefresh()
          } else {
            announceRefresh('刷新请求已发起。', 'requested')
          }
        }
      } catch (err) {
        if (refreshHandlerIdRef.current === invocationId) {
          refreshCycleActiveRef.current = false
          refreshLoaderObservedRef.current = false
          refreshLoaderPendingRef.current = false
          announceRefresh('刷新失败，请查看页面提示并重试。', 'error')
          // 页面保留自己的详细错误提示；这里仅提供统一的可访问状态，不再额外弹 toast。
          console.error('[header-slot] 刷新回调执行失败:', err)
        }
      } finally {
        if (refreshHandlerIdRef.current === invocationId) {
          refreshInvocationPendingRef.current = false
          setRefreshHandlerPending(false)
        }
      }
    })()
  }, [announceRefresh, completeRefresh])

  const value = React.useMemo<TerminalHeaderSlotContextValue>(
    () => ({
      anchor,
      secondaryAnchor,
      secondarySlotActive,
      mobileStripAnchor,
      refreshRegistered,
      refreshLoading,
      refreshHandlerPending,
      refreshFeedback,
      announceRefresh,
      setRefreshLoading,
      registerRefresh,
      triggerRefresh,
    }),
    [
      anchor,
      secondaryAnchor,
      secondarySlotActive,
      mobileStripAnchor,
      refreshRegistered,
      refreshLoading,
      refreshHandlerPending,
      refreshFeedback,
      announceRefresh,
      setRefreshLoading,
      registerRefresh,
      triggerRefresh,
    ]
  )

  return (
    <SlotBindingsCtx.Provider
      value={{ setAnchor, setSecondaryAnchor, setMobileStripAnchor, registerSecondarySlot }}
    >
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </SlotBindingsCtx.Provider>
  )
}

/** 消费 header 插槽状态；必须在 TerminalHeaderSlotProvider 内使用 */
export function useTerminalHeaderSlot(): TerminalHeaderSlotContextValue {
  const ctx = React.useContext(Ctx)
  if (!ctx) {
    throw new Error('useTerminalHeaderSlot 必须在 TerminalHeaderSlotProvider 内使用')
  }
  return ctx
}

/**
 * TerminalHeader 内部使用：渲染中段插槽容器并把 DOM 节点注册进 Provider。
 * 页面 portal 进 anchor 的内容即最终 head 中段 UI；children 允许 header
 * 额外塞固定元素（如分隔线）。
 */
export function HeaderSlotMount({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  const { setAnchor } = useSlotMountBinding()

  return <div ref={setAnchor} className={className} data-testid="terminal-header-slot">{children}</div>
}

/** TerminalHeader 展开行的 anchor；页面次级筛选通过 useSecondaryHeaderSlot portal 到这里。 */
export function SecondaryHeaderSlotMount({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  const { setSecondaryAnchor } = useSlotMountBinding()

  return (
    <div
      ref={setSecondaryAnchor}
      className={className}
      data-testid="terminal-secondary-header-slot"
    >
      {children}
    </div>
  )
}

/**
 * 移动端筛选条挂载点（正文顶部）。
 *
 * BLF-933 · Stage 1 基础设施：TerminalShell 在 main 顶部渲染此容器（`md:hidden`，
 * 仅 <768px 可见），页面在 `isMobile` 时经 `useMobileFilterStrip` portal 进此处，
 * 把筛选控件从 header 中段（`hidden md:flex` 的 HeaderSlotMount）下迁到正文顶部。
 */
export function MobileStripMount({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}) {
  const { setMobileStripAnchor } = useSlotMountBinding()

  return (
    <div
      ref={setMobileStripAnchor}
      className={cn('md:hidden', className)}
      data-testid="terminal-mobile-strip"
    >
      {children}
    </div>
  )
}

// —— HeaderSlotMount / MobileStripMount ↔ Provider 的 anchor 绑定 ——
// 用独立 Context 存 setter，避免把 setState 混进公开的 slot 值对象。

interface SlotBindings {
  setAnchor: (el: HTMLElement | null) => void
  setSecondaryAnchor: (el: HTMLElement | null) => void
  setMobileStripAnchor: (el: HTMLElement | null) => void
  registerSecondarySlot: () => () => void
}

const SlotBindingsCtx = React.createContext<SlotBindings | null>(null)

/** @internal Provider 内部包装：向 HeaderSlotMount / MobileStripMount 暴露 anchor setter */
function useSlotMountBinding(): SlotBindings {
  const bindings = React.useContext(SlotBindingsCtx)
  if (!bindings) {
    throw new Error('Header slot mounts 必须在 TerminalHeaderSlotProvider 内使用')
  }
  return bindings
}

/**
 * 页面侧 hook：把本页筛选控件 portal 进 head，unmount 自动清除。
 * anchor 未就绪（SSR / header 未挂载）时不渲染，就绪后自动出现。
 *
 * ```tsx
 * useHeaderSlot(
 *   <>
 *     <MyProjectSelect ... />
 *     <MyDateRange ... />
 *   </>,
 * )
 * ```
 *
 * 返回的 ReactNode 必须由页面渲染出来（通常 `return <>{slotPortal}</>` 放在
 * 组件树任意位置——portal 会把它送到 head，不影响页面布局）。
 */
export function useHeaderSlot(node: React.ReactNode): React.ReactPortal | null {
  const { anchor } = useTerminalHeaderSlot()

  if (!anchor) return null
  return createPortal(node, anchor)
}

/** 页面侧 hook：把次级筛选 portal 到可展开的第二行，并登记其可见性。 */
export function useSecondaryHeaderSlot(node: React.ReactNode): React.ReactPortal | null {
  const { secondaryAnchor } = useTerminalHeaderSlot()
  const { registerSecondarySlot } = useSlotMountBinding()
  const hasContent = node !== null && node !== undefined && node !== false

  React.useEffect(() => {
    if (!hasContent) return
    return registerSecondarySlot()
  }, [hasContent, registerSecondarySlot])

  if (!hasContent || !secondaryAnchor) return null
  return createPortal(node, secondaryAnchor)
}

/**
 * 页面侧 hook：把移动端筛选条 portal 进正文顶部挂载点，unmount 自动清除。
 *
 * BLF-933 · 移动端挂载机制：`isMobile`（<768px）且挂载点就绪时才渲染 ——
 * 桌面端（`md+`）返回 null，保持现有 `useHeaderSlot` portal 行为完全不变。
 *
 * ```tsx
 * // 页面：桌面端走 useHeaderSlot，移动端走 useMobileFilterStrip
 * const desktopSlot = useHeaderSlot(<HeaderFilterControls isMobileView={false} controls={filters} />)
 * const mobileStrip = useMobileFilterStrip(
 *   <MobileFilterStrip summary="玥涵 · US · 06/01~09/01" controls={filters} />,
 * )
 * return <>{desktopSlot}{mobileStrip}</>
 * ```
 */
export function useMobileFilterStrip(node: React.ReactNode): React.ReactPortal | null {
  const { mobileStripAnchor } = useTerminalHeaderSlot()
  const isMobile = useIsMobile()

  if (!isMobile || !mobileStripAnchor) return null
  return createPortal(node, mobileStripAnchor)
}

/**
 * 页面侧 hook：注册全局刷新回调（head 刷新按钮点击时触发）并上报 loading。
 * unmount 自动注销，头部按钮随之切回 router.refresh 兜底（BLF-881 起按钮常驻）。
 * handler 用 ref 桥接 —— 页面任意 state 更新都不会导致重复注册，
 * 触发时永远执行最新闭包。返回 setLoading 供异步强刷期间上报按钮态。
 */
export function useHeaderRefresh(
  handler: () => void | Promise<void>,
  opts?: { loading?: boolean }
): { setLoading: (loading: boolean) => void } {
  const { registerRefresh, setRefreshLoading } = useTerminalHeaderSlot()
  const handlerRef = React.useRef(handler)
  handlerRef.current = handler

  React.useEffect(() => registerRefresh(() => handlerRef.current()), [registerRefresh])

  const optLoading = opts?.loading ?? false
  React.useEffect(() => {
    setRefreshLoading(optLoading)
    return () => setRefreshLoading(false)
  }, [optLoading, setRefreshLoading])

  return { setLoading: setRefreshLoading }
}
