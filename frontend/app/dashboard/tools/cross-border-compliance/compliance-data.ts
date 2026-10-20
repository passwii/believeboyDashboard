/**
 * 跨境电商合规操作台 —— 静态内容单一来源（BLF-1391 / S1）。
 *
 * 内容全部来自用户提供的 16 张课件照片（`~/Downloads/跨境电商合规/`，见 PR 正文
 * 「素材来源」与「交付缺漏清单」）。
 * **硬红线**：只转录课件中可辨认的内容；无法准确辨认的条目一律省略并列入交付缺漏清单，
 * 不用外部搜索 / 推断 / 常识补写法规条件、税额、报关值或填报对错。
 *
 * 页面组件只 map 本文件导出的常量，不内联硬编码文案。
 */

/** 页面主标题。 */
export const PAGE_TITLE = '跨境电商合规'

/** 副标题：说明这是一份资料整理与自查参考。 */
export const PAGE_SUBTITLE = '出口业务资料整理与自查参考'

/** 来源标识（硬性验收项）。 */
export const SOURCE_NOTE = '根据用户提供的课件整理'

/** 限制性提示（硬性验收项）：以主管机关现行要求为准，不构成法律 / 税务 / 报关意见。 */
export const DISCLAIMER =
  '办理条件、材料清单与申报口径以属地主管海关、税务机关的现行要求为准；本页不构成法律、税务或报关意见。'

/** 模式对照区的场景参考标签（硬性验收项）。 */
export const MODE_SCENARIO_LABEL = '课件场景参考'

/** 模式区限定语：不做推荐、不做适用性判断、不给「哪个更优」的结论。 */
export const MODE_DISCLAIMER =
  '以下为课件场景参考，不构成推荐、适用性判断或优劣结论；实际申报模式需结合业务事实及主管机关口径确认。'

/** 模式场景表的口径说明：课件原文转录 ≠ 本平台推荐。 */
export const MODE_TABLE_NOTE =
  '表中「建议」列为课件原文转录，不代表本平台的推荐或适用性判断；是否采用、何时采用由企业结合自身业务事实并向主管机关确认。'

/** 首单材料区的口径说明。 */
export const MATERIAL_SCOPE_NOTE =
  '以下仅为课件所列材料，具体清单以属地主管部门要求为准；勾选进度不代表退税资格审核或申报通过率。'

/** 自查状态的说明：仅存在于当前页面会话。 */
export const LOCAL_ONLY_NOTE =
  '勾选状态只保存在当前页面会话，不上传、不写入后端，刷新后不承诺保留。'

/** 锚点 id 集合（页内导航 + 区块定位）。 */
export const ANCHORS = {
  chain: 'chain',
  modes: 'modes',
  admission: 'admission',
  materials: 'materials',
  fields: 'fields',
} as const

// ── 区块 2：出口业务证据链（课件「总结」页） ─────────────────────────────

export interface ChainStep {
  /** 锚点 id（页内导航可跳转）。 */
  id: string
  /** 环节名（采购 / 销售 / 报关 / 物流 / 收汇）。 */
  title: string
  /** 课件上的业务环节名。 */
  stage: string
  /** 课件上的合规维度名。 */
  compliance: string
  /** 该环节对应的单证 / 资料。 */
  documents: string[]
  /** 该环节对应的内容区锚点（流程带可跳转至对应内容区）。 */
  target: string
}

