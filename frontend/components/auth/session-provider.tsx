'use client'

import { SessionProvider } from 'next-auth/react'

// refetchOnWindowFocus 默认 true：每次切换浏览器标签 / 激活窗口（visibilitychange）
// 都会重新拉取 session，导致 session 对象引用变化，进而触发所有依赖 session 的
// 数据加载 useCallback 重建并重新请求，页面表现为“切走再回来就刷新”。
// 对内部后台仪表盘，关闭窗口聚焦自动刷新即可消除该干扰（跨标签登出仍由
// storage 事件同步，不受影响）。
export function AuthSessionProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider refetchOnWindowFocus={false}>{children}</SessionProvider>
}
