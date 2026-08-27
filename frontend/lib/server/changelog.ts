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
    codename: '基座与执行闭环',
    status: 'archived',
    startDate: '2026-02-23',
    endDate: '2026-03-18',
    summary:
      '从单页工作台到多模块运营后台的奠基阶段：补齐控制台框架、项目与系统管理、经营核算与类目研究，并把发货、库存与定价核算打到可执行。',
    focus: ['控制台与导航', '项目与系统管理', '经营核算与研究', '发货与库存', '定价与导出', '权限与体验'],
    highlights: [
      {
        area: 'Platform',
        title: '搭建 Dashboard 基础骨架',
        detail: '完成 Next.js 仪表盘脚手架、侧边栏导航与 README/Dox 信息架构对齐，奠定后续模块统一容器。',
      },
      {
        area: 'Management',
        title: '项目与系统管理成型',
        detail: '新增项目管理、账号与系统配置入口，补齐管理后台的基础治理面。',
      },
      {
        area: 'Finance',
        title: '经营核算与类目研究补齐',
        detail: '上线汇率管理、佣金管理 V2 与类目研究完整链路（表结构→服务→页面→测试），月报与周度分析开始系统化。',
      },
      {
        area: 'Logistics',
        title: '发货与库存执行链路成熟',
        detail: '发货计划支持国家字段、批次编辑与 SKU 明细维护，库存补货与库存分析形成独立数据工作区。',
      },
      {
        area: 'Pricing',
        title: '定价核算进入深水区',
        detail: '支持 CSV 批量导入、运行类型与快照存档、佣金率与矩阵对比，并持续打磨 Excel 导出与骨架加载态。',
      },
      {
        area: 'Security',
        title: '权限与体验收口',
        detail: '收紧项目访问检查与运营查看权限，补齐密码管理、加载骨架与响应式优化。',
      },
    ],
    sourceLogs: [
      'feat: scaffold dashboard app and refresh README',
      'V1 文档: 同步 Dox 与 README 到侧边栏运营化改版',
      'feat(ui): 重构销售日报页面并同步设计规范',
      '添加项目管理和系统管理功能',
      'feat: 佣金管理V2 + 产品成本增强 + 系统管理功能完善',
      'feat: 添加类目研究功能，优化产品成本排序 API',
      'feat: 添加汇率管理、库存补货、发货计划等功能',
      'feat: 支持在编辑页面直接维护船期批次SKU明细',
    ],
  },
  {
    version: 'V2',
    codename: '数据链路与洞察成型',
    status: 'archived',
    startDate: '2026-03-19',
    endDate: '2026-05-20',
    summary:
      '重构报表上传与分析链路、回填历史数据后，广告分析与仪表盘工作台成型，并以 AI 洞察（重试/流式/PNG/时区感知）收口第一轮智能化。',
    focus: ['报表上传与回填', '广告与仪表盘', '导航与导出', 'AI 洞察', 'SKU 与物流', '系统与安全'],
    highlights: [
      {
        area: 'Pipeline',
        title: '重构报表上传与日报分析链路',
        detail: '梳理上传、状态跟踪与分析源关系，补库存与广告 ReportDate 回填、清理异常付款历史。',
      },
      {
        area: 'Ads',
        title: '广告分析工作台上线',
        detail: '新增广告分析主模块及分页面结构，投放数据首次成为独立分析域。',
      },
      {
        area: 'Dashboard',
        title: '仪表盘与导航节奏重排',
        detail: '优化信息密度、侧边栏快捷入口与视觉层次，统一深浅色与会话体验。',
      },
      {
        area: 'AI',
        title: 'AI 洞察智能化收口',
        detail: '补齐 AI Chat 基础能力后，上线洞察重试 /retry、SSE 流式预览、PNG 导出与国家级时区感知。',
      },
      {
        area: 'Export',
        title: '导出体验持续打磨',
        detail: '定价与发货 Excel 分组表头、颜色映射与汇总行细节可直接交付使用。',
      },
      {
        area: 'Fix',
        title: '关键数据与布局修复',
        detail: '修复 SKU 汇总多国混算、店铺核算整数格式与侧边栏重构，稳定性进入可发布态。',
      },
    ],
    sourceLogs: [
      '重构报表上传与日报分析流程',
      '补库存报告 ReportDate 云端回填迁移',
      '补广告报表 ReportDate 回填迁移',
      'feat(ai-insights): 增强洞察重试、流式预览与 PNG 导出',
      'fix(sku-info): 修复切换国家时 summaryBySku 混合多国数据问题',
      'refactor(sidebar): 重构侧边栏布局与间距结构',
      'feat(proxy): 支持流式响应透传并更新 V7 变更日志',
      '优化日报分析功能及报告上传页面',
    ],
  },
  {
    version: 'V3',
    codename: '平台加固与数据治理',
    status: 'archived',
    startDate: '2026-05-21',
    endDate: '2026-06-30',
    summary:
      '以存储与订阅治理为核心的加固期：封堵 R2 泄露面、固化定时报告订阅到台账的完整闭环，并以订单信息与仪表盘组件化收口运营数据口径。',
    focus: ['R2 与存储治理', '定时报告订阅与台账', '对账与营收', '订单信息与物流', '仪表盘组件化', '性能与会话'],
    highlights: [
      {
        area: 'Storage',
        title: 'R2 存储治理 P0/P1 封堵',
        detail: '完成 _build_r2_url 编码修复、截图上 R2、P0 止血与 P1 订阅/用户删除端点收口，封堵越权泄露面。',
      },
      {
        area: 'Scheduled',
        title: '定时报告订阅到台账闭环固化',
        detail: '落地 ledger 持久化、按国家拆分、重发服务、AI 摘要与分发时段控制，截图管线与邮件模板同步优化。',
      },
      {
        area: 'Reconciliation',
        title: '对账与营收链路增强',
        detail: '增强 report-reconciliation PDF 重传与状态校验，完善汇率与平台营收口径。',
      },
      {
        area: 'Orders',
        title: '订单信息与 FBM 物流补录',
        detail: '新增订单信息页（is_current 过滤、权限控制与 SKU/店铺关联跳转），补齐 FBM 物流补录与筛选。',
      },
      {
        area: 'Dashboard',
        title: '仪表盘组件化',
        detail: '集成 line-charts-6、MetricSwitcherCard 单线视图与 chartKind 自适应，KPI 与图表可高效切换。',
      },
      {
        area: 'Perf',
        title: '性能与会话治理',
        detail: '扩展 backend-cache 白名单与 loading Suspense 边界，session TTL 10s→60s 并加入故障熔断。',
      },
    ],
    sourceLogs: [
      'fix(r2): _build_r2_url_from_key 添加 URL 编码',
      'feat(scheduled-reports): generate persistent ledger entries',
      'feat(scheduled-reports): expose ledger APIs',
      'feat: upload scheduled report screenshots to R2 (daily)',
      'feat(report-reconciliation): 增强 PDF 重传与状态校验',
      'feat(notification-settings): 添加通知设置管理模块',
      'feat(BEL-157): 新增「数据管理 → 订单信息」页面',
      'feat(BEL-144): 集成 line-charts-6 并在 daily-analysis 落地单线 + 切换视图',
    ],
  },
  {
    version: 'V4',
    codename: '智能与运营治理',
    status: 'archived',
    startDate: '2026-07-01',
    endDate: '2026-08-10',
    summary:
      '运营智能化集中爆发：CRM 价值分档、库存盘点与三段式季节性补货、通知与告警中心、三层缓存与调度治理同步落地，并以路由重排与 GUI 工作区基座面向原生化。',
    focus: ['CRM 价值分档', '库存盘点与补货', '通知与告警', '缓存与调度', '路由与侧栏重构', '广告与外部 API', 'GUI 工作区'],
    highlights: [
      {
        area: 'CRM',
        title: 'CRM 价值分档体系落地',
        detail: '加 4 维 score 列、compute_rating 分档与 update_scores API，打通列表筛选、画像卡与审计收口。',
      },
      {
        area: 'Inventory',
        title: '库存盘点与三段式季节性补货',
        detail: '实现 inventory-ledger 全链路与 /trend 聚合，补货引入 seasonal_factor 与库存健康三段式判定。',
      },
      {
        area: 'Notify',
        title: '通知与告警中心',
        detail: '新增通知模型与铃铛轮询、告警中心三 Tab（规则/事件/偏好）与 15 分钟全量检测任务。',
      },
      {
        area: 'Cache',
        title: '缓存与调度系统性治理',
        detail: '落地 L0/L1/L2 三层失效装饰器与 12 项 Redis 优化，Celery 并发与截图管线完成降配与反 OOM 加固。',
      },
      {
        area: 'IA',
        title: '路由与侧栏信息架构重排',
        detail: '按 9 职能组重排 dashboard 路由与侧栏分组，移除角色墙并统一分类归属。',
      },
      {
        area: 'External',
        title: '广告与外部 API 收敛',
        detail: 'ad-search-terms 新增 targeting_type、autoReportUpload 切 HTTP-only ingest，C 表 ad_upload_files 成为唯一写入面。',
      },
      {
        area: 'GUI',
        title: 'GUI 原生工作区基座',
        detail: '搭 gpui workspace 三 crate、侧栏 8 组 52 项收编、登录 Keychain 与 Dashboard 状态机接通真实视图。',
      },
    ],
    sourceLogs: [
      'feat(crm): 加 4 维价值评分 score 列（P6a Task 1）',
      'feat(库存盘点): 实现 inventory-ledger 全链路',
      'feat(通知): 新增通知 CRUD 与未读数端点并挂路由',
      'feat(告警): 新增告警中心页面与 sidebar 入口',
      'feat(backend): 缓存治理基础设施——三层失效装饰器 + 白名单',
      'refactor(routes): 按 9 职能组重排 dashboard 路由目录并同步全部引用',
      'feat(external): AdSearchTerm schema 删除 target_text、新增 targeting_type',
      'feat(gui): believeboy-gui workspace 骨架（gui-domain/gui-api-client/gui-app + MVP 方案）',
    ],
  },
  {
    version: 'V5',
    codename: '面向智能体运营',
    status: 'current',
    startDate: '2026-08-11',
    endDate: '2026-08-27',
    summary:
      '以“面向智能体的运营”为核心的收官版本：运营范式从“人盯屏”转向“人与智能体协同”——在交易终端外壳与四类视图模板的基座上，完成 9 批终端化打磨与 Inspector/Ticker 情报化，并通过 Agent 凭据自助签发、Live Stream 实时出单流与使用指南闭环，让智能体可直接在 Dashboard 上完成查询、预警与执行。',
    focus: ['面向智能体运营', '终端外壳与密度', '视图模板 ABCD', 'Inspector 与 Ticker', 'Agent 凭据与审计', '实时与原生体验'],
    highlights: [
      {
        area: 'Agent',
        title: '面向智能体的运营',
        detail:
          '运营范式升级为人/智能体协同：新增 provisioner 自助签发与 item_key 身份列，补齐 usage-guide 四步确认与 /inventory 审计域及国家维度，结合 Live Stream 30s 轮询实时出单流与 Inspector 可配置数据源，让智能体可在终端内自主完成查询、监控与运营执行。',
      },
      {
        area: 'Shell',
        title: '高密度交易终端外壳定版',
        detail: '落地 50px 主轨 + 200px 子导航 + 36px 顶栏 + 24px 状态栏的三档密度、Inspector 自适应抽屉与跨平台字体栈。',
      },
      {
        area: 'Templates',
        title: '四类视图模板体系化',
        detail: '模板 A 超密度网格、B 双轴分析画布、C 分屏工作台、D 财务矩阵批量套版到销售/广告/财务等 20+ 模块。',
      },
      {
        area: 'Intelligence',
        title: 'Inspector 与 Footer Ticker 情报化',
        detail: 'Inspector 接可配置数据源与 Live Stream 轮询（30s、隐藏暂停、8s 静默降级），Footer 双拷贝 Ticker 常驻汇率与预警。',
      },
      {
        area: 'Polish',
        title: '终端化 9 批次集中打磨',
        detail: 'Stage 1 原子组件→Stage 9 库存预警频道，覆盖 Dashboard、Operations、财务、报表、CRM、系统/AI/工具全域抛光。',
      },
      {
        area: 'Experience',
        title: '原生体验与细节收尾',
        detail: '完成 CRM/运营/报表/AI/系统域移动端适配与 W4 FNSKU 指南、pending_order_qty 真值接线与细节抛光，收口高密度终端的原生体验。',
      },
    ],
    sourceLogs: [
      'feat(frontend): 高密度交易终端外壳——50px主轨+200px子导航+36px顶栏+24px状态栏与首页终端化',
      'feat(gui): 视图模板A工具栏+超密度数据网格——虚拟化大表+聚合分页条与销售/SKU两页套版',
      'style(前端): Stage 1 全局原子组件 Style 统一打磨（BLF-852）',
      'feat(gui): 右侧 Inspector 上下文抽屉——Cmd+B 自适应三态内容与 280~340 拖拽调宽',
      'feat(前端): 终端化 Stage 9 新增 Footer Ticker 库存预警频道（Closes BLF-840）',
      'feat(后端): Agent 凭据自助签发 provisioner 端点与 item_key 身份引用列',
      'feat(前端): Inspector Live Stream 改造为可配置数据源 + 接线真实出单流',
      'style(前端): Stage 3 Reports 报表模块终端化打磨（BLF-853）',
    ],
  },
]

export function getChangelogSnapshot(): ChangelogSnapshot {
  const currentRelease =
    RELEASES.find((release) => release.status === 'current') ?? RELEASES[RELEASES.length - 1]
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
      updatedAt:
        currentRelease.endDate ||
        currentRelease.startDate ||
        new Date().toISOString().split('T')[0],
    },
  }
}
