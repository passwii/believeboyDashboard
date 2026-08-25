'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'

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
 * 页面 `useHeaderRefresh(handler, opts)` 注册回调并上报 loading；无页面注册时
 * 头部刷新按钮隐藏（profile / change-password 等静态页不显示）。
 * 语义约定：刷新 = 页面当前筛选条件下的强刷（跳 Redis/客户端缓存）。
 */

export interface TerminalHeaderSlotContextValue {
  /** header 内插槽挂载点；null = header 尚未挂载（SSR / 首帧） */
  anchor: HTMLElement | null

  /** 刷新回调是否已由当前页面提供（决定头部刷新按钮显隐） */
  refreshRegistered: boolean
  /** 刷新进行中（头部按钮转 spinner、禁点） */
  refreshLoading: boolean
  setRefreshLoading: (loading: boolean) => void
  /** 注册全局刷新回调，返回注销函数 */
  registerRefresh: (handler: () => void | Promise<void>) => () => void
  /** 触发一次全局刷新；无注册方时为 no-op */
  triggerRefresh: () => void
}

const Ctx = React.createContext<TerminalHeaderSlotContextValue | null>(null)

export function TerminalHeaderSlotProvider({ children }: { children: React.ReactNode }) {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null)
  const [refreshLoading, setRefreshLoadingState] = React.useState(false)
  const [refreshRegistered, setRefreshRegistered] = React.useState(false)

  // 刷新回调经 ref 桥接：handler 变化不需要让 triggerRefresh 的消费方重渲染
  const refreshHandlerRef = React.useRef<(() => void | Promise<void>) | null>(null)
  // 自增 token：后注册者胜出；注销时只有当前持有者能清状态
  const refreshHandlerIdRef = React.useRef(0)

  const registerRefresh = React.useCallback(
    (handler: () => void | Promise<void>): (() => void) => {
      const id = ++refreshHandlerIdRef.current
      refreshHandlerRef.current = handler
      setRefreshRegistered(true)
      return () => {
        if (refreshHandlerIdRef.current === id) {
          refreshHandlerRef.current = null
          setRefreshRegistered(false)
          setRefreshLoadingState(false)
        }
      }
    },
    []
  )

  const setRefreshLoading = React.useCallback((loading: boolean) => {
    setRefreshLoadingState(loading)
  }, [])

  const triggerRefresh = React.useCallback(() => {
    const handler = refreshHandlerRef.current
    if (!handler) return
    void Promise.resolve(handler()).catch((err) => {
      // 刷新失败不冒泡成未处理 rejection；页面自身负责 toast 提示
      console.error('[header-slot] 刷新回调执行失败:', err)
    })
  }, [])

  const value = React.useMemo<TerminalHeaderSlotContextValue>(
    () => ({
      anchor,
      refreshRegistered,
      refreshLoading,
      setRefreshLoading,
      registerRefresh,
      triggerRefresh,
    }),
    [anchor, refreshRegistered, refreshLoading, setRefreshLoading, registerRefresh, triggerRefresh]
  )

  return (
    <AnchorSetterCtx.Provider value={setAnchor}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </AnchorSetterCtx.Provider>
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

// —— HeaderSlotMount ↔ Provider 的 anchor 绑定 ——
// 用独立 Context 存 setter，避免把 setState 混进公开的 slot 值对象。

const AnchorSetterCtx = React.createContext<((el: HTMLElement | null) => void) | null>(null)

/** @internal Provider 内部包装：向 HeaderSlotMount 暴露 anchor setter */
function useSlotMountBinding(): {
  setAnchor: (el: HTMLElement | null) => void
} {
  const setAnchor = React.useContext(AnchorSetterCtx)
  if (!setAnchor) {
    throw new Error('HeaderSlotMount 必须在 TerminalHeaderSlotProvider 内使用')
  }
  return { setAnchor }
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

/**
 * 页面侧 hook：注册全局刷新回调（head 刷新按钮点击时触发）并上报 loading。
 * unmount 自动注销，头部按钮随之隐藏。
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
