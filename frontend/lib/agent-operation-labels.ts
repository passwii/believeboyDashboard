/** Agent 访问与写操作的中文标签单一事实源。 */

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
