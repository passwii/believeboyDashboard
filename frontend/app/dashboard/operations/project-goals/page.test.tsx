import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// BEL-423：目标管理页按 tab 取数 —— mount 只拉 progress，goals 列表首次进入
// "目标管理" tab 才拉；且 2min 客户端缓存内重复切 tab 不重复请求。
// operations header migration A2：控制台 3 个 select（项目/站点/年份）上移 Top Header
// 中段插槽，刷新由全局 header 刷新按钮接管（force 跳 2min 缓存）；旧 TermPanel 控制台删除。

// 稳定引用：mock 的 useSession / useNotifications 若每次 render 返回新对象，
// 会让把它们放进 deps 的 effect 无限循环（真实实现里 context 值稳定）。
const { SESSION_DATA, NOTIFY } = vi.hoisted(() => ({
  SESSION_DATA: { user: { id: 'u1', roleType: 'admin', name: '测试' } },
  NOTIFY: { notify: vi.fn() },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: SESSION_DATA, status: 'authenticated' }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '项目A' }]),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

// 捕获 header 刷新回调 / loading 上报 / 插槽节点，供 force 语义与上移断言
let capturedRefreshHandler: (() => void) | null = null
let capturedRefreshLoading: boolean | undefined
let capturedSlotNode: unknown = null
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
  },
  useHeaderSlot: (node: unknown) => {
    capturedSlotNode = node
    return null
  },
  useMobileFilterStrip: () => null,
}))

// 缓存层探针：记录 fetchOpsJsonCached 收到的 force 入参（断言 header 刷新的 force 语义）；
// 真实实现（2min 缓存 + 在途去重）经 importOriginal 保留，BEL-423 懒加载断言不受影响。
let lastForce: boolean | undefined
vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  const realFetchOpsJsonCached = actual.fetchOpsJsonCached
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn((url: string, options?: { force?: boolean }) => {
      lastForce = options?.force
      return realFetchOpsJsonCached(url, options)
    }),
  }
})

import { clearOpsClientCaches, fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { COUNTRY_TIMEZONE_MAP, getTodayInTimezone } from '@/components/ui/date-picker'
import ProjectGoalsPage from './page'

const PROGRESS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  currency: 'USD',
  year: 2026,
  monthly_progress: [],
  annual_progress: null,
}

const GOALS_PAYLOAD = { goals: [], total: 0 }

/** BLF-595 回归用：本月 (year, month)，取 US 时区当天，与页面 currentYear/currentMonth 口径一致。
 *  硬编码月份会随日期滚动失效（2026-09 起 8 月不再是当月，页面找不到 currentMonthProgress）。 */
const currentYearMonth = (() => {
  const today = getTodayInTimezone(COUNTRY_TIMEZONE_MAP.US)
  return { year: today.getFullYear(), month: today.getMonth() + 1 }
})()

/** 含「本月进度」的 progress 载荷：三环指标与 4 统计块都会渲染（月份取 US 时区当天，与页面口径一致） */
function progressPayloadWithCurrentMonth() {
  const today = getTodayInTimezone(COUNTRY_TIMEZONE_MAP.US)
  const year = today.getFullYear()
  const month = today.getMonth() + 1
  return {
    ...PROGRESS_PAYLOAD,
    year,
    monthly_progress: [
      {
        year,
        month,
        month_label: `${year}年${month}月`,
        target_amount: 10000,
        achieved_amount: 4000,
        completion_rate: 0.4,
        days_in_month: 31,
        today_day: 15,
        daily_target: 322.58,
        cumulative_daily_target: 4838.7,
        completion_vs_daily: 0.83,
        completion_vs_monthly: 0.4,
        currency: 'USD',
      },
    ],
    annual_progress: {
      year,
      target_amount: 120000,
      achieved_amount: 40000,
      completion_rate: 0.33,
      currency: 'USD',
    },
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  capturedSlotNode = null
  lastForce = undefined
})

