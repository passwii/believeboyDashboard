export type AdAnalysisTabConfig = {
  key: string
  label: string
  href: string
  summary: string
  goals: string[]
  sourceReports: string[]
  keyMetrics: string[]
  drillPath: string[]
  adjustmentRules: string[]
}

export const AD_ANALYSIS_TABS: AdAnalysisTabConfig[] = [
  {
    key: 'overview',
    label: '总览',
    href: '/dashboard/data-analysis/ad-analysis/overview',
    summary: '先看账户或项目在当前日期范围内的投放健康度，再决定往哪个维度继续下钻。',
    goals: [
      '判断整体花费、销售额、订单、点击、曝光是否处于合理区间。',
      '识别高花费低产出、高曝光低点击、预算受限和流量异常的主要问题。',
      '给后续的 SKU、搜索词、投放位置、活动分析提供统一入口。',
    ],
    sourceReports: ['广告活动报表', '推广商品报表', '预算报表', '广告位报表'],
    keyMetrics: ['Impressions', 'Clicks', 'CTR', 'CPC', 'Spend', 'Sales 7d', 'Orders 7d', 'ACOS', 'ROAS'],
    drillPath: ['总览 -> 活动', '总览 -> SKU', '总览 -> 搜索词', '总览 -> 广告位', '总览 -> 预算'],
    adjustmentRules: [
      'ACOS 超目标且点击量已达到观察门槛时，优先下钻活动和搜索词找浪费点。',
      'CTR 明显偏低时，优先下钻广告位和投放对象，检查曝光是否落在低意图流量。',
      '预算在线时间不足或存在明显预算错失时，优先进入预算页确认加预算优先级。',
    ],
  },
  {
    key: 'campaigns',
    label: '活动',
    href: '/dashboard/data-analysis/ad-analysis/campaigns',
    summary: '活动页负责做日常调控分级，是广告经理最常操作的一层。',
    goals: [
      '按活动看目标完成度和预算效率。',
      '区分放量活动、稳定活动、观察活动、压降活动。',
      '沉淀统一分级标准，减少主观判断。',
    ],
    sourceReports: ['广告活动报表', '预算报表'],
    keyMetrics: ['Spend', 'Sales 7d', 'Orders 7d', 'ACOS', 'ROAS', 'CTR', 'CPC', '预算在线时间'],
    drillPath: ['活动 -> 搜索词', '活动 -> 投放对象', '活动 -> 广告位', '活动 -> SKU'],
    adjustmentRules: [
      'A 级：订单稳定、ACOS 低于目标、预算受限明显，可加预算和放宽竞价。',
      'B 级：表现达标但增量一般，维持预算并观察词和广告位结构。',
      'C 级：高点击低转化或 ACOS 接近上限，优先做否词和降价。',
      'D 级：高花费无单或连续低效，收紧预算、暂停无效广告组或活动。',
    ],
  },
  {
    key: 'products',
    label: 'SKU',
    href: '/dashboard/data-analysis/ad-analysis/products',
    summary: 'SKU 页解决“哪些商品值得推、哪些 SKU 正在浪费预算”的问题。',
    goals: [
      '按广告 SKU / ASIN 评估投放产出。',
      '区分主推款、辅助款、清仓款、测试款不同打法。',
      '识别高曝光低点击、高点击低转化和高转化可放量商品。',
    ],
    sourceReports: ['推广商品报表', '已购买商品报表'],
    keyMetrics: ['Impressions', 'Clicks', 'CTR', 'Spend', 'Sales 7d', 'Orders 7d', 'CVR 7d', 'ACOS'],
    drillPath: ['SKU -> 活动', 'SKU -> 搜索词', 'SKU -> 投放对象', 'SKU -> 已购买商品'],
    adjustmentRules: [
      '高点击高转化且 ACOS 优于目标：提高预算优先级并争取更多有效曝光。',
      '高曝光低点击：先查主图、价格、标题，再看广告位和词的精准度。',
      '高点击低转化：优先检查落地页竞争力、词路是否跑偏、是否需要否词。',
    ],
  },
  {
    key: 'search-terms',
    label: '搜索词',
    href: '/dashboard/data-analysis/ad-analysis/search-terms',
    summary: '搜索词页是“扩量、否词、控 ACOS”的核心页面。',
    goals: [
      '识别优质转化词、浪费词、潜力词和高份额词。',
      '区分搜索词表现和投放对象表现，避免混淆优化动作。',
      '沉淀加词、否词、竞价调整规则。',
    ],
    sourceReports: ['搜索词报表', '搜索词展示量份额报表'],
    keyMetrics: ['Clicks', 'Spend', 'Sales 7d', 'Orders 7d', 'ACOS', 'CTR', 'CVR 7d', 'Impression Share'],
    drillPath: ['搜索词 -> 活动', '搜索词 -> 广告组', '搜索词 -> SKU'],
    adjustmentRules: [
      '高转化且份额低：提竞价或单独拉精确词承接流量。',
      '高点击无单且超过否词门槛：加入否词或降低竞价。',
      '有单但 ACOS 偏高：保留词，转为精确控制并收窄出价。',
    ],
  },
  {
    key: 'targets',
    label: '投放',
    href: '/dashboard/data-analysis/ad-analysis/targets',
    summary: '投放页主要分析自动投放、手动词、商品投放这些“入口本身”的效率。',
    goals: [
      '区分 close match、loose match、substitutes、complements 或商品投放的质量。',
      '判断流量入口是否偏移，避免搜索词页只看到结果看不到入口。',
      '为自动投放结构拆分提供依据。',
    ],
    sourceReports: ['投放报表'],
    keyMetrics: ['Impressions', 'Clicks', 'CTR', 'Spend', 'Sales 7d', 'Orders 7d', 'ACOS', 'Top of Search Share'],
    drillPath: ['投放 -> 搜索词', '投放 -> 活动', '投放 -> SKU'],
    adjustmentRules: [
      '自动投放高花费低转化的入口单独降价或拆组隔离。',
      '商品投放高点击低转化时，优先复核竞品选择和价格带。',
      '优质入口可以单独抽出来做精细化活动承接。',
    ],
  },
  {
    key: 'placements',
    label: '广告位',
    href: '/dashboard/data-analysis/ad-analysis/placements',
    summary: '广告位页用于判断首页顶部、其余搜索位、商品页等流量位置是否值得出更高价格。',
    goals: [
      '比较不同广告位的点击率、转化率和 ACOS。',
      '决定 placement 调整系数是否应上调或下调。',
      '识别“首页贵但值”和“首页贵且不值”的活动。',
    ],
    sourceReports: ['广告位报表'],
    keyMetrics: ['Impressions', 'Clicks', 'CTR', 'CPC', 'Spend', 'Sales 7d', 'Orders 7d', 'ACOS', 'CVR 7d'],
    drillPath: ['广告位 -> 活动', '广告位 -> SKU'],
    adjustmentRules: [
      '首页顶部 CVR 明显高于其他位置且 ACOS 可控时，可以提高 top-of-search 调整系数。',
      '商品页 ACOS 长期恶化时，应降低对应广告位加价。',
      '广告位差异不明显时，不要过度拉高调整系数，避免无效抬价。',
    ],
  },
  {
    key: 'budget',
    label: '预算',
    href: '/dashboard/data-analysis/ad-analysis/budget',
    summary: '预算页回答“哪些活动该加预算、哪些活动不该继续烧”的问题。',
    goals: [
      '识别预算受限活动和潜在错失销售额。',
      '给预算分配提供优先级，而不是平均分配。',
      '把预算动作和活动等级联动起来。',
    ],
    sourceReports: ['预算报表', '广告活动报表'],
    keyMetrics: ['当前预算', '建议预算', '预算在线时间', '预计错失展示', '预计错失点击', '预计错失销售'],
    drillPath: ['预算 -> 活动', '预算 -> SKU'],
    adjustmentRules: [
      '仅对高质量活动加预算，预算受限但 ACOS 失控的活动不应盲目放量。',
      '预算在线时间不足且销售效率好，可进入加预算候选。',
      '建议预算高但转化差的活动，优先优化词和流量质量，再考虑预算。',
    ],
  },
  {
    key: 'traffic-quality',
    label: '流量质量',
    href: '/dashboard/data-analysis/ad-analysis/traffic-quality',
    summary: '流量质量页用于排查无效点击和异常流量，防止把问题误判成转化问题。',
    goals: [
      '发现异常点击、异常曝光和低质流量活动。',
      '与关键词、投放对象、广告位联动排查浪费来源。',
      '建立异常预警和排查标准。',
    ],
    sourceReports: ['总流量和无效流量报表', '广告活动报表'],
    keyMetrics: ['总展示量', '无效展示量', '无效展示率', '总点击量', '无效点击量', '无效点击率'],
    drillPath: ['流量质量 -> 活动', '流量质量 -> 投放对象', '流量质量 -> 搜索词'],
    adjustmentRules: [
      '无效点击率异常升高时，先暂停疑似异常活动并排查入口结构。',
      '异常流量优先按活动和投放对象定位，不要直接对全部词统一降价。',
      '如果无效流量集中在特定广告位，应单独调整 placement 策略。',
    ],
  },
]
