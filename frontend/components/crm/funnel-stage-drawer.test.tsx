import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FunnelStageDrawer } from './funnel-stage-drawer'

const getFunnelStageDetail = vi.fn()

vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({ getFunnelStageDetail }),
}))

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'contacting',
    count: 2,
    avgDwellDays: 5.4,
    stuckCount: 1,
    inflow: 2,
    outflow: 3,
    stuckDays: 7,
    page: 1,
    pageSize: 10,
    total: 2,
    leads: [
      {
        id: '7',
        name: '王五',
        company: '某贸易',
        ownerId: 'u1',
        ownerName: '张三',
        source: 'referral',
        intent: 'high',
        enteredStageAt: '2026-08-01T00:00:00+00:00',
        lastActionAt: '2026-08-02T00:00:00+00:00',
        lastActionContent: '电话沟通 30 分钟',
        nextFollowAt: '2026-08-10T00:00:00+00:00',
        dwellDays: 7.5,
        isStuck: true,
      },
      {
        id: '8',
        name: '李四',
        ownerId: null,
        dwellDays: 2,
        isStuck: false,
      },
    ],
    ...overrides,
  }
}

function renderDrawer(open = true) {
  return render(
    <FunnelStageDrawer
      open={open}
      onOpenChange={vi.fn()}
      stage="contacting"
      stageLabel="联系中"
    />
  )
}

describe('FunnelStageDrawer（漏斗二层复盘面板，BLF-518）', () => {
  beforeEach(() => {
    getFunnelStageDetail.mockReset()
    getFunnelStageDetail.mockResolvedValue(makeDetail())
  })

  it('打开时按 stage 请求明细并渲染标题 + 摘要', async () => {
    renderDrawer()
    expect(getFunnelStageDetail).toHaveBeenCalledWith({
      stage: 'contacting',
      sortBy: 'dwell',
      page: 1,
      pageSize: 10,
    })
    expect(await screen.findByText('联系中 · 复盘明细')).toBeTruthy()
    // 摘要 chips：平均停留 / 卡住 N 条 / 本期流入 / 流出
    expect(await screen.findByText('平均停留 5.4 天')).toBeTruthy()
    expect(await screen.findByText('卡住 1 条（超 7 天未动）')).toBeTruthy()
    expect(await screen.findByText('本期流入 2')).toBeTruthy()
    expect(await screen.findByText('流出 3')).toBeTruthy()
  })

  it('渲染线索行：名称/公司/负责人/停留/最后动作/下次跟进，卡住行带徽标', async () => {
    renderDrawer()
    expect(await screen.findByText('王五')).toBeTruthy()
    expect(await screen.findByText('某贸易')).toBeTruthy()
    expect(await screen.findByText('张三')).toBeTruthy()
    expect(await screen.findByText('卡住')).toBeTruthy()
    expect(await screen.findByText('电话沟通 30 分钟')).toBeTruthy()
  })

  it('无最后动作的行显示「无跟进记录」', async () => {
    getFunnelStageDetail.mockResolvedValue(
      makeDetail({
        leads: [{ id: '9', name: '赵六', ownerId: null, dwellDays: 1, isStuck: false }],
      })
    )
    renderDrawer()
    expect(await screen.findByText('赵六')).toBeTruthy()
    expect(screen.getAllByText('无跟进记录').length).toBeGreaterThanOrEqual(1)
  })

  it('切换「最近动作」视图按 recent 重新请求并回到第一页', async () => {
    renderDrawer()
    await screen.findByText('联系中 · 复盘明细')
    const recentTab = screen.getByRole('tab', { name: /最近动作/ })
    // Radix Tabs 需要 pointerdown 序列（与 crm-overview-drawer 测试一致）
    fireEvent.mouseDown(recentTab)
    fireEvent.click(recentTab)
    await waitFor(() => {
      expect(getFunnelStageDetail).toHaveBeenLastCalledWith({
        stage: 'contacting',
        sortBy: 'recent',
        page: 1,
        pageSize: 10,
      })
    })
  })

  it('请求失败显示错误态，可重试', async () => {
    getFunnelStageDetail.mockRejectedValueOnce(new Error('boom'))
    renderDrawer()
    expect(await screen.findByText('加载失败')).toBeTruthy()
    getFunnelStageDetail.mockResolvedValueOnce(makeDetail())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.queryByText('加载失败')).toBeNull())
  })

  it('分页：total > pageSize 时显示翻页控件', async () => {
    getFunnelStageDetail.mockResolvedValue(makeDetail({ total: 25, pageSize: 10 }))
    renderDrawer()
    expect(await screen.findByText('共 25 条 · 第 1/3 页')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => {
      expect(getFunnelStageDetail).toHaveBeenLastCalledWith({
        stage: 'contacting',
        sortBy: 'dwell',
        page: 2,
        pageSize: 10,
      })
    })
  })

  it('关闭时不请求', () => {
    renderDrawer(false)
    expect(getFunnelStageDetail).not.toHaveBeenCalled()
  })
})
