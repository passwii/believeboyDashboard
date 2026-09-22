/** Agent 访问与写操作的中文标签单一事实源。 */

import { getAgentDomain } from './agent-domains'

const ACTION_TITLES: Record<string, string> = {
  // 货件域
  'shipment.create': '新建货件',
  'shipment.update': '更新货件',
  'shipment.items.replace': '替换货件明细',
  'shipment.status.transition': '货件状态变更',
  'shipment.recalculate_costs': '重算货件费用',
  'shipment.delete': '删除货件',
  // 测算域
  'shop_calculation.append': '追加店铺测算',
  'new_product_calculation.upsert': '保存新品测算',
  // SKU 主数据域
  'sku_info.upsert': '新建 SKU 主数据',
  'sku_info.update': '更新 SKU 主数据',
  'sku_info.status.transition': 'SKU 上下架',
  'sku_info.delete': '删除 SKU 主数据',
  'sku_info.upload_fnsku_label': '上传 FNSKU 标签',
  'sku_info.listing_copy.batch': '批量更新 Listing 文案',
  // 补货设置域
  'replenishment_settings.upsert': '保存补货设置',
  'inventory_replenishment_settings.upsert': '保存补货设置',
  // 平台巡检域
  'platform_inspection.save': '保存平台巡检',
  'platform_inspection.submit': '提交平台巡检',
  'platform_inspection.upload_screenshot': '上传巡检截图',
  'platform_inspection.delete_screenshot': '删除巡检截图',
  // 客诉中心域
  'complaint_center.batch_write': '批量写入客诉',
  // 凭据签发域
  'agent_key.create': '自助签发凭据',
  'api_key.create': '创建凭据',
  'agent_key.update': '更新凭据权限',
  'api_key.update': '更新凭据',
}

export function operationActionLabel(action: string): string {
  return ACTION_TITLES[action] ?? action
}

type AccessRouteLabel = {
  method: string
  pattern: RegExp
  label: string
}

const route = (
  method: string,
  pattern: RegExp,
  label: string
): AccessRouteLabel => ({ method, pattern, label })

/**
 * Agent API 访问路径标签，具体资源动作必须排在通用路径之前。
 *
 * 路径不包含 query string；保留正则而非字符串替换，是为了同时覆盖
 * 项目、货件、SKU、巡检周期等动态参数，并让同一表能处理读写访问日志。
 */