export const CHAIN_STEPS: ChainStep[] = [
  {
    id: 'chain-purchase',
    title: '采购',
    stage: '国内采购',
    compliance: '开票合规',
    documents: ['采购合同 / 订单', '进项发票', '采购付款银行记录'],
    target: ANCHORS.materials,
  },
  {
    id: 'chain-sales',
    title: '销售',
    stage: '平台销售',
    compliance: '销售合规',
    documents: ['出口销售合同 / 订单', '出口发票'],
    target: ANCHORS.materials,
  },
  {
    id: 'chain-customs',
    title: '报关',
    stage: '报关出口',
    compliance: '报关合规',
    documents: ['申报要素准确', '申报主体与业务单据相互对应'],
    target: ANCHORS.fields,
  },
  {
    id: 'chain-logistics',
    title: '物流',
    stage: '物流运输',
    compliance: '物流合规',
    documents: [
      '出口报关单',
      '运输单据及运费相关发票',
      '委托报关协议与代理报关服务发票',
    ],
    target: ANCHORS.materials,
  },
  {
    id: 'chain-settlement',
    title: '收汇',
    stage: '收汇付款',
    compliance: '资金合规',
    documents: ['完整银行收汇记录，并与销售及出口业务材料对照'],
    target: ANCHORS.materials,
  },
]

/** 课件「总结」页的标题句。 */
export const CHAIN_SUMMARY = '出口全链条阳光化是合规的基础'

/** 课件「总结」页的小标题。 */
export const CHAIN_SUBTITLE = '五个方面五个合规'

// ── 区块 3A：监管模式对照（课件「六大业务模式核心要素对比」表可见行） ──────

export interface RegulatoryMode {
  /** 监管代码。 */
  code: string
  /** 课件中的出口模式名。 */
  name: string
  /** 课件「核心特征」列。课件未展开的模式此处为空字符串。 */
  feature: string
  /** 课件「到底选0110还是9810?」表中的业务模式场景。课件未出现的模式此处为空字符串。 */
  scene: string
  /** 课件「是否可退税」列。 */
  refundable: string
  /** 课件「优势」列。 */
  strengths: string
  /** 课件「缺点」列。 */
  weaknesses: string
  /** 课件流程图可辨认的节点与流向。 */
  flow: string[]
  /** 课件「核心要求 / 核心要点 / 核心要点」原话。 */
  core: string
  /** 课件「适用主体」（仅 9810 页有此栏）。 */
  audience: string
}

export const REGULATORY_MODES: RegulatoryMode[] = [
  {
    code: '0110',
    name: '一般贸易出口',
    feature: '',
    scene: '多店铺（店群）+ 有专票 + 想退税',
    refundable: '',
    strengths: '',
    weaknesses: '',
    flow: [
      '供应商 →（有进项发票采购）→ 跨境电商卖家或者出口公司',
      '跨境电商卖家或者出口公司 ⇄ 香港公司（结算申请退税）',
      '第三方收汇平台 →（收入）→ 香港公司',
      '亚马逊平台注册店铺 →（下单）→ 用户',
    ],
    core:
      '0110 出口合规模式的核心在于设立一家合规的境外公司作为出口交易对手，确保出口公司能以自身名义完成出口流程，并通过合法渠道实现货款的入境结汇。',
    audience: '',
  },
  {
    code: '9610',
    name: '9610',
    feature: '',
    scene: '单店或少店 + 小包直邮',
    refundable: '',
    strengths: '',
    weaknesses: '',
    flow: [],
    core: '',
    audience: '',
  },
  {
    code: '9710',
    name: '跨境电商 B2B 直接出口',
    feature: '企业通过电商平台与境外企业交易，直接发货至境外企业',
    scene: '',
    refundable: '可退税（进项税发票）',
    strengths: '类似 0110 模式',
    weaknesses: '/',
    flow: [
      '供应商 →（有进项发票采购）→ 出口公司（9710）',
      '境内跨境电商公司（一般纳税人）→ 运营公司',
      '跨境电商平台 →（下单）→ 第三方收汇平台 →（结汇申请退税）→ 出口公司',
      '出口公司 →（B2B 出口直运）→ 境外',
    ],
    core:
      '9710 出口模式出口的货物必须是真实的销售，而不是仅仅为了存储或者……境外企业。',
    audience: '',
  },
  {
    code: '9810',
    name: '跨境电商 B2B 出口海外仓',
    feature: '货物先出口海外仓，再用海外仓配送至境外消费者，"离境即退税"',
    scene: '',
    refundable: '出口预退税',
    strengths: '合规，符合法律规定',
    weaknesses: '后续需要核销',
    flow: [
      '跨境电商境内公司 →（前置备货）→ 跨境电商出口海外仓（9810）',
      '跨境电商出口海外仓（9810）→（① 报关出口 / 头程运输）→ 海外仓',
      '海外仓 →（④ 尾程派送）→ 客户 →（② 客户下单）→ 跨境电商平台',
      '跨境电商平台 →（③ 发送订单信息）→ 海外仓',
      '跨境电商平台 →（⑤ 分批收款）→ 第三方收汇平台 →（⑥ 回到对公账户）→ 卖家对公账户',
    ],
    core: '9810 出口模式的核心要求是，完成出口报关，获取进项税发票。',
    audience:
      'FBA 卖家：适配亚马逊平台，将货物批量备至美、欧、日等 FBA 仓。自建仓 / 第三方仓卖家：使用自建或租赁海外仓，需规范报关与资金回流。',
  },
  {
    code: '1039',
    name: '市场采购',
    feature: '货值 15 万美元（含 15 万美元）以下',
    scene: '',
    refundable: '不可申请退税',
    strengths: '解决无票采购出口',
    weaknesses: '只能在试点区域开展',
    flow: [],
    core: '',
    audience: '',
  },
]

