import { describe, expect, it } from 'vitest'

import {
  INVENTORY_OUTPUT_SLOT,
  inventoryScopeLabel,
  toInventoryPanelState,
  toInventoryRunInput,
} from './inventory-insight'

/**
 * BLF-1017：库存口径与广告不同——单日快照（`report_date` 可缺省 = 最新快照），
 * 不是日期区间。这里钉住该域独有的映射：缺省日不带 `report_date`、未选项目不提交、
 * 断流重连期间以 run 状态（后端权威）优先于传输层状态。
 */
describe('toInventoryRunInput', () => {
  it('带口径日时提交 report_date 单日字段', () => {
    expect(
      toInventoryRunInput({ projectId: 12, country: 'DE', reportDate: new Date(2026, 8, 7) })
    ).toEqual({ project_id: 12, country: 'DE', report_date: '2026-09-07' })
  })

  it('口径日缺省时不带 report_date（后端按最新快照口径）', () => {
    expect(toInventoryRunInput({ projectId: 12, country: 'US' })).toEqual({
      project_id: 12,
      country: 'US',
    })
    expect(toInventoryRunInput({ projectId: 12, country: 'US', reportDate: null })).toEqual({
      project_id: 12,
      country: 'US',
    })
  })

  it('未选项目时不提交', () => {
    expect(toInventoryRunInput({ projectId: null, country: 'US' })).toBeNull()
    expect(toInventoryRunInput({ projectId: 0, country: 'US' })).toBeNull()
  })
})

describe('inventoryScopeLabel', () => {
  it('缺省口径日显示「最新快照」', () => {
    expect(inventoryScopeLabel({ projectId: 1, country: 'UK' })).toBe('UK · 最新快照')
    expect(
      inventoryScopeLabel({ projectId: 1, country: 'UK', reportDate: new Date(2026, 0, 3) })
    ).toBe('UK · 2026-01-03')
  })
})

describe('toInventoryPanelState', () => {
  it('拿不到 run 状态时退回传输层文案，且视为忙碌', () => {
    const state = toInventoryPanelState({
      runStatus: null,
      transport: 'queued',
      progress: null,
    })
    expect(state.status).toBe('queued')
    expect(state.label).toBe('准备提交分析任务')
    expect(state.busy).toBe(true)
    // 排队 / 连接 / 重连期间没有增量在推，不给流式光标
    expect(state.isStreaming).toBe(false)
  })

  it('传输层重连且拿不到 run 状态：仍算在跑，但不按在推内容渲染', () => {
    const state = toInventoryPanelState({
      runStatus: null,
      transport: 'reconnecting',
      progress: null,
    })
    expect(state.status).toBe('reconnecting')
    expect(state.label).toBe('连接中断，正在重连')
    expect(state.busy).toBe(true)
    expect(state.isStreaming).toBe(false)
  })

  it('run 仍在推进但传输断了：以 run 状态为准，文案提示重连', () => {
    const state = toInventoryPanelState({
      runStatus: 'generating',
      transport: 'reconnecting',
      progress: 40,
    })
    expect(state.status).toBe('generating')
    expect(state.label).toBe('连接中断，正在重连')
    expect(state.busy).toBe(true)
    // 断流时不能按 draft 渲染：没有增量在推
    expect(state.isStreaming).toBe(false)
    expect(state.progress).toBe(40)
  })

  it('终态不再显示进度、不再忙碌', () => {
    const state = toInventoryPanelState({
      runStatus: 'completed',
      transport: 'completed',
      progress: 100,
    })
    expect(state.label).toBe('库存健康分析已完成')
    expect(state.progress).toBeNull()
    expect(state.busy).toBe(false)
  })
})

describe('INVENTORY_OUTPUT_SLOT', () => {
  it('对齐 inventory_health.v1 role 的输出槽', () => {
    expect(INVENTORY_OUTPUT_SLOT).toBe('main')
  })
})
