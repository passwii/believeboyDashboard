/**
 * BLF-1344 · 月报板块三个 tab 共享「当前项目」的契约。
 *
 * 三个 tab 是同级路由，切 tab 会重挂载页面组件，所以共享只能靠存储 + 读取优先级。
 * 这里锁住三件事：
 *  1. 读取优先级（页面显式值 > 共享记忆）与回写时机（任何一次有效选择都留给其它 tab）；
 *  2. 记忆按操作者身份隔离（评审阻塞项）：同一浏览器换账号后读不到上一个账号的项目；
 *  3. 没有稳定身份（session 未就绪 / 无 userId 与 operatorName）时不读也不写。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

import { stableSession } from '@/test-utils/stable-mocks'
import {
  SHARED_REPORT_PROJECT_STORAGE_PREFIX,
  readSharedReportProjectId,
  reportProjectStorageKey,
  useSharedReportProject,
  writeSharedReportProjectId,
  type ReportProjectOwner,
} from './shared-project'

const OWNER_A: ReportProjectOwner = { id: 'user-a', roleType: 'admin', operatorNameZh: '张三' }
const OWNER_B: ReportProjectOwner = { id: 'user-b', roleType: 'operator', operatorNameZh: '李四' }

// ── 可切换的 session：模拟同一浏览器上换账号（`useSession` 的 data 会变） ──────
const sessionState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.current,
}))

function signIn(owner: ReportProjectOwner) {
  sessionState.current = stableSession({ user: owner as Record<string, unknown> })
}

function renderShared(initialProjectId: string) {
  // 页面侧「显式选择」的替身：记录页面 setter 收到的值
  const explicitSetCalls: string[] = []
  const handleExplicitSet = (value: string) => {
    explicitSetCalls.push(value)
  }

  const view = renderHook(
    ({ explicit }: { explicit: string }) =>
      useSharedReportProject({ projectId: explicit, setProjectId: handleExplicitSet }),
    { initialProps: { explicit: initialProjectId } }
  )

  return { ...view, explicitSetCalls }
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  signIn(OWNER_A)
})

describe('共享记忆读写（按操作者隔离）', () => {
  it('同一操作者写入后可读回，空串视为清除', () => {
    const key = reportProjectStorageKey(OWNER_A)
    expect(key).toBeTruthy()
    expect(key).toContain(SHARED_REPORT_PROJECT_STORAGE_PREFIX)

    writeSharedReportProjectId(OWNER_A, '2')
    expect(readSharedReportProjectId(OWNER_A)).toBe('2')
    expect(window.localStorage.getItem(key as string)).toBe('2')

    writeSharedReportProjectId(OWNER_A, '')
    expect(readSharedReportProjectId(OWNER_A)).toBe('')
    expect(window.localStorage.getItem(key as string)).toBeNull()
  })

  it('存储内容只剩余白时退化成没选过，不抛错', () => {
    window.localStorage.setItem(reportProjectStorageKey(OWNER_A) as string, '   ')
    expect(readSharedReportProjectId(OWNER_A)).toBe('')
  })

  it('不同操作者用不同的键：A 选的项目 B 读不到，B 的选择也不覆盖 A 的', () => {
    writeSharedReportProjectId(OWNER_A, '2')

    expect(reportProjectStorageKey(OWNER_A)).not.toBe(reportProjectStorageKey(OWNER_B))
    expect(readSharedReportProjectId(OWNER_B)).toBe('')

    writeSharedReportProjectId(OWNER_B, '7')
    expect(readSharedReportProjectId(OWNER_A)).toBe('2')
    expect(readSharedReportProjectId(OWNER_B)).toBe('7')
  })

  it('没有稳定身份（无 userId / operatorName）时不读也不写', () => {
    expect(reportProjectStorageKey(null)).toBeNull()
    expect(reportProjectStorageKey({})).toBeNull()
    expect(reportProjectStorageKey({ operatorNameZh: '   ' })).toBeNull()

    writeSharedReportProjectId({}, '2')
    writeSharedReportProjectId(null, '2')
    expect(window.localStorage.length).toBe(0)
    expect(readSharedReportProjectId({})).toBe('')
  })
})

describe('useSharedReportProject', () => {
  it('页面没显式选择时沿用当前操作者的共享记忆，并把选择写回页面显式值', async () => {
    writeSharedReportProjectId(OWNER_A, '2')

    const { result, explicitSetCalls } = renderShared('')

    await waitFor(() => expect(result.current.ready).toBe(true))
    await waitFor(() => expect(result.current.projectId).toBe('2'))
    expect(explicitSetCalls).toContain('2')
    expect(readSharedReportProjectId(OWNER_A)).toBe('2')
  })

  it('页面显式选择优先于共享记忆，并写回共享记忆', async () => {
    writeSharedReportProjectId(OWNER_A, '2')

    const { result, explicitSetCalls } = renderShared('1')

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projectId).toBe('1')
    await waitFor(() => expect(readSharedReportProjectId(OWNER_A)).toBe('1'))
    expect(explicitSetCalls).toEqual([])
  })

  it('没选过时保持空值，不自己造默认项目', async () => {
    const { result, explicitSetCalls } = renderShared('')

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projectId).toBe('')
    expect(explicitSetCalls).toEqual([])
    expect(readSharedReportProjectId(OWNER_A)).toBe('')
  })

  it('页面选择变化后共享记忆跟着变（供其它 tab 沿用）', async () => {
    const { result, rerender } = renderShared('1')
    await waitFor(() => expect(readSharedReportProjectId(OWNER_A)).toBe('1'))

    rerender({ explicit: '3' })

    await waitFor(() => expect(readSharedReportProjectId(OWNER_A)).toBe('3'))
    expect(result.current.projectId).toBe('3')
  })

  it('同一浏览器换账号：不沿用上一个账号的项目记忆，也不动上一个账号的记忆', async () => {
    writeSharedReportProjectId(OWNER_A, '2')

    const { result, rerender } = renderShared('')
    await waitFor(() => expect(result.current.projectId).toBe('2'))

    // 不刷新页面的换账号：session 直接变人
    signIn(OWNER_B)
    rerender({ explicit: '' })

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projectId).toBe('')
    // A 的记忆原封不动：隔离不是清除
    expect(readSharedReportProjectId(OWNER_A)).toBe('2')
    expect(readSharedReportProjectId(OWNER_B)).toBe('')
  })

  it('session 未就绪（loading）时不读记忆，避免读到上一个账号的键', async () => {
    writeSharedReportProjectId(OWNER_A, '2')
    sessionState.current = stableSession({ data: null, status: 'loading' })

    const { result, rerender } = renderShared('')
    expect(result.current.ready).toBe(false)
    expect(result.current.projectId).toBe('')

    signIn(OWNER_B)
    rerender({ explicit: '' })

    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projectId).toBe('')
    expect(readSharedReportProjectId(OWNER_A)).toBe('2')
  })

  it('forgetProjectId 清掉当前操作者的记忆，且不再把旧值推回页面', async () => {
    writeSharedReportProjectId(OWNER_A, '2')

    const { result, explicitSetCalls } = renderShared('')
    await waitFor(() => expect(result.current.projectId).toBe('2'))

    act(() => result.current.forgetProjectId())

    await waitFor(() => expect(readSharedReportProjectId(OWNER_A)).toBe(''))
    expect(result.current.projectId).toBe('')
    // 清掉之后不会再把旧值推回页面（页面 setter 只在首次采用时收到过一次 '2'）
    expect(explicitSetCalls.filter((value) => value === '2')).toHaveLength(1)
  })
})
