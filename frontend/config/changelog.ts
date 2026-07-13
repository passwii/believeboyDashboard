export interface ChangeLogEntry {
  id: string
  date: string
  version?: string
  title: string
  content: string
  highlights?: string[]
}

/**
 * 更新日志
 *
 * 使用说明：
 * 1. 每次发布新功能后，在数组头部添加新条目
 * 2. id 格式：'YYYY-MM-DD-序号'，如 '2026-04-03-001'
 * 3. date 格式：'YYYY-MM-DD'
 * 4. content 支持多段落，用 \n\n 分隔
 * 5. highlights 为可选的重点列表
 */
export const changeLog: ChangeLogEntry[] = [
  {
    id: '2026-06-21-001',
    date: '2026-06-21',
    version: 'v1.3.0',
    title: '新增「订单信息」页面（数据管理）',
    content:
      'BEL-157 新增「数据管理 → 订单信息」页面，集中展示各店铺订单明细。\n\n1. 下单时间自动换算为北京时间，下方备注 PT 原始日期（PDT）\n2. 按店铺、订单类型（FBA / FBM）、状态、国家、币种、SKU / 订单号 / ASIN、时间区间多维筛选\n3. 支持排序、数量/金额显示、按当前筛选条件导出 CSV\n4. 顶部统计条实时聚合订单数、总数量、总金额、FBA·FBM 分布',
    highlights: [
      '侧边栏新增「订单信息」入口（位于发货管理和 SKU 信息之间）',
      '后端：app/services/data/order_info_service.py + /api/v1/order-info/* 五个端点',
      '前端：/dashboard/data-management/order-info 页面 + Next.js API 路由转发',
    ],
  },
  {
    id: '2026-04-03-001',
    date: '2026-04-03',
    version: 'v1.2.0',
    title: '新增功能更新通知系统',
    content:
      '本次更新包含以下内容：\n\n1. 新增更新日志弹窗通知\n2. 用户可以在下次打开页面时看到最新功能介绍\n3. 优化了整体用户体验',
    highlights: ['新增 changelog 弹窗', '支持查看历史更新', '自动检测未读更新'],
  },
]
