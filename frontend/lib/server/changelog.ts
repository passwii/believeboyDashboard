export type ReleaseStatus = 'archived' | 'stable' | 'current'

export type ReleaseHighlight = {
  area: string
  title: string
  detail: string
}

export type ReleaseVersion = {
  version: string
  codename: string
  status: ReleaseStatus
  startDate: string
  endDate: string
  summary: string
  focus: string[]
  highlights: ReleaseHighlight[]
  sourceLogs: string[]
}

export type ChangelogSnapshot = {
  releases: ReleaseVersion[]
  currentRelease: ReleaseVersion
  stats: {
    versionCount: number
    highlightCount: number
    logCount: number
    moduleCount: number
  }
  source: {
    mode: 'processed-history-logs'
    label: string
    updatedAt: string
  }
}

const RELEASES: ReleaseVersion[] = [
  {
    version: 'V1',
    codename: '基础搭建',
    status: 'archived',
    startDate: '2026-02-23',
    endDate: '2026-02-24',
    summary:
      '完成 Dashboard 基础骨架、README 与侧边栏结构同步，并首轮重构销售日报页面，建立产品的第一版运营化工作台。',
    focus: ['控制台框架', '侧边栏导航', '销售日报', '基础文档'],
    highlights: [
      {
        area: 'Platform',
        title: '搭建 Dashboard 应用骨架',
        detail: '完成 Next.js 仪表盘脚手架、基础布局和项目结构初始化，为后续模块扩展提供统一容器。',
      },
      {
        area: 'Navigation',
        title: '同步侧边栏与文档信息架构',
        detail: '将 README、Dox 与页面导航对齐，明确系统入口和运营路径。',
      },
      {
        area: 'Reporting',
        title: '首轮重构销售日报页面',
        detail: '销售日报页面按照新的设计规范改版，形成后续报表页可复用的 UI 基线。',
      },
    ],
    sourceLogs: [
      'feat: scaffold dashboard app and refresh README',
      'V1 文档: 同步 Dox 与 README 到侧边栏运营化改版',
      'feat(ui): 重构销售日报页面并同步设计规范',
    ],
  },
  {
    version: 'V2',
    codename: '运营中台成型',
    status: 'archived',
    startDate: '2026-02-25',
    endDate: '2026-02-26',
    summary:
      '系统从单页工作台扩展为多模块运营后台，补齐项目管理、系统管理、月报、数据分析与 AI 对话能力。',
    focus: ['项目管理', '系统管理', '月度报表', 'AI 聊天', '深色模式'],
    highlights: [
      {
        area: 'Management',
        title: '新增项目管理与系统管理能力',
        detail: '建立项目、账号与系统配置相关的管理入口，后台从工具页升级为运营系统。',
      },
      {
        area: 'Analysis',
        title: '月报与数据分析模块成型',
        detail: '完善月度报告、分析页面与相关服务，为经营核算建立第一层分析视图。',
      },
      {
        area: 'AI',
        title: '接入 AI 聊天与会话能力',
        detail: '补上 AI Chat 数据表与前端入口，开始形成辅助运营分析的智能面板。',
      },
      {
        area: 'UI',
        title: '优化深色模式与会话体验',
        detail: '统一深浅色视觉表现，改善页面在不同主题下的可读性和一致性。',
      },
    ],
    sourceLogs: [
      'V2.25 更新数据库-1 SKU成本',
      '添加项目管理和系统管理功能',
      'V2.26 Fix',
      'UI/UX: 优化深色模式样式和会话配置',
      'feat: 完善月报功能与数据分析模块',
      'feat: 添加 AI 聊天功能与数据分析增强',
    ],
  },
  {
    version: 'V3',
    codename: '经营治理升级',
    status: 'archived',
    startDate: '2026-03-01',
    endDate: '2026-03-07',
    summary:
      '围绕经营核算与数据治理升级，逐步补齐汇率、佣金、类目研究、周度分析与系统管理主链路。',
    focus: ['汇率管理', '佣金管理', '类目研究', '周度产品分析', '系统管理增强'],
    highlights: [
      {
        area: 'Finance',
        title: '建立汇率与佣金治理能力',
        detail: '新增汇率管理、佣金管理与 V2 规则迭代，让经营核算具备更完整的财务配置能力。',
      },
      {
        area: 'Research',
        title: '上线类目研究完整链路',
        detail: '从表结构、服务、页面到测试补齐类目研究模块，并持续修复研究分析页问题。',
      },
      {
        area: 'Analysis',
        title: '强化月报、产品分析与周度分析',
        detail: '月报、产品分析源持久化和每周产品分析能力持续增强，分析模块开始系统化。',
      },
      {
        area: 'UX',
        title: '重构调研分析页面布局',
        detail: '页面调整为更适合长内容浏览的滚动式布局，并处理溢出和阅读节奏问题。',
      },
    ],
    sourceLogs: [
      'feat: 添加月度报告、产品分析源持久化和Redis缓存支持',
      'feat: 每周产品分析增强',
      'feat: 添加汇率管理功能、用户账户全名字段及相关页面优化',
      'feat: 佣金管理V2 + 产品成本增强 + 系统管理功能完善',
      '更新系统管理模块：重构佣金管理、项目管理，新增数据分析页面',
      'feat: 添加类目研究功能，优化产品成本排序 API',
      'feat: 实现类目研究服务和产品成本排序逻辑，添加测试',
      'feat: 重构品类调研分析页面为滚动式布局并优化溢出处理',
    ],
  },
  {
    version: 'V4',
    codename: '执行链路完善',
    status: 'stable',
    startDate: '2026-03-10',
    endDate: '2026-03-18',
    summary:
      '发货、库存、定价、权限和导出能力集中落地，系统进入面向运营执行的协同工作台阶段。',
    focus: ['发货管理', '库存补货', '定价核算', '权限控制', 'Excel 导出'],
    highlights: [
      {
        area: 'Logistics',
        title: '发货管理与船期维护能力成熟',
        detail: '发货计划支持国家字段、批次编辑、SKU 明细维护、货件编号搜索与状态简化，执行链路明显完善。',
      },
      {
        area: 'Inventory',
        title: '补货分析与库存分析上线',
        detail: '库存补货、库存分析页面与服务逐步补齐，库存决策开始具备独立的数据工作区。',
      },
      {
        area: 'Pricing',
        title: '定价核算进入深水区',
        detail: '支持批量导入、运行类型切换、快照存档、佣金率配置、矩阵对比加粗和多轮 Excel 导出优化。',
      },
      {
        area: 'Security',
        title: '加强项目权限与账号安全',
        detail: '补上项目访问检查、运营查看权限修复与密码管理，减少跨项目访问风险。',
      },
      {
        area: 'Experience',
        title: '加载态与响应式体验升级',
        detail: '增加页面骨架屏、加载提示与响应式布局优化，让高频运营页面更稳定可用。',
      },
    ],
    sourceLogs: [
      'feat: 添加汇率管理、库存补货、发货计划等功能',
      'feat: add country field support and improve shipment schedules',
      'feat: add password management and improve user authentication',
      'feat: add CSV batch import for SKU cost',
      'feat: support pricing calculation run types and deletion',
      'Add styled Excel exports for analysis dashboards',
      'feat: 添加店铺 SKU 核算快照功能及发货成本计算优化',
      '新增Excel导出定价功能',
      'feat: 添加定价计算的佣金率(commission_rate)可配置功能',
      '收紧项目权限控制',
      'feat(frontend): 添加页面加载状态骨架屏和更新提示',
      'feat: 支持在编辑页面直接维护船期批次SKU明细',
      'feat: 添加货件编号搜索过滤功能和总数量统计',
      '优化库存补货页面 UI 并修复发货管理相关逻辑',
      'feat: 新增库存分析页面',
    ],
  },
  {
    version: 'V5',
    codename: '数据链路重构',
    status: 'stable',
    startDate: '2026-03-19',
    endDate: '2026-03-20',
    summary:
      '重构报表上传与分析数据链路，补齐历史数据回填与清洗流程，为后续广告分析和多源报表奠定稳定底座。',
    focus: ['报表上传', '日报分析', '数据回填', '历史清洗', '分析工作流'],
    highlights: [
      {
        area: 'Pipeline',
        title: '重构报表上传与日报分析流程',
        detail: '上传、状态跟踪、日报分析与分析源之间的关系被重新整理，数据链路更清晰。',
      },
      {
        area: 'History',
        title: '补齐历史广告与补货日期数据',
        detail: '针对广告报表、补库存报告等历史数据做 ReportDate 回填与补全，降低旧数据缺失对分析的影响。',
      },
      {
        area: 'Cleanup',
        title: '清理异常付款报告历史',
        detail: '删除错误、重复与过旧的付款报告历史，减少脏数据对财务与分析模块的干扰。',
      },
      {
        area: 'Workflow',
        title: '更新研究与分析工作流',
        detail: '类目研究和分析流程继续深化，为后续更完整的广告/库存分析提供统一节奏。',
      },
    ],
    sourceLogs: [
      '重构报表上传与日报分析流程',
      '补库存报告 ReportDate 云端回填迁移',
      '补广告报表 ReportDate 回填迁移',
      '清理玥涵早期错误付款报告历史',
      '清理 2026 年前付款报告历史',
      '补齐数据管理页面更新',
      'feat: update category research and analysis workflow',
      '补全历史广告数据，包含手动日报部分数据',
    ],
  },
  {
    version: 'V6',
    codename: '分析工作台',
    status: 'archived',
    startDate: '2026-03-23',
    endDate: '2026-04-10',
    summary:
      '广告分析模块正式加入主工作台，仪表盘、导航、导出体验与界面细节集中打磨，并持续扩展 AI 聊天、物流同步、SKU 管理与系统安全能力，形成分析工作台的完整形态。',
    focus: [
      '广告分析',
      '仪表盘改版',
      '导航优化',
      'Excel 体验',
      '界面抛光',
      'AI聊天增强',
      '物流同步',
      'SKU管理',
      '权限安全',
    ],
    highlights: [
      {
        area: 'Ads',
        title: '广告分析模块上线',
        detail: '新增广告分析主模块及分页面结构，让投放数据首次成为 Dashboard 的独立分析域。',
      },
      {
        area: 'Dashboard',
        title: '仪表盘信息密度与节奏重排',
        detail: '优化布局、间距、描述文案和组件导航，让首页与分析页的浏览效率更高。',
      },
      {
        area: 'Navigation',
        title: '侧边栏快捷入口重做',
        detail: '更新常用链接、增强分组与视觉层次，使高频页面切换更顺手。',
      },
      {
        area: 'Export',
        title: '持续打磨定价与发货 Excel 导出',
        detail: '补齐规则列、颜色映射、分组表头与汇总行位置等细节，导出结果更适合直接交付使用。',
      },
      {
        area: 'Polish',
        title: '多页面 UI 细节统一抛光',
        detail: '对研究分析 Tab、项目创建错误、侧边栏阴影与界面交互做收口，形成当前稳定版本。',
      },
      {
        area: 'AI',
        title: 'AI 聊天能力全面升级',
        detail: '新增消息重生成、置顶、搜索、实时流式响应功能，支持文件上传与搜索来源展示，适配暗色模式与语义化主题色。',
      },
      {
        area: 'Logistics',
        title: '物流同步与发货管理增强',
        detail: '新增头程成本同步功能，优化发货状态筛选逻辑，增强 Redis 缓存策略与物流单价同步，完善发货 SKU 汇总筛选。',
      },
      {
        area: 'SKU',
        title: 'SKU 成本管理功能完善',
        detail: '新增删除功能、增大默认分页数、增强 CSV 解析能力，支持批量操作与更高效的数据管理。',
      },
      {
        area: 'Analysis',
        title: '分析能力持续扩展',
        detail: '周度分析新增库存列，财务数据新增净利率展示，优化日报分析日期范围计算，增强分析报表的完整性。',
      },
      {
        area: 'System',
        title: '系统管理与安全增强',
        detail: '统一错误提示为通知系统，增强审计日志序列同步与月报解析鲁棒性，新增用户在线状态与产品更新功能。',
      },
      {
        area: 'Security',
        title: '权限控制加强',
        detail: '增强定价测算权限控制，修复发货计划成本计算权限校验，确保操作安全合规。',
      },
      {
        area: 'Report',
        title: '报告上传与月报服务增强',
        detail: '优化报告上传前端交互，增强月报服务及财务数据分析能力，修复时区计算问题，确保数据按目标市场时区准确呈现。',
      },
    ],
    sourceLogs: [
      'fix(daily-analysis): getLastWeekRange返回正确的上周一至周日日期范围',
      'fix: 转义report-upload页面的未处理引号',
      'fix: 修复发货计划成本计算权限校验 & 优化定价表格输入框样式',
      'fix(daily-analysis): remove table rounded corners and shared border in 销售数据工作区 card',
      '优化日报分析功能及报告上传页面',
      'feat: 优化报告上传后端服务',
      'feat: 优化报告上传前端页面',
      'feat(product-analysis): 增强产品分析数据源服务及接口',
      'feat(daily-analysis): 优化日报分析页面交互及数据展示',
      'feat(weekly-analysis): 优化周产品分析页面布局及样式',
      'feat(report-upload): 优化报告上传组件样式',
      'feat(report-upload): 增强报告上传项目匹配验证及前端状态展示',
      'fix(report-upload): show historical inventory reports on target date and improve cache fallback',
      'feat(report): 增强月报服务及财务数据分析功能',
      'feat(report): 增强月报服务及前端展示功能',
      'feat(analysis): 增强日分析服务功能',
      'feat(analysis): enhance daily analysis page',
      'fix(frontend): 修复日期计算时区问题，确保按目标市场时区计算',
      'feat(report-upload): 增加报表国家/站点防呆校验',
      'fix(report-upload): 销售和库存报表站点不匹配时直接拒绝上传',
      'fix(daily-analysis): 近7天日期范围改为包含今天',
    ],
  },
  {
    version: 'V7',
    codename: 'AI 洞悉',
    status: 'current',
    startDate: '2026-04-11',
    endDate: '',
    summary: 'V7 版本正式开启 AI 驱动的智能洞察阶段，通过深度整合 AI 能力，让数据转化为可执行的运营洞见。',
    focus: ['AI 洞悉', '智能分析', '数据洞察', '文档完善'],
    highlights: [
      {
        area: 'AI',
        title: 'V7 正式启航',
        detail: 'V7 版本以 AI 洞悉为核心，聚焦将数据转化为可执行的运营洞见，让 AI 能力从辅助工具升级为决策引擎。',
      },
      {
        area: 'Docs',
        title: '更新项目文档与规范',
        detail: '同步 CLAUDE.md 项目文档内容，完善开发规范与项目结构说明，提升代码协作效率。',
      },
      {
        area: 'AI',
        title: '增强 AI 洞察聚合服务',
        detail: '优化 AI 洞察后端聚合服务逻辑，扩展前端页面功能展示，提升数据洞察能力。',
      },
      {
        area: 'Frontend',
        title: '优化自动上传与代理路由',
        detail: '修复自动上传页面布局与滚动体验，支持流式响应透传，完善 V7 变更日志页面。',
      },
    ],
    sourceLogs: [
      'docs: 更新 CLAUDE.md 项目文档',
      'feat(ai-insights): 增强 AI 洞察聚合服务与前端页面功能',
      'fix(auto-upload): 优化自动上传页面布局与文件列表滚动',
      'feat(proxy): 支持流式响应透传并更新 V7 变更日志',
    ],
  },
]

export function getChangelogSnapshot(): ChangelogSnapshot {
  const currentRelease = RELEASES.find((release) => release.status === 'current') ?? RELEASES[RELEASES.length - 1]
  const highlightCount = RELEASES.reduce((count, release) => count + release.highlights.length, 0)
  const logCount = RELEASES.reduce((count, release) => count + release.sourceLogs.length, 0)
  const moduleCount = new Set(RELEASES.flatMap((release) => release.focus)).size

  return {
    releases: RELEASES,
    currentRelease,
    stats: {
      versionCount: RELEASES.length,
      highlightCount,
      logCount,
      moduleCount,
    },
    source: {
      mode: 'processed-history-logs',
      label: '',
      updatedAt: currentRelease.endDate || currentRelease.startDate || new Date().toISOString().split('T')[0],
    },
  }
}
