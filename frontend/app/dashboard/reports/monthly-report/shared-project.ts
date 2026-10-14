'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'

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
 * ⚠️ 存储键按「当前操作者身份」隔离（首版用固定键，评审以安全阻塞项打回）：
 * localStorage 是浏览器维度、不随登录账号变化，固定键会让同一浏览器换账号后新账号
 * 读到上一个账号的项目 id，而 reconcile 调用的 available-reports 后端路由当前只做
 * 登录保护、不按操作者校验项目权限，会把上一个账号项目的数据（含 PDF URL）露给新账号。
 * 键 = `<前缀>:<roleType>:<operatorNameZh>:<userId>`，与项目列表客户端缓存
 * （lib/project-client-cache.ts）的作用域口径一致；session 未就绪或没有稳定身份时
 * 一律不读不写 —— 宁可不记忆，也不跨账号共享。
 *
 * 与 bb.terminal.global-filter（BLF-819）同属「记住上次选择」思路，但作用域只在月报
 * 板块：monthly-report 不在 GLOBAL_FILTER_PILOT_PREFIXES 内，不进 Top Header 全局筛选。
 */

/** 共享记忆存储键前缀；完整键 = `${SHARED_REPORT_PROJECT_STORAGE_PREFIX}:${操作者作用域}` */
export const SHARED_REPORT_PROJECT_STORAGE_PREFIX = 'bb.monthly-report.project-id'

/**
 * 当前操作者身份（取 session.user 的这三个字段）。
 * 用结构子集而不是 Session['user']，测试里可以只传需要的字段。
 */
export type ReportProjectOwner =
  | {
      id?: string | null
      roleType?: string | null
      operatorNameZh?: string | null
    }
  | null
  | undefined

function ownerPart(value: string | null | undefined, fallback: string): string {
  return (value ?? '').trim() || fallback
}

/**
 * 操作者作用域。返回空串 = 没有稳定身份（未登录 / session 未就绪）→ 不读也不写。
 * 与项目列表缓存同理：userId 缺失时用 operatorNameZh 兜底，两者都缺才判定无身份。
 */
export function reportProjectOwnerScope(owner: ReportProjectOwner): string {
  const userId = (owner?.id ?? '').trim()
  const operatorName = (owner?.operatorNameZh ?? '').trim()
  if (!userId && !operatorName) return ''
  return `${ownerPart(owner?.roleType, 'unknown')}:${ownerPart(operatorName, 'none')}:${ownerPart(userId, 'none')}`
}

/** 共享记忆的存储键；没有稳定身份时为 null（调用方据此跳过读写） */
export function reportProjectStorageKey(owner: ReportProjectOwner): string | null {
  const scope = reportProjectOwnerScope(owner)
  return scope ? `${SHARED_REPORT_PROJECT_STORAGE_PREFIX}:${scope}` : null
}

/**
 * 读当前操作者的共享记忆；SSR / 隐私模式 / 内容异常 / 无稳定身份都退化成空串
 * （等价于「没选过」）。
 */
export function readSharedReportProjectId(owner: ReportProjectOwner): string {
  if (typeof window === 'undefined') return ''
  const key = reportProjectStorageKey(owner)
  if (!key) return ''
  return readStoredByKey(key)
}

/**
 * 写当前操作者的共享记忆；空串视为清除，保持存储里不出现空值。
 * 无稳定身份时什么都不做（不落无主键，避免又变成跨账号共享）。
 */
export function writeSharedReportProjectId(owner: ReportProjectOwner, projectId: string): void {
  if (typeof window === 'undefined') return
  const key = reportProjectStorageKey(owner)
  if (!key) return
  writeStoredByKey(key, projectId)
}

// ── 键级读写（hook 内部用：effect 依赖只需 string，不必依赖 owner 对象身份） ──────

function readStoredByKey(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? ''
  } catch {
    return ''
  }
}

function writeStoredByKey(key: string, projectId: string): void {
  try {
    if (projectId) {
      window.localStorage.setItem(key, projectId)
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // 隐私模式等写入失败静默降级：只影响跨 tab 记忆，页面本身照常工作
  }
}

export interface UseSharedReportProjectOptions {
  /** 页面显式选择（display / generate 来自 URL 参数，reconcile 来自 state） */
  projectId: string
  /** 把共享记忆里的项目写回页面显式选择（display / generate 写 URL 参数，reconcile 写 state） */
  setProjectId: (projectId: string) => void
}

export interface UseSharedReportProjectResult {
  /** 当前应当使用的项目 id：显式值优先，其次共享记忆 */
  projectId: string
  /**
   * 当前操作者的共享记忆是否已读出。
   *
   * ⚠️ ready 为 false 时不要跑「默认选第一个项目」的兜底（页面自带的，
   *    以及 HeaderProjectSelect 这类内建兜底的下拉框）——项目列表命中客户端缓存时，
   *    兜底会抢在共享记忆之前落地，把其它 tab 刚选的项目覆盖掉。
   */
  ready: boolean
  /**
   * 清掉当前操作者的共享记忆（判定记忆不可用时由页面调用，例如项目已不在
   * 当前操作者可见项目列表里）。清理后不会再用旧值覆盖页面。
   */
  forgetProjectId: () => void
}

/**
 * 把页面的项目选择接到「当前操作者」的共享记忆上，返回三个 tab 通用的当前项目 id。
 */
export function useSharedReportProject({
  projectId: explicitProjectId,
  setProjectId: setExplicitProjectId,
}: UseSharedReportProjectOptions): UseSharedReportProjectResult {
  const { data: session, status } = useSession()
  // session 未就绪时不能读存储：此刻没有稳定身份，读到的键可能属于上一个账号
  const identityReady = status !== 'loading'
  const storageKey = reportProjectStorageKey(session?.user ?? null)

  // 读出的记忆与「键」一起存：账号切换后键变了，旧值当场失效，不会串给新账号
  const [snapshot, setSnapshot] = React.useState<{ key: string; projectId: string } | null>(null)

  React.useEffect(() => {
    if (!identityReady) return
    setSnapshot({ key: storageKey ?? '', projectId: storageKey ? readStoredByKey(storageKey) : '' })
  }, [identityReady, storageKey])

  const ready = identityReady && snapshot !== null && snapshot.key === (storageKey ?? '')
  const storedProjectId = ready ? snapshot.projectId : ''

  // 显式值优先（可分享链接 / 用户选择）→ 写回共享记忆；没显式选择 → 采用上次的选择
  React.useEffect(() => {
    if (!ready) return
    if (explicitProjectId) {
      if (storageKey) writeStoredByKey(storageKey, explicitProjectId)
      return
    }
    if (storedProjectId) setExplicitProjectId(storedProjectId)
  }, [ready, storageKey, explicitProjectId, storedProjectId, setExplicitProjectId])

  const forgetProjectId = React.useCallback(() => {
    if (!storageKey) return
    writeStoredByKey(storageKey, '')
    setSnapshot((prev) => (prev && prev.key === storageKey ? { key: storageKey, projectId: '' } : prev))
  }, [storageKey])

  return {
    projectId: explicitProjectId || storedProjectId,
    ready,
    forgetProjectId,
  }
}