describe('ProjectGoalsPage 按 tab 懒加载（BEL-423）', () => {
  beforeEach(() => {
    clearOpsClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  function mountWithFetch() {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/project-goals/progress')) return jsonResponse(PROGRESS_PAYLOAD)
      if (url.includes('/project-goals?')) return jsonResponse(GOALS_PAYLOAD)
      return jsonResponse({})
    })
    return calls
  }

  it('mount 只请求 progress，不请求 goals 列表', async () => {
    const calls = mountWithFetch()
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/project-goals/progress'))).toBe(true)
    })
    expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(0)
  })

  it('使用 Warm Ledger 页面壳，表格在页内滚动容器中', async () => {
    mountWithFetch()
    const { container } = render(<ProjectGoalsPage />)

    const page = await screen.findByTestId('project-goals-warm-page')
    expect(page).toHaveAttribute('data-warm-surface', 'warm-ledger')
    expect(await screen.findByTestId('project-goals-table-scroll')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('首次进入"目标管理" tab 才请求 goals 列表；来回切 tab 不重复请求', async () => {
    const user = userEvent.setup()
    const calls = mountWithFetch()
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/project-goals/progress'))).toBe(true)
    })

    await user.click(screen.getByRole('tab', { name: '目标管理' }))
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(1)
    })

    await user.click(screen.getByRole('tab', { name: '进度概览' }))
    await user.click(screen.getByRole('tab', { name: '目标管理' }))
    expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(1)
  })

  it('BLF-595：进度概览点「去设置」直接切 tab 时立即拉取 goals 列表', async () => {
    const user = userEvent.setup()
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/project-goals/progress')) {
        // 有月度目标 → 显示「去设置」入口
        return jsonResponse({
          ...PROGRESS_PAYLOAD,
          monthly_progress: [
            {
              year: currentYearMonth.year,
              month: currentYearMonth.month,
              month_label: `${currentYearMonth.year}年${currentYearMonth.month}月`,
              target_amount: 0,
              achieved_amount: 1000,
              completion_rate: 0,
              days_in_month: 31,
              today_day: 15,
              daily_target: 0,
              cumulative_daily_target: 0,
              completion_vs_daily: 0,
              completion_vs_monthly: 0,
              currency: 'USD',
            },
          ],
        })
      }
      if (url.includes('/project-goals?')) return jsonResponse(GOALS_PAYLOAD)
      return jsonResponse({})
    })
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/project-goals/progress'))).toBe(true)
    })

    await user.click(await screen.findByRole('button', { name: /去设置/ }))
    // 去设置切 tab 时必须触发 goals 拉取（BLF-595 回归：不能只 setActiveTab）
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/project-goals?'))).toHaveLength(1)
    })
  })

  it('BLF-595：保存目标后立即 force 重载 progress 与 goals，目标表马上出现已设目标', async () => {
    const user = userEvent.setup()
    const progressCalls: string[] = []
    const goalsCalls: string[] = []
    let saved = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/project-goals/progress')) {
        progressCalls.push(url)
        return jsonResponse({
          ...PROGRESS_PAYLOAD,
          monthly_progress: [
            {
              year: currentYearMonth.year,
              month: currentYearMonth.month,
              month_label: `${currentYearMonth.year}年${currentYearMonth.month}月`,
              target_amount: saved ? 10000 : 0,
              achieved_amount: 1000,
              completion_rate: 0,
              days_in_month: 31,
              today_day: 15,
              daily_target: saved ? 322.58 : 0,
              cumulative_daily_target: saved ? 4838.7 : 0,
              completion_vs_daily: 0,
              completion_vs_monthly: 0,
              currency: 'USD',
            },
          ],
        })
      }
      if (url.includes('/project-goals') && init?.method === 'POST') {
        saved = true
        return jsonResponse({ id: 1 })
      }
      if (url.includes('/project-goals?')) {
        goalsCalls.push(url)
        const goals = saved
          ? [
              {
                id: 1,
                project_id: 1,
                country: 'US',
                goal_type: 'monthly',
                metric_type: 'sales_amount',
                period_year: currentYearMonth.year,
                period_month: currentYearMonth.month,
                target_amount: 10000,
                currency: 'USD',
                created_at: '',
                updated_at: '',
              },
            ]
          : []
        return jsonResponse({ goals, total: goals.length })
      }
      return jsonResponse({})
    })
    render(<ProjectGoalsPage />)

    await waitFor(() => {
      expect(progressCalls.length).toBeGreaterThanOrEqual(1)
    })

    // 经「去设置」进入目标管理 tab
    await user.click(await screen.findByRole('button', { name: /去设置/ }))
    await waitFor(() => {
      expect(goalsCalls.length).toBeGreaterThanOrEqual(1)
    })

    // 新增月度目标并保存
    await user.click(screen.getByRole('button', { name: /新增月度目标/ }))
    const amountInput = screen.getByPlaceholderText('例如：50000')
    await user.clear(amountInput)
    await user.type(amountInput, '10000')
    await user.click(screen.getByRole('button', { name: /保存/ }))

    // 保存后 goals 被 force 重载，目标表立即出现已设目标（无需手动刷新）
    await waitFor(() => {
      expect(goalsCalls.length).toBeGreaterThanOrEqual(2)
    })
    await waitFor(() => {
      expect(screen.getAllByText('$ 10,000.00').length).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('ProjectGoalsPage header 化渲染契约（operations header migration A2）', () => {
  beforeEach(() => {
    clearOpsClientCaches()
    window.sessionStorage.clear()
  })

  function stubOpsFetch(progressPayload: unknown = PROGRESS_PAYLOAD) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/project-goals/progress')) return jsonResponse(progressPayload)
      if (url.includes('/project-goals?')) return jsonResponse(GOALS_PAYLOAD)
      return jsonResponse({})
    })
  }

  it('渲染不崩溃：三环进度与 4 统计块保留，双 tabs 出现，筛选控件已交入 header 插槽', async () => {
    stubOpsFetch(progressPayloadWithCurrentMonth())
    const { unmount } = render(<ProjectGoalsPage />)

    // 三环进度区（本月进度标题 + 三环 label）
    expect(await screen.findByText(/本月进度/)).toBeInTheDocument()
    expect(screen.getByText('截止今日完成率')).toBeInTheDocument()
    expect(screen.getByText('实际月度进度')).toBeInTheDocument()
    expect(screen.getByText('达成速度')).toBeInTheDocument()
    expect(screen.getByText('71.1%')).toBeInTheDocument()
    // 4 统计块
    expect(screen.getByText('年度完成率')).toBeInTheDocument()
    expect(screen.getByText('本月已达成')).toBeInTheDocument()
    expect(screen.getByText('月度目标')).toBeInTheDocument()
    expect(screen.getByText('日目标')).toBeInTheDocument()
    // 2 tabs + 月度进度表
    expect(screen.getByRole('tab', { name: '进度概览' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '目标管理' })).toBeInTheDocument()
    expect(screen.getByText('月度进度表')).toBeInTheDocument()
    // 3 个筛选控件经 useHeaderSlot 上移（正文不再出现旧下拉占位文案）
    expect(capturedSlotNode).not.toBeNull()
    expect(screen.queryByText('选择项目')).not.toBeInTheDocument()

    unmount()
    clearOpsClientCaches()
    const invalidDatePayload = progressPayloadWithCurrentMonth()
    invalidDatePayload.monthly_progress[0].today_day = 32
    invalidDatePayload.monthly_progress[0].achieved_amount = 11000
    stubOpsFetch(invalidDatePayload)
    render(<ProjectGoalsPage />)

    expect(await screen.findByText('达成速度')).toBeInTheDocument()
    expect(screen.getByText('--')).toBeInTheDocument()
    expect(screen.queryByText('已达标')).not.toBeInTheDocument()
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument()
  })

  it('旧控制台已移除：无「控制台」/面板标题文案，无页内「刷新」按钮', async () => {
    stubOpsFetch()
    render(<ProjectGoalsPage />)
    await screen.findByText('月度进度表')

    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
    // 旧 TermPanel 控制台标题与说明文案随壳一并移除（标题由 header 面包屑承载）
    expect(screen.queryByText('项目目标')).not.toBeInTheDocument()
    expect(screen.queryByText(/按项目 \/ 站点 \/ 年份/)).not.toBeInTheDocument()
    // 全局刷新唯一入口：页内不得再有「刷新」按钮
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument()
  })

  it('头部刷新回调触发 loadData(force=true)——缓存层收到 force:true，且 loading 上报', async () => {
    stubOpsFetch()
    render(<ProjectGoalsPage />)
    await screen.findByText('月度进度表')
    expect(capturedRefreshHandler).not.toBeNull()
    // 首次加载走缓存语义（force=false）
    expect(lastForce).toBe(false)

    // 用受控 Promise 挂起本次重拉，确定性断言 force 语义与 loading 上报
    let resolveFetch: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      (_url: string, opts?: { force?: boolean }) => {
        lastForce = opts?.force
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      }
    )

    await act(async () => {
      capturedRefreshHandler?.()
    })
    // loadData(true) 以 force:true 重拉（跳 2min 缓存）
    await vi.waitFor(() => expect(lastForce).toBe(true))
    // loading 状态上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落（act 包裹避免状态更新告警）
    await act(async () => {
      resolveFetch?.(PROGRESS_PAYLOAD)
    })
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })
})
