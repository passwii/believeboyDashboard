import { describe, expect, it } from 'vitest'
import {
  describeOperation,
  operationActionLabel,
  targetTypeLabel,
  type OperationChange,
} from './agent-operation-diff'

describe('operationActionLabel', () => {
  it('已知 action 返回中文标题', () => {
    expect(operationActionLabel('shipment.status.transition')).toBe('货件状态变更')
    expect(operationActionLabel('shipment.create')).toBe('新建货件')
    expect(operationActionLabel('shop_calculation.append')).toBe('追加店铺测算')
  })

  it('未知 action 原样返回', () => {
    expect(operationActionLabel('mystery.op')).toBe('mystery.op')
  })

  // BLF-845 精细化：与后端 endpoints/agent/*.py 的 action= 字面量全集对齐
  it('BLF-845：SKU 主数据域写操作中文化（BLF-579/628）', () => {
    expect(operationActionLabel('sku_info.upsert')).toBe('新建 SKU 主数据')
    expect(operationActionLabel('sku_info.update')).toBe('更新 SKU 主数据')
    expect(operationActionLabel('sku_info.status.transition')).toBe('SKU 上下架')
    expect(operationActionLabel('sku_info.upload_fnsku_label')).toBe('上传 FNSKU 标签')
  })

  it('BLF-845：补货设置与凭据签发写操作中文化（BLF-502/843）', () => {
    expect(operationActionLabel('replenishment_settings.upsert')).toBe('保存补货设置')
    expect(operationActionLabel('inventory_replenishment_settings.upsert')).toBe('保存补货设置')
    expect(operationActionLabel('agent_key.create')).toBe('自助签发凭据')
    expect(operationActionLabel('api_key.create')).toBe('创建凭据')
  })
})

describe('targetTypeLabel', () => {
  it('已知 target_type 返回中文', () => {
    expect(targetTypeLabel('shipment_schedule')).toBe('货件')
    expect(targetTypeLabel('shop_calculation')).toBe('店铺测算')
    expect(targetTypeLabel('new_product_calculation')).toBe('新品测算')
  })

  it('未知 target_type 原样返回', () => {
    expect(targetTypeLabel('weird_entity')).toBe('weird_entity')
  })

  it('BLF-845：新增写对象中文标签（sku_info / 补货设置 / 凭据）', () => {
    expect(targetTypeLabel('sku_info')).toBe('SKU 主数据')
    expect(targetTypeLabel('inventory_replenishment_setting')).toBe('补货设置')
    expect(targetTypeLabel('agent_api_key')).toBe('Agent 凭据')
  })
})

describe('describeOperation — 货件状态推进（核心用例）', () => {
  it('in_transit → completed 渲染为「在途 → 已入库」', () => {
    const result = describeOperation('shipment.status.transition', {
      shipment_status: 'in_transit',
    }, { shipment_status: 'completed' })
    expect(result.title).toBe('货件状态变更')
    expect(result.changes).toEqual([
      { field: '货件状态', from: '在途 (in_transit)', to: '已入库 (completed)' },
    ] satisfies OperationChange[])
  })

  it('兼容历史 complete 别称', () => {
    const result = describeOperation('shipment.status.transition', {
      shipment_status: 'in_transit',
    }, { shipment_status: 'complete' })
    expect(result.changes[0]?.to).toBe('已入库 (complete)')
  })

  it('before/after 键名不一致（status vs shipment_status）也正确归并', () => {
    const result = describeOperation('shipment.update', {
      shipment_status: 'in_transit',
      remark: '旧备注',
    }, { status: 'completed', shipment_no: 'SH-1', project_id: 12 })
    expect(result.changes).toContainEqual({
      field: '货件状态',
      from: '在途 (in_transit)',
      to: '已入库 (completed)',
    })
  })
})

describe('describeOperation — 新建/删除', () => {
  it('create（before 为 null）渲染为新增字段', () => {
    const result = describeOperation('shipment.create', null, {
      shipment_no: 'SH-2026-01',
      project_id: 12,
      status: 'draft',
      items_count: 3,
    })
    expect(result.title).toBe('新建货件')
    expect(result.changes).toContainEqual({
      field: '货件编号',
      from: null,
      to: 'SH-2026-01',
    })
    expect(result.changes).toContainEqual({
      field: '货件状态',
      from: null,
      to: '草稿 (draft)',
    })
  })

  it('delete（after 为 null）渲染为移除字段', () => {
    const result = describeOperation('shipment.delete', {
      status: 'in_transit',
      shipment_no: 'SH-1',
    }, null)
    expect(result.title).toBe('删除货件')
    expect(result.changes).toContainEqual({
      field: '货件状态',
      from: '在途 (in_transit)',
      to: null,
    })
  })
})

describe('describeOperation — 通用兜底', () => {
  it('未知 action 用 action 作为标题 + 顶层键 diff', () => {
    const result = describeOperation('mystery.replace', { count: 1 }, { count: 2, extra: 'x' })
    expect(result.title).toBe('mystery.replace')
    expect(result.changes).toEqual([
      { field: 'count', from: '1', to: '2' },
      { field: 'extra', from: null, to: 'x' },
    ])
  })

  it('未变化字段被跳过', () => {
    const result = describeOperation('mystery.op', { a: 1, b: 'same' }, { a: 1, b: 'same', c: true })
    expect(result.changes).toEqual([{ field: 'c', from: null, to: 'true' }])
  })

  it('数组/对象值折叠为 JSON', () => {
    const result = describeOperation('shipment.items.replace', { items: ['a', 'b'] }, { items: ['a', 'b', 'c'] })
    expect(result.changes[0]?.field).toBe('items')
    expect(result.changes[0]?.from).toBe('["a","b"]')
    expect(result.changes[0]?.to).toBe('["a","b","c"]')
  })

  it('after 携带 risk 标记（无幂等键）时渲染为风险标记', () => {
    const result = describeOperation('shipment.status.transition', { shipment_status: 'draft' }, { shipment_status: 'in_transit', risk: 'no_idempotency' })
    expect(result.changes).toContainEqual({
      field: '风险标记',
      from: null,
      to: '未携带幂等键',
    })
  })

  it('before 与 after 均非对象时给出单条「值」diff', () => {
    const result = describeOperation('mystery.set', 1, 2)
    expect(result.changes).toEqual([{ field: '值', from: '1', to: '2' }])
  })
})
