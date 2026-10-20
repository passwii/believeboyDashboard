/**
 * 跨境电商合规操作台 —— 静态内容单一来源（BLF-1391 / S1）。
 *
 * 内容全部来自用户提供的 16 张课件照片（见 PR 正文「素材来源」与「交付缺漏清单」）。
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

// ── 区块 2：出口业务证据链 ─────────────────────────────────────────────────

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

// ── 区块 3：监管模式对照 ──────────────────────────────────────────────────

export interface RegulatoryMode {
  /** 监管代码。 */
  code: string
  /** 课件中该代码对应的出口模式名。 */
  name: string
  /** 课件中用于区分该模式的业务场景。 */
  scene: string
  /** 课件中该模式的其他可辨认要点。 */
  highlights: string[]
}

export const REGULATORY_MODES: RegulatoryMode[] = [
  {
    code: '0110',
    name: '一般贸易（跨境电商 0110 出口模式）',
    scene:
      '传统 B2B 大宗出口；课件以「设立一家合规的境外公司作为出口交易对手」为核心做法。',
    highlights: [
      '痛点：收汇与报关不一致',
      '痛点：业务模式不合规',
      '中间环节常需借助境外公司（如香港公司）',
    ],
  },
  {
    code: '9610',
    name: '9610',
    scene: '课件场景：单店或少店 + 小包直邮。',
    highlights: ['课件未展开 9610 的逐项讲解，此处仅保留可辨认的场景描述。'],
  },
  {
    code: '9710',
    name: '跨境电商 B2B 直接出口',
    scene: '企业通过电商平台与境外企业交易，直接发货至境外企业。',
    highlights: ['核心要求：出口的货物必须是真实的销售', '可退税（进项税发票）'],
  },
  {
    code: '9810',
    name: '跨境电商 B2B 出口海外仓',
    scene: '货物先出口海外仓，再用海外仓配送至境外消费者，课件称为「离境即退税」。',
    highlights: [
      '核心要求：完成出口报关，获取进项税发票',
      '出口预退税',
      '合规，符合法律规定；后续需要核销',
    ],
  },
  {
    code: '1039',
    name: '市场采购',
    scene: '课件标注货值 15 万美元（含 15 万美元）以下。',
    highlights: ['不可申请退税', '解决无票采购出口', '只能在试点区域开展'],
  },
]

// ── 区块 4：企业准入办理 ──────────────────────────────────────────────────

export interface AdmissionStep {
  /** 事项名。 */
  name: string
  /** 课件中该事项的说明。 */
  detail: string
}

export const ADMISSION_STEPS: AdmissionStep[] = [
  {
    name: '经营范围确认或变更',
    detail: '营业执照上需有「货物进出口、互联网销售」等字样。',
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

// ── 区块 5A：9810 出口退税必备条件 ────────────────────────────────────────

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

// ── 区块 5B：首单核查材料（本地勾选自查） ─────────────────────────────────

export interface MaterialGroup {
  /** 分组 id（用于 checkbox id 前缀）。 */
  id: string
  /** 分组名（课件原表分组）。 */
  name: string
  /** 材料条目（按课件原表序号）。 */
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

// ── 区块 5C：报关字段速查 ────────────────────────────────────────────────

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
      '出口商品的海关编码，出口商品对应的 HS 编码（有出口过的产品可以填之前归类税号，以便参考）。',
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
