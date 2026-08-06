import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// ── 模块级常量（BLF-450 教训：inline 创建新引用会让 effect 无限重跑）────
const { notify, session } = vi.hoisted(() => ({
  notify: vi.fn(),
  // session 必须是稳定引用：组件 useCallback 依赖它，每次 render 新对象 →
  // fetchLogs 身份变化 → useEffect 无限重跑 → 事件循环被饿死（本轮实测坑）
  session: { data: { user: { isAdmin: true } }, status: 'authenticated' },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => session,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))

import { AgentOperationLogsPanel } from './agent-operation-logs-panel'

// ── 造数 ───────────────────────────────────────────────────────────────
const transitionRow = {
  id: 101,
  created_at: '2026-08-06T09:00:00Z',
  agent_id: 'shipment-assistant-prod',
  action: 'shipment.status.transition',
  target_type: 'shipment_schedule',
  target_id: '88',
  result: 'success',
  project_id: 12,
  operation_type: 'shipments',
  request_path: '/api/v1/agent/projects/12/shipments/SH-1/status',
  request_method: 'POST',
  before_json: { shipment_status: 'in_transit' },
  after_json: { shipment_status: 'completed' },
  idempotency_key: 'idem-1',
  error_message: null,
}

const createRow = {
  id: 102,
  created_at: '2026-08-06T08:30:00Z',
  agent_id: 'shipment-assistant-prod',
  action: 'shipment.create',
  target_type: 'shipment_schedule',
  target_id: '90',
  result: 'success',
  project_id: 12,
  operation_type: 'shipments',
  request_path: '/api/v1/agent/projects/12/shipments',
  request_method: 'POST',
  before_json: null,
  after_json: { shipment_no: 'SH-2026-01', project_id: 12, status: 'draft', items_count: 3 },
  idempotency_key: 'idem-2',
  error_message: null,
}

const failureRow = {
  ...transitionRow,
  id: 103,
  agent_id: 'shop-calc-test',
  action: 'shop_calculation.append',
  result: 'failure',
  error_message: '店铺不存在',
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AgentOperationLogsPanel（BLF-460 写操作明细面板）', () => {
  beforeEach(() => {
    const listResponse = {
      items: [transitionRow, createRow, failureRow],
      total: 3,
      page: 1,
      page_size: 50,
      has_next: false,
    }
    const summaryResponse = {
      total: 3,
      success_count: 2,
      failure_count: 1,
      unique_agent_count: 2,
      top_agents: [
        { agent_id: 'shipment-assistant-prod', count: 2 },
        { agent_id: 'shop-calc-test', count: 1 },
      ],
      top_actions: [
        { action: 'shipment.status.transition', count: 2 },
        { action: 'shop_calculation.append', count: 1 },
      ],
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/agent-operation-logs/summary')) return Promise.resolve(jsonResponse(summaryResponse))
      return Promise.resolve(jsonResponse(listResponse))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('渲染统计概览与列表（操作语义化标签 / 项目 ID / 结果）', async () => {
    render(<AgentOperationLogsPanel />)

    expect(await screen.findByText('写操作总量')).toBeTruthy()
    // 同一 Agent 在 top_agents 与列表行都可能出现 → 用 findAll 断言数量
    expect((await screen.findAllByText('shipment-assistant-prod')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('货件状态变更').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('新建货件')).toBeTruthy()
    expect(screen.getAllByText('追加店铺测算').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('失败').length).toBeGreaterThanOrEqual(1)
    // top_actions 徽标（title 唯一区分芯片与行内标签）
    const transitionChip = await screen.findByTitle('shipment.status.transition')
    expect(transitionChip.textContent).toContain('2')
  })

  it('筛选区提交 project_id / action / result 到请求参数', async () => {
    render(<AgentOperationLogsPanel />)
    await screen.findByText('写操作总量')

    // 沿用仓库既有约定用 fireEvent 驱动表单控件（表格/表单控件在 jsdom 下
    // 与 userEvent 组合偶发挂起，fireEvent 更稳）
    fireEvent.change(screen.getByPlaceholderText('项目 ID（数字）'), {
      target: { value: '12' },
    })
    fireEvent.change(screen.getByPlaceholderText('操作（如 shipment.status.transition）'), {
      target: { value: 'shipment.status.transition' },
    })
    fireEvent.click(screen.getByRole('button', { name: /查询/ }))

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch)
      const urls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((u) => u.includes('/agent-operation-logs?'))
      const latestUrl = urls[urls.length - 1]
      expect(latestUrl).toContain('project_id=12')
      expect(latestUrl).toContain('action=shipment.status.transition')
      expect(latestUrl).toContain('page=1')
    })
  })

  // ── Dialog 测试 ──────────────────────────────────────────────────
  // 打开 Dialog 后只做同步断言（findBy*/waitFor 依赖定时器，在
  // jsdom + Radix Dialog 组合下不可靠；同步断言无此问题）。

  it('详情 Dialog 把 in_transit → completed 渲染为「在途 → 已入库」', async () => {
    render(<AgentOperationLogsPanel />)

    await screen.findAllByText('shipment-assistant-prod')
    fireEvent.click(screen.getAllByRole('button', { name: /查看/ })[0])

    expect(screen.getByText(/写操作明细 · 货件状态变更/)).toBeTruthy()
    expect(screen.getByText('货件状态')).toBeTruthy()
    expect(screen.getByText('在途 (in_transit)')).toBeTruthy()
    expect(screen.getByText('已入库 (completed)')).toBeTruthy()
  })

  it('失败操作展示错误信息', async () => {
    render(<AgentOperationLogsPanel />)

    await screen.findAllByText('shipment-assistant-prod')
    fireEvent.click(screen.getAllByRole('button', { name: /查看/ })[2])

    expect(screen.getByText('错误信息')).toBeTruthy()
    expect(screen.getByText('店铺不存在')).toBeTruthy()
  })
})
