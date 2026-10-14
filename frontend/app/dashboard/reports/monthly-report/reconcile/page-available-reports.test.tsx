/**
 * BLF-1344（评审阻塞项）· reconcile 请求 available-reports 之前的项目可见性校验。
 *
 * 背景：后端 `/report-reconciliation/available-reports` 只做登录保护、不按操作者校验
 * 项目权限，响应里含月报信息与 PDF URL。也就是说「用哪个项目 id 发请求」这件事必须由
 * 前端守住：记忆 / URL 里的项目要先在当前操作者的 `/projects/manage` 可见列表里，
 * 否则清理并回退，且**不得用旧 id 发请求**。
 *
 * 这里用真实 AutoReconcileTab + 真实 HeaderProjectSelect（只把 /projects/manage 与
 * fetch 换成可控桩），断言请求参数级别的行为，而不是只看渲染结果。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'
import {
  readSharedReportProjectId,
  writeSharedReportProjectId,
  type ReportProjectOwner,
} from '../shared-project'

const OWNER_A: ReportProjectOwner = { id: 'user-a', roleType: 'admin', operatorNameZh: '张三' }
const OWNER_B: ReportProjectOwner = { id: 'user-b', roleType: 'operator', operatorNameZh: '李四' }

// ── mocks ────────────────────────────────────────────────────────────────────

// 可切换的 session：模拟「同一浏览器换账号」
const sessionState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('next-auth/react', () => ({
  useSession: () => sessionState.current,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/reports/monthly-report/reconcile',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: () => null, toString: () => '' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

const managedProjects = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; name: string; country?: string }>,
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(() => Promise.resolve(managedProjects.rows)),
}))

// 筛选控件挂到正文（生产走 header portal，测试环境没有 header 容器）
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

import ReconcilePage from './page'

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers(),
  } as unknown as Response
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/report-reconciliation/available-reports')) {
    return jsonResponse({ reports: [], total: 0 })
  }
  return jsonResponse({})
})

/** available-reports 请求里带过的 project_id */
function availableReportProjectIds(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/report-reconciliation/available-reports'))
    .map((url) => new URLSearchParams(url.split('?')[1] ?? '').get('project_id') ?? '')
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  managedProjects.rows = [
    { id: 1, name: '项目A', country: 'US' },
    { id: 2, name: '项目B', country: 'DE' },
  ]
  sessionState.current = stableSession({ user: OWNER_A as Record<string, unknown> })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BLF-1344 · reconcile 不会拿不可见的项目 id 请求 available-reports', () => {
  it('记忆里的项目可见时照常用它（跨 tab 共享没被加固弄丢）', async () => {
    writeSharedReportProjectId(OWNER_A, '2')

    render(<ReconcilePage />)

    await waitFor(() => expect(availableReportProjectIds()).toContain('2'), { timeout: 3_000 })
    expect(availableReportProjectIds()).not.toContain('1')
  })

  it('记忆里的项目已不可见（权限被收回 / 项目下架）→ 不用它发请求，回退第一个可见项目', async () => {
    writeSharedReportProjectId(OWNER_A, '999')

    render(<ReconcilePage />)

    await waitFor(() => expect(availableReportProjectIds()).toContain('1'), { timeout: 3_000 })
    expect(availableReportProjectIds()).not.toContain('999')
    // 不可见的记忆被清掉，并落到回退后的项目
    await waitFor(() => expect(readSharedReportProjectId(OWNER_A)).toBe('1'))
  })

  it('同一浏览器换账号 → 不用上一个账号记忆里的项目发请求', async () => {
    // 上一个账号（张三）选过项目 2
    writeSharedReportProjectId(OWNER_A, '2')
    // 现在登录的是李四，可见项目只有 3
    sessionState.current = stableSession({ user: OWNER_B as Record<string, unknown> })
    managedProjects.rows = [{ id: 3, name: '项目C', country: 'US' }]

    render(<ReconcilePage />)

    await waitFor(() => expect(availableReportProjectIds()).toContain('3'), { timeout: 3_000 })
    expect(availableReportProjectIds()).not.toContain('2')
    // 隔离不是清除：张三的记忆原封不动
    expect(readSharedReportProjectId(OWNER_A)).toBe('2')
  })

  it('可见项目列表拉不到时一个 available-reports 请求都不发', async () => {
    writeSharedReportProjectId(OWNER_A, '2')
    vi.mocked(fetchManagedProjectsCached).mockImplementationOnce(() =>
      Promise.reject(new Error('项目列表加载失败'))
    )

    render(<ReconcilePage />)

    // 无法确认权限 → 不放行任何项目 id（正文回到「请先选择项目和站点」）
    await waitFor(() => expect(screen.getByText('请先选择项目和站点')).toBeInTheDocument())
    // 等过 auto tab 的 300ms 防抖，确认确实没有发出请求
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(availableReportProjectIds()).toHaveLength(0)
  })
})
