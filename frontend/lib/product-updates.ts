export type ProductUpdateTone = 'workflow' | 'performance' | 'insight'

export type ProductUpdateSection = {
  title: string
  body: string
  bullets?: string[]
}

export type ProductUpdatePreview = {
  eyebrow: string
  title: string
  caption: string
  chips: string[]
}

export type ProductUpdate = {
  id: string
  publishedAt: string
  label: string
  title: string
  summary: string
  narrative: string
  tone: ProductUpdateTone
  scope: 'global' | 'module' | 'page'
  routeMatchers: string[]
  priority: number
  audienceValue: string[]
  sections: ProductUpdateSection[]
  previews: ProductUpdatePreview[]
  featured: boolean
}

export type ProductUpdatesSnapshot = {
  updates: ProductUpdate[]
  latestUpdate: ProductUpdate
  featuredUpdate: ProductUpdate
  stats: {
    total: number
    featuredCount: number
  }
}

export type ProductUpdatesContext = {
  matchedUpdates: ProductUpdate[]
  primaryUpdate: ProductUpdate
  fallbackToGlobal: boolean
}

export const PRODUCT_UPDATES_STORAGE_KEY = 'believeboy-dashboard:product-updates:seen'
export const PRODUCT_UPDATES_SEEN_EVENT = 'believeboy-dashboard:product-updates:seen-change'
export const PRODUCT_UPDATES_OPEN_EVENT = 'believeboy-dashboard:product-updates:open'

const ROUTES = {
  dashboard: ['/dashboard'],
  aiChat: ['/dashboard/ai-panel/chat'],
  changePassword: ['/dashboard/change-password'],
  changelog: ['/dashboard/changelog'],
  adAnalysis: [
    '/dashboard/data-analysis/ad-analysis',
    '/dashboard/data-analysis/ad-analysis/overview',
    '/dashboard/data-analysis/ad-analysis/campaigns',
    '/dashboard/data-analysis/ad-analysis/products',
    '/dashboard/data-analysis/ad-analysis/search-terms',
    '/dashboard/data-analysis/ad-analysis/placements',
    '/dashboard/data-analysis/ad-analysis/budget',
    '/dashboard/data-analysis/ad-analysis/targets',
    '/dashboard/data-analysis/ad-analysis/traffic-quality',
    '/dashboard/data-analysis/ad-analysis/time-trend',
    '/dashboard/data-analysis/ad-analysis/purchased-products',
  ],
  dailyAnalysis: ['/dashboard/data-analysis/daily-analysis'],
  financialData: ['/dashboard/data-analysis/financial-data'],
  inventoryAnalysis: ['/dashboard/data-analysis/inventory-analysis'],
  inventoryReplenishment: ['/dashboard/data-analysis/inventory-replenishment'],
  weeklyProductAnalysis: ['/dashboard/data-analysis/weekly-product-analysis'],
  adUpload: ['/dashboard/data-management/ad-upload'],
  exchangeRate: ['/dashboard/data-management/exchange-rate'],
  reportUpload: ['/dashboard/data-management/report-upload'],
  shipmentManagement: ['/dashboard/data-management/shipment-management'],
  skuCost: ['/dashboard/data-management/sku-cost'],
  dailyReport: ['/dashboard/data-reporting/daily-report'],
  monthlyReport: ['/dashboard/data-reporting/monthly-report'],
  pricingCalculation: ['/dashboard/data-reporting/pricing-calculation'],
  productAnalysis: ['/dashboard/data-reporting/product-analysis'],
  siteNavigation: ['/dashboard/operations/site-navigation'],
  storeNavigation: ['/dashboard/operations/store-navigation'],
  accountManagement: ['/dashboard/system-management/account-management'],
  commissionManagement: ['/dashboard/system-management/commission-management'],
  commissionOverview: ['/dashboard/system-management/commission-overview'],
  systemDataManagement: ['/dashboard/system-management/data-management'],
  logs: ['/dashboard/system-management/logs'],
  operatorManagement: ['/dashboard/system-management/operator-management'],
  projectInfo: ['/dashboard/system-management/project-info'],
  researchAnalysis: ['/dashboard/tools/research-analysis'],
}

