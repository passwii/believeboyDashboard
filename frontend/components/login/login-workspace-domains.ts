import {
  BarChart3,
  DollarSign,
  FileBarChart,
  Handshake,
  LayoutDashboard,
  ShieldUser,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

/**
 * 登录页「工作区地图」展示的 8 个业务域。
 *
 * 唯一数据权威是 `lib/sidebar-config.ts` 的 `SIDEBAR_TOP_GROUPS`；此处只做登录页自用的
 * 轻量副本（不引入 sidebar-config，避免把 CRM badge 轮询组件一起打进登录 chunk）。
 * `login-workspace-domains.test.ts` 守卫本副本与权威源的 id / label / 顺序 / 模块名一致，
 * 权威源改动会让测试失败并提示同步。
 */
export interface LoginWorkspaceDomain {
  /** 对应 `SIDEBAR_TOP_GROUPS[].id` */
  id: string
  /** 对应 `SIDEBAR_TOP_GROUPS[].label`，逐字一致 */
  label: string
  icon: LucideIcon
  /** 域内代表性模块名（逐字取自该域的 items[].title），仅作入口预览 */
  modules: string[]
}

export const LOGIN_WORKSPACE_DOMAINS: LoginWorkspaceDomain[] = [
  {
    id: 'operations',
    label: '运营',
    icon: LayoutDashboard,
    modules: ['数据流总览', '销售数据', '库存分析', '平台巡检'],
  },
  {
    id: 'reports',
    label: '报表中心',
    icon: FileBarChart,
    modules: ['财务月报', '产品分析', '订单信息', '定时报告'],
  },
  {
    id: 'finance',
    label: '财务资金',
    icon: DollarSign,
    modules: ['平台回款', '汇率信息', 'VAT 发票', '佣金管理'],
  },
  {
    id: 'advertising',
    label: '广告',
    icon: BarChart3,
    modules: ['广告分析', '广告数据'],
  },
  {
    id: 'ai',
    label: 'AI 智能',
    icon: Sparkles,
    modules: ['AI洞察', '数字员工', 'AI Chat'],
  },
  {
    id: 'crm',
    label: 'CRM 客户与合作伙伴',
    icon: Handshake,
    modules: ['数据看板', '待跟进', '客户', '线索'],
  },
  {
    id: 'tools',
    label: '工具箱',
    icon: Wrench,
    modules: ['Markdown 转换', 'Markdown/HTML 渲染'],
  },
  {
    id: 'system',
    label: '系统管理',
    icon: ShieldUser,
    modules: ['账号管理', '告警中心', '日志查看'],
  },
]