// ── 区块 3B：课件「到底选0110还是9810?」场景对照表 ──────────────────────

export interface ModeScenarioRow {
  /** 课件「业务模式」列。 */
  business: string
  /** 课件「建议」列原文。 */
  advice: string
  /** 课件「适用监管代码」列。 */
  code: string
}

export const MODE_SCENARIO_ROWS: ModeScenarioRow[] = [
  {
    business: '多店铺（店群）+ 有专票 + 想退税',
    advice: '做赛维模式、搭建香港公司，归集到 1 家出口公司，流程成熟稳定',
    code: '0110',
  },
  {
    business: '精品单店 + SKU 少 + 想退税',
    advice: '尝试 9810，但先和主管税局确认落地可行性',
    code: '9810',
  },
  {
    business: '多店铺 + 免税即可',
    advice: '9810 免税通道',
    code: '9810',
  },
  {
    business: '单店或少店 + 小包直邮',
    advice: '选 9610',
    code: '9610',
  },
  {
    business: '多种合规模式并存',
    advice: '高客单价高利润产品走 9810，铺货类 SKU 走 0110，不冲突',
    code: '9810 + 0110 双通道',
  },
]

// ── 区块 3C：课件「0110 和 9810 核心区别」六维度对照 ────────────────────

export interface ModeComparisonDimension {
  /** 维度名。 */
  dimension: string
  /** 0110（一般贸易）列。 */
  generalTrade: string
  /** 9810（跨境电商出口海外仓）列。 */
  overseasWarehouse: string
}

export const MODE_COMPARISON_0110_9810: ModeComparisonDimension[] = [
  {
    dimension: '适用场景',
    generalTrade:
      '传统 B2B 大宗贸易，如境内企业向境外批发商、品牌商批量供货；适合线下交易',
    overseasWarehouse: '专为跨境电商"先备货、后销售"模式设计',
  },
  {
    dimension: '业务本质',
    generalTrade: 'B2B 直接出口，货物离境即视为交易完成。',
    overseasWarehouse:
      'B2B2C 备货模式，货物离境仅为物流转移，实际销售发生在海外消费者下单之后。',
  },
  {
    dimension: '收汇要求',
    generalTrade: '需全额收汇',
    overseasWarehouse: '支持"轧差结算"，',
  },
  {
    dimension: '出口退税政策',
    generalTrade:
      '需在货物出口且收汇核销后，凭报关单、增值税专用发票等材料申报退税，周期较长（通常 3-6 个月）。',
    overseasWarehouse: '实行"离境预退税"政策（2025 年新政）首单需销售再退税',
  },
  {
    dimension: '企业资质要求',
    generalTrade: '完成海关注册登记，取得进出口经营权即可。',
    overseasWarehouse: '除海关注册外，还需完成"跨境电商企业备案"。',
  },
  {
    dimension: '中间环节依赖',
    generalTrade:
      '常需借助"香港公司"作为境外采购方，以满足 B2B 贸易真实性要求。',
    overseasWarehouse: '无需离岸公司中转，国内主体可直接操作，链路更短。',
  },
]