function createUpdate(update: ProductUpdate): ProductUpdate {
  return update
}

export const PRODUCT_UPDATES: ProductUpdate[] = [
  createUpdate({
    id: '2026-03-29-pricing-workbench-refresh',
    publishedAt: '2026-03-29',
    label: '定价核算',
    title: '定价测算现在更像一张可操作的工作台',
    summary: '筛选、更大对比容量和更长列表一起到位，查找方案和横向会审都比之前顺了很多。',
    narrative:
      '这一轮更新直接落在定价核算页最常用的两段动作上：先快速收敛记录，再把多种方案摊开对比。页面不再只是跑一次测算结果，而是更接近一个可以连续回看、连续筛选、连续比较的工作台。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.pricingCalculation,
    priority: 100,
    audienceValue: [
      '新增下拉多选筛选器，支持按产品名、测算类型、日期、创建人组合筛选。',
      '定价测算对比数量从 4 组提升到 8 组，更适合方案会审。',
      '默认加载数量从 24 条提升到 100 条，历史结果浏览更连贯。',
    ],
    sections: [
      {
        title: '把检索动作拆得更细',
        body: '筛选不再是单条件点查，而是可以围绕产品、类型、日期和创建人逐步缩小范围，更适合团队协作和历史回看。',
      },
      {
        title: '把方案并排比较做成常规动作',
        body: '8 组同屏对比让价格带、佣金结构和输入版本可以一次拉平，不用反复切换页面。',
      },
    ],
    previews: [
      {
        eyebrow: '筛选体验',
        title: '多选器让定位结果更快',
        caption: '更适合在大量历史测算里快速找到本轮要讨论的记录。',
        chips: ['产品名', '测算类型', '日期', '创建人'],
      },
      {
        eyebrow: '对比体验',
        title: '同屏比较从 4 组扩到 8 组',
        caption: '适合会审、复盘和多方案决策。',
        chips: ['4 → 8', '同屏会审', '减少切换'],
      },
    ],
    featured: true,
  }),
  createUpdate({
    id: '2026-03-27-ad-analysis-enhanced',
    publishedAt: '2026-03-27',
    label: '广告分析',
    title: '广告分析从主入口继续补齐到多视角联动',
    summary: '广告上传和分析链路继续扩展，预算、活动、商品、搜索词等页面的使用节奏更完整。',
    narrative:
      '广告分析不是只上一个首页就结束，这次更新把更多分析页真正接进工作链路，让你在不同视角之间来回切换时更像在用一套完整工具，而不是很多独立报表。',
    tone: 'insight',
    scope: 'module',
    routeMatchers: [...ROUTES.adAnalysis, ...ROUTES.adUpload],
    priority: 96,
    audienceValue: [
      '预算、广告活动、商品、搜索词、广告位等页面都继续补强。',
      '广告上传与后续分析之间的联系更紧，切换成本更低。',
      '适合把广告数据从单页查看升级成连续分析。',
    ],
    sections: [
      {
        title: '分析页不再只有概览',
        body: '预算、商品、广告活动、搜索词、广告位、时间趋势和无效流量等视角都被纳入同一条分析链路里。',
      },
      {
        title: '上传和分析开始接到一起',
        body: '当广告上传入口和分析入口同时完善后，广告数据更容易从“文件结果”走向“持续分析”。',
      },
    ],
    previews: [
      {
        eyebrow: '链路更新',
        title: '上传页和分析页更像前后衔接的一套流程',
        caption: '减少“传完文件之后再另找入口”的割裂感。',
        chips: ['广告上传', '分析联动', '多页面'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-26-operator-management-launch',
    publishedAt: '2026-03-26',
    label: '系统管理',
    title: '系统管理补上运营管理、审计和项目 operator 这条线',
    summary: '项目信息、运营管理、日志和佣金概览相关页面都开始围绕 operator 字段和审计能力展开。',
    narrative:
      '这批更新让系统管理不只是配置入口，而是更贴近日常协作关系。谁负责、谁操作过、哪些动作需要回看，这些信息开始被更清楚地放进管理页面里。',
    tone: 'workflow',
    scope: 'module',
    routeMatchers: [
      ...ROUTES.projectInfo,
      ...ROUTES.operatorManagement,
      ...ROUTES.logs,
      ...ROUTES.commissionOverview,
      ...ROUTES.researchAnalysis,
    ],
    priority: 94,
    audienceValue: [
      '新增运营管理页面，方便管理 operator 相关信息。',
      '项目 operator 字段扩展后，协作归属更容易看清。',
      '审计日志增强后，回溯动作链路更方便。',
    ],
    sections: [
      {
        title: '系统管理开始承接真实协作关系',
        body: '这轮不是纯页面扩容，而是把项目、人员和审计动作放到更统一的管理视角里。',
      },
    ],
    previews: [
      {
        eyebrow: '管理视角',
        title: '从配置页走向协作页',
        caption: '更适合团队规模变大后的管理和回看。',
        chips: ['operator', '审计日志', '项目归属'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-26-changelog-redesign',
    publishedAt: '2026-03-26',
    label: '更新日志',
    title: '更新日志页被重构成更适合回看的版本地图',
    summary: '更新日志和系统架构文档被重新整理，查看系统阶段变化时更清楚。',
    narrative:
      '原来的日志更像散落记录，现在这页被重新组织成版本化入口，更适合回顾系统演进、给新成员快速补背景，或者和产品更新中心做区分。',
    tone: 'insight',
    scope: 'page',
    routeMatchers: ROUTES.changelog,
    priority: 92,
    audienceValue: [
      '版本信息按阶段重新整理，更容易浏览。',
      '系统架构文档同步完善，适合补背景。',
    ],
    sections: [
      {
        title: '把散的 log 收成可读结构',
        body: '用户看到的是按版本阶段整理后的信息，而不是只能从提交记录里自己拼上下文。',
      },
    ],
    previews: [
      {
        eyebrow: '版本地图',
        title: '大版本和阶段信息更清晰',
        caption: '适合做历史回顾和新成员上手。',
        chips: ['阶段化', '结构化', '可回看'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-25-dashboard-polish',
    publishedAt: '2026-03-25',
    label: '通用体验',
    title: '一批高频页面做了统一的界面与交互抛光',
    summary: '仪表盘布局、间距、信息层级和交互细节被整体拉齐，很多页面现在看起来更稳、更好扫读。',
    narrative:
      '这次更新不是新增一个独立功能，而是把很多高频页面的外观、节奏和操作反馈统一打磨了一遍。对用户来说，最直接的感受就是页面更干净、切换更顺、重点更明显。',
    tone: 'performance',
    scope: 'global',
    routeMatchers: [
      ...ROUTES.dashboard,
      ...ROUTES.aiChat,
      ...ROUTES.changePassword,
      ...ROUTES.dailyAnalysis,
      ...ROUTES.inventoryAnalysis,
      ...ROUTES.inventoryReplenishment,
      ...ROUTES.weeklyProductAnalysis,
      ...ROUTES.exchangeRate,
      ...ROUTES.reportUpload,
      ...ROUTES.shipmentManagement,
      ...ROUTES.skuCost,
      ...ROUTES.dailyReport,
      ...ROUTES.monthlyReport,
      ...ROUTES.productAnalysis,
      ...ROUTES.siteNavigation,
      ...ROUTES.storeNavigation,
      ...ROUTES.accountManagement,
      ...ROUTES.commissionOverview,
      ...ROUTES.systemDataManagement,
    ],
    priority: 40,
    audienceValue: [
      '页面层级更清晰，扫读速度更快。',
      '布局和留白更统一，减少视觉噪音。',
      '多页面切换时的使用节奏更稳定。',
    ],
    sections: [
      {
        title: '不是加功能，是让功能更好用',
        body: '对高频工作台来说，统一的节奏和层级会直接影响连续工作的疲劳感，这轮更新重点就在这里。',
      },
    ],
    previews: [
      {
        eyebrow: 'UI 抛光',
        title: '更多页面进入同一套视觉语言',
        caption: '适合长时间使用时维持稳定节奏。',
        chips: ['布局', '间距', '层级'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-25-report-upload-polish',
    publishedAt: '2026-03-25',
    label: '报表上传',
    title: '报表上传页在导航和页面节奏上更顺手了',
    summary: '上传页配合侧边栏和页面细节抛光后，更适合作为日常固定入口。',
    narrative:
      '这类页面本来就容易因为信息块太多而显得拥挤，这次更多是在入口节奏、留白和结构感上做优化，让上传动作本身更专注。',
    tone: 'performance',
    scope: 'page',
    routeMatchers: ROUTES.reportUpload,
    priority: 70,
    audienceValue: [
      '上传相关信息更容易扫读。',
      '作为日常入口时，结构比之前更稳。',
    ],
    sections: [
      {
        title: '让上传动作更聚焦',
        body: '页面内容的组织更强调主流程，减少无关干扰。',
      },
    ],
    previews: [
      {
        eyebrow: '上传流程',
        title: '主流程更聚焦',
        caption: '减少一进页面就被多块信息打散注意力。',
        chips: ['主流程', '聚焦', '上传入口'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-25-project-info-fix',
    publishedAt: '2026-03-25',
    label: '项目信息',
    title: '项目创建时的主键冲突和错误提示被修掉了',
    summary: '项目管理页的创建稳定性更高，前端错误解析也更明确。',
    narrative:
      '这类修复虽然不显眼，但对管理页面来说很关键。之前如果创建动作本身不稳，会直接打断整条管理流程，现在这部分已经补强。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.projectInfo,
    priority: 88,
    audienceValue: [
      '项目创建冲突问题被修复后，操作更稳定。',
      '错误提示更清楚，排查成本更低。',
    ],
    sections: [
      {
        title: '把失败场景补完整',
        body: '比起只在成功路径上好看，管理页面更需要在异常场景下也能给出稳定反馈。',
      },
    ],
    previews: [
      {
        eyebrow: '稳定性',
        title: '创建动作更可靠',
        caption: '减少创建时被异常打断的情况。',
        chips: ['创建稳定', '错误解析', '项目管理'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-25-research-tabs-align',
    publishedAt: '2026-03-25',
    label: '调研分析',
    title: '调研分析页的 Tab 节奏被重新对齐',
    summary: '切换不同调研视角时更顺，不容易出现阅读节奏被打断的感觉。',
    narrative:
      '调研类页面往往信息密度高，Tab 一旦不顺手，用户很容易在来回切换时丢上下文。这次修复更偏体验，但对长期使用影响很直接。',
    tone: 'performance',
    scope: 'page',
    routeMatchers: ROUTES.researchAnalysis,
    priority: 84,
    audienceValue: [
      '标签切换更顺，阅读节奏更连贯。',
      '高密度信息下更容易维持上下文。',
    ],
    sections: [
      {
        title: '把长内容页面的切换做顺',
        body: '高密度调研内容更依赖稳定的页内导航节奏，这次正是围绕这个问题修整。',
      },
    ],
    previews: [
      {
        eyebrow: '页内导航',
        title: 'Tab 节奏更稳',
        caption: '减少来回切换时的跳脱感。',
        chips: ['Tabs', '长内容', '阅读节奏'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-24-sku-product-name',
    publishedAt: '2026-03-24',
    label: 'SKU 信息',
    title: 'SKU 信息页补上品名字段，并把 ASIN/FNSKU 展示做了合并',
    summary: 'SKU 成本管理页更接近日常识别习惯，不用只靠编码判断记录。',
    narrative:
      '对成本和商品信息页面来说，看得懂比字段更多更重要。这次把品名补进来，再把 ASIN 和 FNSKU 的展示整理到一起，查记录时会轻松很多。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.skuCost,
    priority: 86,
    audienceValue: [
      '新增品名字段，定位商品更直观。',
      'ASIN/FNSKU 合并显示后，信息关系更清楚。',
    ],
    sections: [
      {
        title: '让识别商品不再只靠代码',
        body: '品名加入后，特别适合高频查成本、查 SKU 的场景，减少来回核对编码。',
      },
    ],
    previews: [
      {
        eyebrow: '信息识别',
        title: '商品可读性更强',
        caption: '适合大量 SKU 并行管理时快速定位。',
        chips: ['品名字段', 'ASIN', 'FNSKU'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-23-ad-analysis-launch',
    publishedAt: '2026-03-23',
    label: '广告分析',
    title: '广告分析正式加入主工作台',
    summary: '广告相关页面从独立结果页变成完整模块，预算、商品、搜索词、广告位和趋势都开始有统一入口。',
    narrative:
      '这一轮是广告分析真正“入驻”系统的节点。对用户来说，最核心的变化不是多一个菜单，而是广告数据终于能在一套连续入口里被查看、筛选和对比。',
    tone: 'insight',
    scope: 'module',
    routeMatchers: ROUTES.adAnalysis,
    priority: 90,
    audienceValue: [
      '广告分析拥有独立导航和模块级结构。',
      '概览、预算、商品、搜索词、广告位等视角开始形成体系。',
    ],
    sections: [
      {
        title: '从零散数据到模块化分析',
        body: '广告数据不再只是上传后的输出，而是成为可以被连续访问的分析区域。',
      },
    ],
    previews: [
      {
        eyebrow: '模块上线',
        title: '广告分析从无到有进入主导航',
        caption: '适合日常固定查看，而不是临时查一下。',
        chips: ['模块化', '广告分析', '主导航'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-23-dashboard-layout-tidy',
    publishedAt: '2026-03-23',
    label: '仪表盘',
    title: '首页和库存相关页面把布局、间距和描述做了一轮收束',
    summary: '首页、库存分析和补货分析页都变得更利落，视觉干扰比之前少。',
    narrative:
      '这批页面本来承担的是高频扫读任务，所以更新重点不在加信息，而在于把已有信息组织得更稳。你会感觉到页面更轻、更聚焦。',
    tone: 'performance',
    scope: 'module',
    routeMatchers: [...ROUTES.dashboard, ...ROUTES.inventoryAnalysis, ...ROUTES.inventoryReplenishment],
    priority: 76,
    audienceValue: [
      '页面留白和信息层级更舒服。',
      '冗余描述减少后，关键数据更容易扫到。',
    ],
    sections: [
      {
        title: '高频页面优先做减法',
        body: '当用户每天都看同一页时，减少噪音通常比增加内容更重要。',
      },
    ],
    previews: [
      {
        eyebrow: '页面节奏',
        title: '高频看板更利落',
        caption: '更适合连续扫读和多次回访。',
        chips: ['间距', '减法', '高频看板'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-19-reporting-pipeline-refresh',
    publishedAt: '2026-03-19',
    label: '报表工作流',
    title: '日报、月报、产品分析和周分析开始跟新的报表流程同步',
    summary: '报表上传与日报分析流程重构后，多个报表页面都开始建立在更清晰的数据链路上。',
    narrative:
      '这次变化对用户来说可能不一定一眼可见，但它决定了报表页面后续能不能持续稳定演进。日报、月报、产品分析和周度分析都因此受益。',
    tone: 'workflow',
    scope: 'module',
    routeMatchers: [
      ...ROUTES.dailyReport,
      ...ROUTES.monthlyReport,
      ...ROUTES.productAnalysis,
      ...ROUTES.weeklyProductAnalysis,
      ...ROUTES.reportUpload,
    ],
    priority: 82,
    audienceValue: [
      '报表上传和分析页面之间的数据链路更清晰。',
      '日报、月报、产品分析和周分析后续扩展基础更稳。',
    ],
    sections: [
      {
        title: '这是一轮底层工作流重整',
        body: '当上传、状态跟踪和分析关系被重新整理后，用户看到的各类报表页会更一致、更可靠。',
      },
    ],
    previews: [
      {
        eyebrow: '数据链路',
        title: '上传到分析的关系更清楚',
        caption: '后续页面体验升级也更容易建立在同一底座上。',
        chips: ['上传', '分析', '工作流'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-19-exchange-rate-refresh',
    publishedAt: '2026-03-19',
    label: '汇率信息',
    title: '汇率信息页被纳入本轮数据管理补齐范围',
    summary: '数据管理页补齐后，汇率页面的使用体验和整体结构也更一致。',
    narrative:
      '汇率页虽然不是高曝光页面，但它会影响很多核算结果，所以保持它和其他数据管理页同一节奏很重要。这次主要是把它纳入统一的管理体验里。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.exchangeRate,
    priority: 78,
    audienceValue: [
      '数据管理结构更完整。',
      '汇率相关操作入口更稳定。',
    ],
    sections: [
      {
        title: '把低频但关键的页面纳入统一节奏',
        body: '越是基础配置页，越需要稳定、清晰而不是花哨。',
      },
    ],
    previews: [
      {
        eyebrow: '数据管理',
        title: '基础配置页更稳定',
        caption: '给后续财务和定价流程提供更稳的基础。',
        chips: ['汇率', '配置页', '管理'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-17-financial-data-update',
    publishedAt: '2026-03-17',
    label: '月度财务分析',
    title: '月度财务分析开始跟货运和产品成本变化同步',
    summary: '货运和产品成本能力更新后，财务分析页的阅读和判断基础也一起提升。',
    narrative:
      '财务分析页面的价值依赖于底层成本口径是否稳定。这轮更新的重点就在于，让货运和产品成本变化更及时地反映到财务分析视角里。',
    tone: 'insight',
    scope: 'page',
    routeMatchers: ROUTES.financialData,
    priority: 84,
    audienceValue: [
      '货运与产品成本相关变化开始影响财务分析判断。',
      '财务分析页和数据管理页的联动更紧。',
    ],
    sections: [
      {
        title: '把成本变化真正带进财务视角',
        body: '财务页不只是展示结果，也开始更好承接成本和物流变化。',
      },
    ],
    previews: [
      {
        eyebrow: '成本联动',
        title: '财务分析更贴近真实成本变化',
        caption: '更适合用来做经营判断，而不是只看静态结果。',
        chips: ['成本', '货运', '财务分析'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-10-store-navigation-refresh',
    publishedAt: '2026-03-10',
    label: '店铺导航',
    title: '店铺导航页进入本轮 dashboard 整体更新范围',
    summary: '店铺导航作为运营入口被继续并入统一的控制台节奏里。',
    narrative:
      '导航类页面的价值在于稳定和直达，这次更新更多是让它和整个控制台的布局、入口语义保持一致，便于日常反复使用。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.storeNavigation,
    priority: 72,
    audienceValue: [
      '店铺入口在控制台中的位置更稳。',
      '和其他导航类页面的体验更一致。',
    ],
    sections: [
      {
        title: '把常用跳转页收进统一体验里',
        body: '导航页虽然轻，但一旦不统一，频繁跳转时会很割裂。',
      },
    ],
    previews: [
      {
        eyebrow: '运营导航',
        title: '店铺入口更稳定',
        caption: '适合高频跳转场景下保持顺手。',
        chips: ['店铺导航', '入口', '一致性'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-10-financial-and-system-data-pages',
    publishedAt: '2026-03-10',
    label: '系统管理',
    title: '数据库状态页和相关管理页开始跟新版 dashboard 同步',
    summary: '系统管理里的数据管理页被纳入统一升级节奏，和财务相关页面的结构更一致。',
    narrative:
      '系统管理页一旦和主工作台风格脱节，就会显得像两套系统。这轮更新的作用，就是让数据库状态这类页面也回到统一控制台里。',
    tone: 'performance',
    scope: 'page',
    routeMatchers: ROUTES.systemDataManagement,
    priority: 74,
    audienceValue: [
      '数据库状态页更贴近新版控制台结构。',
      '系统管理和主工作台的使用割裂感降低。',
    ],
    sections: [
      {
        title: '把后台页拉回主工作台语言',
        body: '统一的布局和结构能让系统管理页在紧急查看时也更高效。',
      },
    ],
    previews: [
      {
        eyebrow: '后台页面',
        title: '系统管理页更统一',
        caption: '适合从业务页快速切到后台页时保持认知连续。',
        chips: ['数据库状态', '系统管理', '统一体验'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-06-ai-chat-batch-update',
    publishedAt: '2026-03-06',
    label: 'AI 聊天',
    title: 'AI 聊天页在批量功能更新后进入主工作流',
    summary: 'AI 聊天页随着前后端功能批量更新一起补强，逐步从实验入口转向常规使用入口。',
    narrative:
      'AI 页最重要的不是看起来像 AI，而是能不能稳定地接进日常工作流。这次批量更新之后，它在系统里的位置更明确了。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.aiChat,
    priority: 80,
    audienceValue: [
      'AI 聊天页和其他业务页的连接更自然。',
      '作为日常辅助入口的角色更明确。',
    ],
    sections: [
      {
        title: '从辅助尝试变成固定入口',
        body: 'AI 页开始更明确地服务分析和运营，而不是独立悬着。',
      },
    ],
    previews: [
      {
        eyebrow: 'AI 工作流',
        title: '辅助入口更明确',
        caption: '更适合在分析和运营过程中直接进入。',
        chips: ['AI', '工作流', '辅助分析'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-03-account-management-refresh',
    publishedAt: '2026-03-03',
    label: '账号管理',
    title: '账号管理页跟系统管理重构一起进入新版结构',
    summary: '系统管理重构后，账号管理页和数据分析相关入口的关系更清楚。',
    narrative:
      '账号管理页属于很典型的后台页面，用户不一定天天打开，但打开时通常有明确任务。这轮更新重点是把它放进更清晰的系统管理结构里。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.accountManagement,
    priority: 82,
    audienceValue: [
      '账号管理归属更清晰。',
      '系统管理结构比之前更完整。',
    ],
    sections: [
      {
        title: '后台操作更需要结构清楚',
        body: '当用户是带着明确任务进来的，清晰的信息结构比复杂功能更重要。',
      },
    ],
    previews: [
      {
        eyebrow: '系统管理',
        title: '账号管理位置更清楚',
        caption: '更适合低频但目标明确的后台操作。',
        chips: ['账号管理', '后台结构', '清晰归属'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-02-commission-management-launch',
    publishedAt: '2026-03-02',
    label: '佣金管理',
    title: '佣金管理页作为独立能力进入系统管理',
    summary: '佣金管理开始具备独立页面和专属管理语义，不再只是散落配置。',
    narrative:
      '佣金管理这类页面如果只是参数堆积，用户会很难形成稳定操作路径。现在它被正式拉成独立入口，后续规则更新也更容易承接。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: [...ROUTES.commissionManagement, ...ROUTES.commissionOverview],
    priority: 83,
    audienceValue: [
      '佣金管理成为独立入口，结构更清晰。',
      '后续规则迭代和总览能力有了更明确的承接页。',
    ],
    sections: [
      {
        title: '从参数堆积变成管理入口',
        body: '当页面成为独立能力之后，用户才更容易记住“去哪做什么”。',
      },
    ],
    previews: [
      {
        eyebrow: '管理入口',
        title: '佣金页更像一套完整能力',
        caption: '适合后续继续加规则、总览和审计。',
        chips: ['佣金管理', '独立入口', '规则承接'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-03-02-password-and-exchange-support',
    publishedAt: '2026-03-02',
    label: '账户安全',
    title: '修改密码页作为账号安全动作被正式补上',
    summary: '账户安全链路更完整，用户可以在控制台里直接完成密码管理相关动作。',
    narrative:
      '这类能力平时很安静，但一旦需要用，必须是直接可达且稳定的。修改密码页的补齐，让账号安全不再需要依赖外部处理。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.changePassword,
    priority: 81,
    audienceValue: [
      '控制台内可直接处理密码修改。',
      '账号安全链路更完整。',
    ],
    sections: [
      {
        title: '低频动作也要一键可达',
        body: '真正成熟的后台，不应该把安全动作放到用户找不到的地方。',
      },
    ],
    previews: [
      {
        eyebrow: '账号安全',
        title: '密码管理被收进主控制台',
        caption: '需要时可以直接操作，而不是另找入口。',
        chips: ['修改密码', '安全', '账号'],
      },
    ],
    featured: false,
  }),
  createUpdate({
    id: '2026-02-25-site-navigation-launch',
    publishedAt: '2026-02-25',
    label: '站点导航',
    title: '站点导航页作为运营入口被纳入控制台',
    summary: '站点导航页和系统管理能力一起进入平台，方便把高频站点访问集中起来。',
    narrative:
      '运营导航页的意义不是复杂，而是省去重复找入口的成本。站点导航作为早期基础页之一，被纳入控制台后更适合长期固定使用。',
    tone: 'workflow',
    scope: 'page',
    routeMatchers: ROUTES.siteNavigation,
    priority: 71,
    audienceValue: [
      '高频站点入口被统一收纳。',
      '和其他控制台入口的关系更清楚。',
    ],
    sections: [
      {
        title: '把外部站点访问收成内部习惯',
        body: '导航页的价值在于减少记忆负担，让高频跳转变成肌肉记忆。',
      },
    ],
    previews: [
      {
        eyebrow: '运营入口',
        title: '站点访问更集中',
        caption: '适合日常重复跳转场景。',
        chips: ['站点导航', '运营入口', '集中访问'],
      },
    ],
    featured: false,
  }),
]

function sortUpdates(a: ProductUpdate, b: ProductUpdate) {
  if (b.priority !== a.priority) return b.priority - a.priority
  return b.publishedAt.localeCompare(a.publishedAt)
}

export function getProductUpdatesSnapshot(): ProductUpdatesSnapshot {
  const updates = [...PRODUCT_UPDATES].sort(sortUpdates)
  const latestUpdate = [...PRODUCT_UPDATES].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
  const featuredUpdate = updates.find((item) => item.featured) ?? latestUpdate

  return {
    updates,
    latestUpdate,
    featuredUpdate,
    stats: {
      total: updates.length,
      featuredCount: updates.filter((item) => item.featured).length,
    },
  }
}

function matchesRoute(pathname: string, matcher: string) {
  return pathname === matcher || pathname.startsWith(`${matcher}/`) || pathname.startsWith(`${matcher}?`) || pathname.startsWith(`${matcher}#`)
}

export function getProductUpdatesContext(pathname: string): ProductUpdatesContext {
  const snapshot = getProductUpdatesSnapshot()
  const matchedUpdates = snapshot.updates
    .filter((update) => update.routeMatchers.some((matcher) => matchesRoute(pathname, matcher)))
    .sort(sortUpdates)

  if (matchedUpdates.length > 0) {
    return {
      matchedUpdates,
      primaryUpdate: matchedUpdates[0],
      fallbackToGlobal: false,
    }
  }

  return {
    matchedUpdates: [],
    primaryUpdate: snapshot.featuredUpdate,
    fallbackToGlobal: true,
  }
}

export function readSeenProductUpdateIds(): string[] {
  if (typeof window === 'undefined') return []

  try {
    const raw = window.localStorage.getItem(PRODUCT_UPDATES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function writeSeenProductUpdateIds(ids: string[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PRODUCT_UPDATES_STORAGE_KEY, JSON.stringify(ids))
  window.dispatchEvent(new Event(PRODUCT_UPDATES_SEEN_EVENT))
}

export function markAllProductUpdatesSeen() {
  writeSeenProductUpdateIds(PRODUCT_UPDATES.map((item) => item.id))
}

export function openProductUpdatesSpotlight() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(PRODUCT_UPDATES_OPEN_EVENT))
}