const ACCESS_ROUTE_LABELS: AccessRouteLabel[] = [
  route('GET', /\/health\/?$/, 'Agent 健康检查'),
  route('GET', /\/projects\/?$/, '查询项目列表'),

  // 货件：具体资源动作 → 列表；写路径与 operation action 复用同一语义。
  route('GET', /\/projects\/\d+\/shipments\/[^/]+\/audit\/?$/, '查询货件审计'),
  route('GET', /\/projects\/\d+\/shipments\/[^/]+\/sku-summary\/?$/, '查询货件 SKU 汇总'),
  route('GET', /\/projects\/\d+\/shipments\/[^/]+\/fba-box-detail\/?$/, '查询货件装箱明细'),
  route('GET', /\/projects\/\d+\/shipments\/[^/]+\/fba-delivery-template\/?$/, '导出 FBA 配送模板'),
  route('POST', /\/projects\/\d+\/shipments\/[^/]+\/recalculate-costs\/?$/, '重算货件费用'),
  route('POST', /\/projects\/\d+\/shipments\/[^/]+\/status\/?$/, '货件状态变更'),
  route('PUT', /\/projects\/\d+\/shipments\/[^/]+\/items\/?$/, '替换货件明细'),
  route('PATCH', /\/projects\/\d+\/shipments\/[^/]+\/?$/, '更新货件'),
  route('DELETE', /\/projects\/\d+\/shipments\/[^/]+\/?$/, '删除货件'),
  route('GET', /\/projects\/\d+\/shipments\/[^/]+\/?$/, '查询货件详情'),
  route('POST', /\/projects\/\d+\/shipments\/?$/, '新建货件'),
  route('GET', /\/projects\/\d+\/shipments\/?$/, '查询货件列表'),

  // 店铺测算与新品测算。
  route('GET', /\/projects\/\d+\/shop-calculations\/skus\/[^/]+\/audit\/?$/, '查询 SKU 测算审计'),
  route('GET', /\/projects\/\d+\/shop-calculations\/skus\/[^/]+\/history\/?$/, '查询 SKU 测算历史'),
  route('GET', /\/projects\/\d+\/shop-calculations\/skus\/[^/]+\/?$/, '查询 SKU 当前测算'),
  route('POST', /\/projects\/\d+\/shop-calculations\/compute\/?$/, '试算店铺测算'),
  route('POST', /\/projects\/\d+\/shop-calculations\/?$/, '追加店铺测算'),
  route('GET', /\/projects\/\d+\/shop-calculations\/?$/, '查询店铺测算列表'),
  route('GET', /\/projects\/\d+\/shop-calculation-history\/?$/, '查询店铺测算历史'),
  route('GET', /\/projects\/\d+\/shop-calculation\/snapshots\/?$/, '查询店铺测算快照'),
  route('GET', /\/projects\/\d+\/new-product-calculations\/skus\/[^/]+\/audit\/?$/, '查询 SKU 新品测算审计'),
  route('GET', /\/projects\/\d+\/new-product-calculations\/skus\/[^/]+\/?$/, '查询 SKU 新品测算'),
  route('POST', /\/projects\/\d+\/new-product-calculations\/compute\/?$/, '试算新品测算'),
  route('POST', /\/projects\/\d+\/new-product-calculations\/?$/, '保存新品测算'),
  route('GET', /\/projects\/\d+\/new-product-calculations\/?$/, '查询新品测算列表'),

  // SKU 主数据。
  route('GET', /\/projects\/\d+\/sku-info\/\d+\/audit\/?$/, '查询 SKU 主数据审计'),
  route('POST', /\/projects\/\d+\/sku-info\/\d+\/fnsku-label\/?$/, '上传 FNSKU 标签'),
  route('POST', /\/projects\/\d+\/sku-info\/\d+\/status\/?$/, 'SKU 上下架'),
  route('DELETE', /\/projects\/\d+\/sku-info\/\d+\/?$/, '删除 SKU 主数据'),
  route('PATCH', /\/projects\/\d+\/sku-info\/\d+\/?$/, '更新 SKU 主数据'),
  route('GET', /\/projects\/\d+\/sku-info\/\d+\/?$/, '查询 SKU 主数据详情'),
  route('POST', /\/projects\/\d+\/sku-info\/listing-copy\/batch\/?$/, '批量更新 Listing 文案'),
  route('POST', /\/projects\/\d+\/sku-info\/?$/, '新建 SKU 主数据'),
  route('GET', /\/projects\/\d+\/sku-info\/?$/, '查询 SKU 主数据列表'),

  // 退货、补货与库存。
  route('GET', /\/projects\/\d+\/return-analysis\/overview\/?$/, '查询退货分析概览'),
  route('GET', /\/projects\/\d+\/return-analysis\/skus\/[^/]+\/?$/, '查询 SKU 退货分析'),
  route('GET', /\/projects\/\d+\/return-analysis\/coverage\/?$/, '查询退货分析覆盖度'),
  route('GET', /\/projects\/\d+\/return-analysis-raw\/?$/, '查询退货分析原始数据'),
  route('GET', /\/projects\/\d+\/return-analysis\/?$/, '查询退货分析汇总'),
  route('GET', /\/projects\/\d+\/replenishment-analysis\/skus\/[^/]+\/?$/, '查询 SKU 补货分析'),
  route('GET', /\/projects\/\d+\/replenishment-analysis\/summary\/?$/, '查询补货分析总览'),
  route('GET', /\/projects\/\d+\/replenishment-analysis\/coverage\/?$/, '查询补货覆盖度'),
  route('GET', /\/projects\/\d+\/replenishment-analysis\/settings\/?$/, '读取补货设置'),
  route('PUT', /\/projects\/\d+\/replenishment-analysis\/settings\/[^/]+\/?$/, '保存补货设置'),
  route('GET', /\/projects\/\d+\/replenishment-analysis\/?$/, '查询补货分析清单'),
  route('GET', /\/projects\/\d+\/inventory\/?$/, '查询库存信息'),

  // 库存台账。
  route('GET', /\/projects\/\d+\/inventory-ledger\/months\/?$/, '查询库存台账可用月份'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/snapshot\/?$/, '查询库存台账快照'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/events\/?$/, '查询库存台账事件'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/receipt-clusters\/?$/, '查询库存台账入库簇'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/integrity\/?$/, '检查库存台账完整性'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/trend\/?$/, '查询库存台账趋势'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/detail\/?$/, '查询库存台账明细'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/summary\/?$/, '查询库存台账汇总'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/batches\/?$/, '查询库存台账批次'),
  route('GET', /\/projects\/\d+\/inventory-ledger\/consistency\/?$/, '检查库存台账一致性'),

  // 巡检健康与平台巡检。
  route('GET', /\/account-health\/periods\/current\/?$/, '查询当前巡检周期'),
  route('GET', /\/account-health\/periods\/\d+\/overview\/?$/, '查询巡检周期概览'),
  route('GET', /\/account-health\/periods\/\d+\/projects\/\d+\/?$/, '查询项目巡检报告'),
  route('GET', /\/account-health\/history\/?$/, '查询巡检历史'),
  route('GET', /\/account-health\/periods\/?$/, '查询巡检周期列表'),
  route('GET', /\/platform-inspection\/template\/?$/, '获取平台巡检模板'),
  route('PUT', /\/platform-inspection\/periods\/\d+\/projects\/\d+\/?$/, '保存平台巡检'),
  route('POST', /\/platform-inspection\/periods\/\d+\/projects\/\d+\/submit\/?$/, '提交平台巡检'),
  route('POST', /\/platform-inspection\/periods\/\d+\/projects\/\d+\/screenshots\/?$/, '上传巡检截图'),
  route('DELETE', /\/platform-inspection\/screenshots\/\d+\/?$/, '删除巡检截图'),

  // 销售、广告与报表。
  route('GET', /\/projects\/\d+\/sales\/summary\/?$/, '查询销售数据汇总'),
  route('GET', /\/projects\/\d+\/ad-campaigns-raw\/?$/, '查询广告活动原始数据'),
  route('GET', /\/projects\/\d+\/ad-campaign-raw\/?$/, '查询广告活动原始数据'),
  route('GET', /\/projects\/\d+\/ad-campaigns\/?$/, '查询广告活动汇总'),
  route('GET', /\/projects\/\d+\/ad-budgets-raw\/?$/, '查询广告预算原始数据'),
  route('GET', /\/projects\/\d+\/ad-budget-raw\/?$/, '查询广告预算原始数据'),
  route('GET', /\/projects\/\d+\/ad-budgets\/?$/, '查询广告预算汇总'),
  route('GET', /\/projects\/\d+\/ad-targets-raw\/?$/, '查询广告目标原始数据'),
  route('GET', /\/projects\/\d+\/ad-target-raw\/?$/, '查询广告目标原始数据'),
  route('GET', /\/projects\/\d+\/ad-targets\/?$/, '查询广告目标汇总'),
  route('GET', /\/projects\/\d+\/ad-placements-raw\/?$/, '查询广告版位原始数据'),
  route('GET', /\/projects\/\d+\/ad-placement-raw\/?$/, '查询广告版位原始数据'),
  route('GET', /\/projects\/\d+\/ad-placements\/?$/, '查询广告版位汇总'),
  route('GET', /\/projects\/\d+\/ad-promoted-products-raw\/?$/, '查询推广商品原始数据'),
  route('GET', /\/projects\/\d+\/ad-promoted-product-raw\/?$/, '查询推广商品原始数据'),
  route('GET', /\/projects\/\d+\/ad-promoted-products\/?$/, '查询推广商品汇总'),
  route('GET', /\/projects\/\d+\/ad-purchased-products-raw\/?$/, '查询购买商品原始数据'),
  route('GET', /\/projects\/\d+\/ad-purchased-product-raw\/?$/, '查询购买商品原始数据'),
  route('GET', /\/projects\/\d+\/ad-purchased-products\/?$/, '查询购买商品汇总'),
  route('GET', /\/projects\/\d+\/ad-search-terms-raw\/?$/, '查询广告搜索词原始数据'),
  route('GET', /\/projects\/\d+\/ad-search-term-raw\/?$/, '查询广告搜索词原始数据'),
  route('GET', /\/projects\/\d+\/ad-search-terms\/?$/, '查询广告搜索词汇总'),
  route('GET', /\/projects\/\d+\/ad-search-term-shares-raw\/?$/, '查询搜索词份额原始数据'),
  route('GET', /\/projects\/\d+\/ad-search-term-share-raw\/?$/, '查询搜索词份额原始数据'),
  route('GET', /\/projects\/\d+\/ad-search-term-shares\/?$/, '查询搜索词份额汇总'),
  route('GET', /\/projects\/\d+\/ad-invalid-traffic-raw\/?$/, '查询无效流量原始数据'),
  route('GET', /\/projects\/\d+\/ad-invalid-traffic\/?$/, '查询无效流量汇总'),
  route('GET', /\/projects\/\d+\/ad-time-trends-raw\/?$/, '查询广告时间趋势原始数据'),
  route('GET', /\/projects\/\d+\/ad-time-trend-raw\/?$/, '查询广告时间趋势原始数据'),
  route('GET', /\/projects\/\d+\/ad-time-trends\/?$/, '查询广告时间趋势汇总'),
  route('GET', /\/report-upload-status\/?$/, '查询报表上传状态'),
  route('POST', /\/upload\/validate\/?$/, '校验报表上传'),
  route('POST', /\/upload\/commit\/?$/, '提交报表上传'),

  // 项目级基础设施、客诉与凭据。
  route('GET', /\/pricing-snapshots\/?$/, '查询店铺定价快照'),
  route('GET', /\/complaint-center\/complaints\/?$/, '查询客诉列表'),
  route('POST', /\/complaint-center\/batch\/?$/, '批量写入客诉'),
  route('GET', /\/provisioning\/keys\/?$/, '查询凭据列表'),
  route('POST', /\/provisioning\/keys\/?$/, '自助签发凭据'),
  route('PATCH', /\/provisioning\/keys\/\d+\/?$/, '更新凭据权限'),
]

export function accessOperationLabel(
  method: string,
  path: string,
  operationType: string | null
): string {
  const normalizedMethod = method.trim().toUpperCase()
  const pathname = path.split('?')[0]
  const match = ACCESS_ROUTE_LABELS.find(
    (item) => item.method === normalizedMethod && item.pattern.test(pathname)
  )
  if (match) return match.label
  if (operationType) return getAgentDomain(operationType)?.label ?? operationType
  return '-'
}