// ── 区块 4：企业准入办理（课件「跨境电商出口监管模式与准入指南」） ──────────

export interface AdmissionStep {
  /** 事项名。 */
  name: string
  /** 课件中该事项的说明。 */
  detail: string
}

export const ADMISSION_STEPS: AdmissionStep[] = [
  {
    name: '经营范围确认或变更',
    detail: '营业执照上需有"货物进出口、互联网销售"等字样。',
  },
  {
    name: '海关资质备案',
    detail: '在单一窗口备案进出口收发货人和跨境电商企业。',
  },
  {
    name: '办理电子口岸',
    detail: '完成海关备案后，向电子口岸申请办理电子口岸卡。',
  },
  {
    name: 'DXPID',
    detail: '本地跨境电商公共服务平台申请办理 DXPID，用于订单 / 订仓单申报。',
  },
  {
    name: '银行（外币账户）',
    detail: '外币账户开通。',
  },
  {
    name: '税务局（出口退（免）税备案）',
    detail: '办理出口退（免）税备案（小规模免税、一纳退税）；首退申报前完成。',
  },
]

/** 课件小标题。 */
export const ADMISSION_SUBTITLE = '跨境电商资质获取'

// ── 区块 5A：9810 出口退税必备条件（课件原表） ────────────────────────────

export interface RefundCondition {
  /** 序号（课件原表序号）。 */
  index: number
  /** 条件名。 */
  title: string
  /** 课件原表「具体要求」。 */
  requirement: string
}

export const REFUND_CONDITIONS_9810: RefundCondition[] = [
  {
    index: 1,
    title: '资质情况',
    requirement: '必须具备一般纳税人资格，同时完成退（免）税备案。',
  },
  {
    index: 2,
    title: '100% 自主报关',
    requirement: '所有货物必须由你名下的出口公司自主报关，杜绝买单出口。',
  },
  {
    index: 3,
    title: '采购前端有发票',
    requirement:
      '向供应商采购时，必须取得增值税专用发票（专票才能退税）或普通发票。（品名、单位、数量与报关单上保持一致）',
  },
  {
    index: 4,
    title: '有退税率',
    requirement: '出口货物的增值税退税率 ≠ 0。',
  },
]

/** 课件发票开具口径（Part 05 页左侧要点）。 */
export const INVOICE_SEPARATION_NOTE =
  '国际货运代理费发票、报关费发票、国内运输费发票应分开开票。'

// ── 区块 5B：首单核查材料（本地勾选自查） ────────────────────────────────

export interface MaterialGroup {
  /** 分组 id（用于 checkbox id 前缀）。 */
  id: string
  /** 分组名（课件原表分组）。 */
  name: string
  /** 材料条目。 */
  items: string[]
}

export const FIRST_ORDER_MATERIAL_GROUPS: MaterialGroup[] = [
  {
    id: 'premises',
    name: '企业与场地',
    items: [
      '出口企业首次申报核查情况表',
      '外贸企业出口退税汇总出口明细申报表、外贸企业出口退税进货明细申报表',
      '注册地址租赁合同或者产证（自有）',
      '注册地址租赁发票（最近一个月）',
      '企业固定资产明细帐（无法提供的请说明理由）',
      '注册地址办公区域实景照片',
      '企业员工清册（最近一个月）',
      '企业发放工资银行记录（最近一个月）',
      '企业缴纳社保记录（最近一个月）',
    ],
  },
  {
    id: 'purchase',
    name: '采购',
    items: [
      '首次申报退税货物的采购合同或订单',
      '首次申报退税货物的采购进项发票',
      '首次申报退税货物的采购付款银行记录',
    ],
  },
  {
    id: 'sales',
    name: '销售与收汇',
    items: [
      '首次申报退税货物的出口销售合同或订单',
      '首次申报退税货物的外销发票（普通发票）',
      '首次申报退税货物的银行收汇记录（全部收汇）',
    ],
  },
  {
    id: 'fulfilment',
    name: '出口履约',
    items: [
      '出口报关单',
      '运输单据（海运提单、航空提单、铁路运单、货物承运单据、邮政收据等；出口企业承付运费的国内运输发票、出口企业承付费用的国际货物运输代理服务发票等）',
      '出口企业委托其他单位报关的单据（委托报关协议、受托报关单位为其开具的代理报关服务费发票等）',
    ],
  },
  {
    id: 'other',
    name: '其他核查材料',
    items: ['实地核查自我评估表', '风险提示提醒函'],
  },
]

