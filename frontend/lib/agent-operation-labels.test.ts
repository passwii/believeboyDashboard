import { describe, expect, it } from 'vitest'
import { accessOperationLabel, operationActionLabel } from './agent-operation-labels'

describe('operationActionLabel', () => {
  it('映射当前 Agent 全部写 action', () => {
    const expected: Record<string, string> = {
      'shipment.create': '新建货件',
      'shipment.update': '更新货件',
      'shipment.items.replace': '替换货件明细',
      'shipment.status.transition': '货件状态变更',
      'shipment.recalculate_costs': '重算货件费用',
      'shipment.delete': '删除货件',
      'shop_calculation.append': '追加店铺测算',
      'new_product_calculation.upsert': '保存新品测算',
      'new_product_calculation.export': '导出新品测算对比矩阵',
      'sku_info.upsert': '新建 SKU 主数据',
      'sku_info.update': '更新 SKU 主数据',
      'sku_info.status.transition': 'SKU 上下架',
      'sku_info.delete': '删除 SKU 主数据',
      'sku_info.upload_fnsku_label': '上传 FNSKU 标签',
      'sku_info.listing_copy.batch': '批量更新 Listing 文案',
      'replenishment_settings.upsert': '保存补货设置',
      'inventory_replenishment_settings.upsert': '保存补货设置',
      'platform_inspection.save': '保存平台巡检',
      'platform_inspection.submit': '提交平台巡检',
      'platform_inspection.upload_screenshot': '上传巡检截图',
      'platform_inspection.delete_screenshot': '删除巡检截图',
      'complaint_center.batch_write': '批量写入客诉',
      'agent_key.create': '自助签发凭据',
      'api_key.create': '创建凭据',
      'agent_key.update': '更新凭据权限',
      'api_key.update': '更新凭据',
    }

    for (const [action, label] of Object.entries(expected)) {
      expect(operationActionLabel(action)).toBe(label)
    }
  })

  it('未知 action 原样返回', () => {
    expect(operationActionLabel('mystery.op')).toBe('mystery.op')
  })
})

describe('accessOperationLabel', () => {
  it('区分同一业务域的列表、详情和审计读取', () => {
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/projects/12/shipments',
        'shipments'
      )
    ).toBe('查询货件列表')
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/projects/12/shipments/SH-1',
        'shipments'
      )
    ).toBe('查询货件详情')
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/projects/12/shipments/SH-1/audit',
        'shipments'
      )
    ).toBe('查询货件审计')
  })

  it('覆盖测算、巡检和客诉读接口', () => {
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/projects/12/new-product-calculations/export.xlsx',
        'new_product_calculations'
      )
    ).toBe('导出新品测算对比矩阵')
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/projects/12/shop-calculations/skus/A-1/history',
        'shop_calculations'
      )
    ).toBe('查询 SKU 测算历史')
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/platform-inspection/template',
        'platform_inspection'
      )
    ).toBe('获取平台巡检模板')
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/complaint-center/complaints',
        'complaint_center'
      )
    ).toBe('查询客诉列表')
  })

  it('访问日志中的写路径复用 action 语义', () => {
    expect(
      accessOperationLabel(
        'POST',
        '/api/v1/agent/projects/12/shipments/SH-1/recalculate-costs',
        'shipments'
      )
    ).toBe('重算货件费用')
    expect(
      accessOperationLabel(
        'POST',
        '/api/v1/agent/platform-inspection/periods/3/projects/12/submit',
        'platform_inspection'
      )
    ).toBe('提交平台巡检')
  })

  it('具体路径优先于通用路径，未知值回退可排查标识', () => {
    expect(
      accessOperationLabel(
        'GET',
        '/api/v1/agent/projects/12/shipments/SH-1/sku-summary',
        'shipments'
      )
    ).toBe('查询货件 SKU 汇总')
    expect(
      accessOperationLabel('GET', '/api/v1/agent/unknown-resource', 'unknown_domain')
    ).toBe('unknown_domain')
    expect(accessOperationLabel('GET', '/api/v1/agent/unknown-resource', null)).toBe('-')
  })
})
