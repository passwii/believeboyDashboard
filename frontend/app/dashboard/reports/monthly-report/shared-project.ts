'use client'

import * as React from 'react'

/**
 * BLF-1344 · 月报板块三个 tab 共享的「当前项目」。
 *
 * 财务报表 / 制作报表 / 报表核对是 layout 下的三个同级路由：切 tab 会卸载并重挂载
 * 页面组件，layout 里的 <Link> 又不携带 query，所以页面级 URL 参数（project）在切
 * tab 时必然丢失。三个 tab 原本各写各的项目状态（URL 里一个存项目 id、一个存项目
 * 名称、一个只放组件 state），于是每切一次 tab 都要重新选项目。
 *
 * 这里把「最近一次选过的项目 id」落到 localStorage，作为 URL 之外的跨 tab 记忆：
 *   读取优先级：页面显式值（URL / state）> 共享记忆 > 页面自己的兜底（自动选第一个）
 *   写入时机：页面当前项目变化时（含兜底选中的第一个），供其它 tab / 下次进入直接沿用
 *
 * 与 bb.terminal.global-filter（BLF-819）同属「记住上次选择」思路，但作用域只在月报
 * 板块：monthly-report 不在 GLOBAL_FILTER_PILOT_PREFIXES 内，不进 Top Header 全局筛选。
 */
export const SHARED_REPORT_PROJECT_STORAGE_KEY = 'bb.monthly-report.project-id'

/** 读共享记忆；SSR / 隐私模式 / 内容异常都退化成空串（等价于「没选过」） */
export function readSharedReportProjectId(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(SHARED_REPORT_PROJECT_STORAGE_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

/** 写共享记忆；空串视为清除，保持存储里不出现空值 */
export function writeSharedReportProjectId(projectId: string): void {
  if (typeof window === 'undefined') return
  try {
    if (projectId) {
      window.localStorage.setItem(SHARED_REPORT_PROJECT_STORAGE_KEY, projectId)
    } else {
      window.localStorage.removeItem(SHARED_REPORT_PROJECT_STORAGE_KEY)
    }
  } catch {
    // 隐私模式等写入失败静默降级：只影响跨 tab 记忆，页面本身照常工作
  }
}

/**
 * 把页面的项目选择接到共享记忆上，返回三个 tab 通用的「当前项目 id」。
 *
 * @param projectId 页面显式选择（display / generate 来自 URL 参数，reconcile 来自 state）
 * @param setProjectId 把共享记忆里的项目写回页面显式选择
 *        （display / generate 写 URL 参数，reconcile 写 state）
 * @returns projectId：显式值优先，其次共享记忆；ready：共享记忆是否已读出
 *
 * ⚠️ ready 为 false 时不要跑「默认选第一个项目」的兜底（页面自带的，
 *    以及 HeaderProjectSelect 这类内建兜底的下拉框）——项目列表命中客户端缓存时，
 *    兜底会抢在共享记忆之前落地，把其它 tab 刚选的项目覆盖掉。
 */
export function useSharedReportProject({
  projectId: explicitProjectId,
  setProjectId: setExplicitProjectId,
}: {
  projectId: string
  setProjectId: (projectId: string) => void
}): { projectId: string; ready: boolean } {
  const [ready, setReady] = React.useState(false)
  const [storedProjectId, setStoredProjectId] = React.useState('')

  // 读存储只在客户端 mount 后跑一次：服务端没有 localStorage，同步读会水合不一致
  React.useEffect(() => {
    setStoredProjectId(readSharedReportProjectId())
    setReady(true)
  }, [])

  // 显式值优先（可分享链接 / 用户选择）→ 写回共享记忆；没显式选择 → 采用上次的选择
  React.useEffect(() => {
    if (!ready) return
    if (explicitProjectId) {
      writeSharedReportProjectId(explicitProjectId)
      return
    }
    if (storedProjectId) setExplicitProjectId(storedProjectId)
  }, [ready, explicitProjectId, storedProjectId, setExplicitProjectId])

  return { projectId: explicitProjectId || storedProjectId, ready }
}