/** 首单材料总数（由分组派生，避免手写数字与内容漂移）。 */
export const TOTAL_MATERIAL_COUNT = FIRST_ORDER_MATERIAL_GROUPS.reduce(
  (sum, group) => sum + group.items.length,
  0
)

/** 课件原表的一条通用注记（复印件需每页加盖公章）。 */
export const MATERIAL_COPY_NOTE = '注意：所有复印件均要每页加盖公章！！！'

// ── 区块 6：报关字段速查（课件「9810 报关单实务解读」系列） ──────────────

export interface CustomsField {
  /** 字段名。 */
  name: string
  /** 简短解释 / 校对提示（用于理解字段，不生成报关值、不判断填报对错）。 */
  hint: string
}

export const CUSTOMS_FIELDS: CustomsField[] = [
  {
    name: '境内发货人',
    hint: '填写出口公司名和 18 位统一企业社会信用代码。',
  },
  {
    name: '境外收货人',
    hint:
      '填写境外平台的公司名称，如 AMAZON .COM；如是第三方的海外仓库直接填写仓库公司名称（英文），也有部分税局要求填 AMAZON。',
  },
  {
    name: '生产销售单位',
    hint:
      '一般和境内发货人一致，如果境内发货人只是代理公司的抬头，这里写实际货物所有人的名称。',
  },
  {
    name: '合同协议号',
    hint:
      '跨境电商企业有明确要求的，则以跨境电商企业要求的合同号 / 发票号为准。（一般填 FBA 货件号）',
  },
  {
    name: '商品编号',
    hint:
      '出口商品的海关编码，出口商品对应的 HS 编码（有出口过的产品可以填之前归类税号，以便参考）；',
  },
  {
    name: '商品名称',
    hint:
      '供应商开具的具体品名（工厂开票与申报的报关单上面的品名须保持一致，不可有任何偏差，偏差在申请退税时会因匹配不上造成退不了税）。',
  },
  {
    name: '境内货源地',
    hint: '按照货物生产的城市填写，也是开票供应商所在地。',
  },
  {
    name: '贸易国',
    hint:
      '直接交易的国家与地区。与出口报关公司合作方所在国家，指钱从哪个国家汇到大陆，贸易国就写哪个国家。',
  },
  {
    name: '运抵国',
    hint: '货物最终抵达的国家。',
  },
  {
    name: '成交方式',
    hint:
      '1. FOB：离岸价（出口企业承担货物从工厂到离境港口装上船期间产生的相关费用及风险，包含货物成本，不承担船离港后相关费用及风险）。2. C&F：离岸价 + 国际运费（国际运费指即船离境后，需要跨境电商出口企业支付的头程国际运费）。3. CIF：离岸价 + 国际运费 + 保险费（指保险费：跨境电商出口企业自行或委托货代等相关公司购买的保险费用）。',
  },
  {
    name: '数量及单位',
    hint: '每项产品的出口实际数量（与采购发票上面数量尽量保持一致）。',
  },
  {
    name: '币制',
    hint:
      '按实际交易币制填报。如果是东南亚等国交易币种为小币种，则统一按美元来填报。',
  },
  {
    name: '总价',
    hint:
      '课件列出三种口径：采购价 + 国内运杂费 + 利润；预估销售额（慎用）；按照回款金额申报。',
  },
]
