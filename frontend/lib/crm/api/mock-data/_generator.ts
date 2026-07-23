/**
 * CRM mock 数据生成器（确定性、可重复）。
 *
 * 用法：仅被 `*.fixture.ts` 调用一次，导出为常量。
 * 设计原则：seeded RNG（mulberry32）保证多次运行结果一致；
 * 实体之间通过 ID 真实关联（leads → customers）。
 */

import type {
  Customer,
  CustomerRating,
  CustomerSource,
  CustomerStatus,
  Follow,
  FollowType,
  Lead,
  LeadIntent,
  LeadStatus,
  User,
} from '@/lib/crm/types'

function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}

function pickSome<T>(rand: () => number, arr: readonly T[], n: number): T[] {
  const pool = [...arr]
  const out: T[] = []
  const count = Math.min(n, pool.length)
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rand() * pool.length)
    out.push(pool.splice(idx, 1)[0])
  }
  return out
}

function daysAgo(rand: () => number, maxDays: number): string {
  const days = Math.floor(rand() * maxDays)
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return date.toISOString()
}

const COMPANY_SUFFIX = [
  '科技',
  '贸易',
  '实业',
  '集团',
  '股份',
  '有限',
  '国际',
  '控股',
  '电子',
  '信息',
  '文化',
  '传媒',
  '教育',
  '咨询',
  '物流',
  '供应链',
  '电商',
  '智能',
] as const
const COMPANY_PREFIX = [
  '阿里',
  '京东',
  '美团',
  '字节',
  '腾讯',
  '华为',
  '小米',
  '网易',
  '百度',
  '联想',
  '海尔',
  '美的',
  '格力',
  '比亚迪',
  '宁德',
  '顺丰',
  '申通',
  '圆通',
  '中通',
  '韵达',
  '百世',
  '德邦',
  '安能',
  '壹米',
] as const
const FIRST_NAMES = [
  '伟',
  '芳',
  '娜',
  '敏',
  '静',
  '丽',
  '强',
  '磊',
  '军',
  '洋',
  '勇',
  '艳',
  '杰',
  '娟',
  '涛',
  '明',
  '超',
  '秀英',
  '霞',
  '平',
  '刚',
  '桂英',
  '俊',
  '志强',
  '建国',
  '红',
  '辉',
  '建华',
  '玲',
  '桂兰',
] as const
const LAST_NAMES = [
  '李',
  '王',
  '张',
  '刘',
  '陈',
  '杨',
  '黄',
  '赵',
  '吴',
  '周',
  '徐',
  '孙',
  '马',
  '朱',
  '胡',
  '林',
  '郭',
  '何',
  '高',
  '罗',
  '郑',
  '梁',
  '谢',
  '宋',
  '唐',
  '许',
  '韩',
  '冯',
  '邓',
  '曹',
] as const
const INDUSTRIES = [
  '跨境电商',
  '服装鞋帽',
  '美妆个护',
  '家居家电',
  '3C 数码',
  '母婴玩具',
  '运动户外',
  '食品保健',
  '汽配',
  '工业品',
] as const
const SOURCES: readonly CustomerSource[] = [
  'referral',
  'exhibition',
  'online_ad',
  'cold_call',
  'other',
]
const CUSTOMER_STATUSES: readonly CustomerStatus[] = [
  'active',
  'active',
  'active',
  'lost',
  'signed',
  'on_hold',
]
const RATINGS: readonly CustomerRating[] = ['A', 'B', 'B', 'B', 'C', 'C', 'D']
const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'contacting',
  'contacting',
  'qualified',
  'converted',
  'discarded',
]
const LEAD_INTENTS: readonly LeadIntent[] = ['high', 'high', 'medium', 'medium', 'medium', 'low']
const FOLLOW_TYPES: readonly FollowType[] = [
  'phone',
  'visit',
  'wechat',
  'email',
  'note',
  'phone',
  'wechat',
]

function genName(rand: () => number): string {
  return `${pick(rand, LAST_NAMES)}${pick(rand, FIRST_NAMES)}`
}

function genCompanyName(rand: () => number): string {
  return `${pick(rand, COMPANY_PREFIX)}${pick(rand, COMPANY_SUFFIX)}${rand() < 0.5 ? '有限公司' : '股份有限公司'}`
}

function genPhone(rand: () => number): string {
  const prefixes = ['138', '139', '150', '151', '152', '158', '186', '188', '131', '132']
  return `${pick(rand, prefixes)}${String(Math.floor(rand() * 100000000)).padStart(8, '0')}`
}

function genEmail(rand: () => number, name: string): string {
  const domain = pick(rand, [
    'gmail.com',
    'qq.com',
    '163.com',
    'outlook.com',
    'company.cn',
  ] as const)
  return `${name.toLowerCase()}${Math.floor(rand() * 1000)}@${domain}`
}

// ==================== 实体生成 ====================

export function generateUsers(count: number, seed = 1001): User[] {
  const rand = mulberry32(seed)
  const out: User[] = []
  for (let i = 0; i < count; i++) {
    const id = `u-${String(i + 1).padStart(3, '0')}`
    const name = genName(rand)
    const roleType = i === 0 ? 'admin' : i < 4 ? 'businessdev' : 'operator'
    out.push({
      id,
      name,
      email: genEmail(rand, name),
      roleType,
      isActive: rand() > 0.05,
    })
  }
  return out
}

export function generateCustomers(count: number, seed = 2002, users: User[] = []): Customer[] {
  const rand = mulberry32(seed)
  const ownerCandidates = users.length > 0 ? users : []
  const out: Customer[] = []
  for (let i = 0; i < count; i++) {
    const id = `c-${String(i + 1).padStart(4, '0')}`
    const name = genCompanyName(rand)
    const owner =
      i < 10
        ? null
        : i < 40
          ? ownerCandidates[0]
          : ownerCandidates.length > 0
            ? pick(rand, ownerCandidates.slice(1))
            : null
    const created = daysAgo(rand, 365)
    out.push({
      id,
      name,
      shortName: name.slice(0, 4),
      industry: pick(rand, INDUSTRIES),
      rating: pick(rand, RATINGS),
      status: pick(rand, CUSTOMER_STATUSES),
      source: pick(rand, SOURCES),
      ownerId: owner?.id ?? null,
      ownerName: owner?.name,
      contactName: genName(rand),
      contactPhone: genPhone(rand),
      contactEmail: genEmail(rand, 'contact'),
      address: `${pick(rand, ['上海市', '北京市', '深圳市', '杭州市', '广州市'])}某某路 ${Math.floor(rand() * 1000)} 号`,
      website: `https://www.example-${id}.com`,
      annualRevenue: Math.floor(rand() * 500000000),
      employeeCount: Math.floor(rand() * 5000) + 10,
      remark: rand() > 0.5 ? 'VIP 客户，重点跟进' : undefined,
      createdAt: created,
      updatedAt: daysAgo(rand, 30),
      createdBy: ownerCandidates[0]?.id ?? 'u-001',
      lastFollowAt: rand() > 0.2 ? daysAgo(rand, 30) : undefined,
    })
  }
  return out
}

export function generateLeads(
  count: number,
  seed = 3003,
  users: User[] = [],
  customers: Customer[] = []
): Lead[] {
  const rand = mulberry32(seed)
  const ownerCandidates = users.length > 0 ? users : []
  const out: Lead[] = []
  for (let i = 0; i < count; i++) {
    const id = `l-${String(i + 1).padStart(4, '0')}`
    const name = genName(rand)
    const status = pick(rand, LEAD_STATUSES)
    const owner =
      i < 5 ? null : ownerCandidates.length > 0 ? pick(rand, ownerCandidates.slice(1)) : null
    const convertedToCustomerId =
      status === 'converted' && customers.length > 0
        ? customers[Math.floor(rand() * Math.min(customers.length, 30))].id
        : undefined
    out.push({
      id,
      name,
      company: rand() > 0.3 ? genCompanyName(rand) : undefined,
      phone: genPhone(rand),
      email: rand() > 0.4 ? genEmail(rand, name) : undefined,
      wechat: rand() > 0.5 ? `wx_${name.toLowerCase()}${Math.floor(rand() * 10000)}` : undefined,
      source: pick(rand, SOURCES),
      status,
      intent: pick(rand, LEAD_INTENTS),
      ownerId: owner?.id ?? null,
      ownerName: owner?.name,
      expectedAmount: Math.floor(rand() * 500000) + 10000,
      expectedCloseDate: daysAgo(rand, -90),
      remark: rand() > 0.6 ? '初步接触，需进一步沟通' : undefined,
      createdAt: daysAgo(rand, 90),
      updatedAt: daysAgo(rand, 30),
      convertedToCustomerId,
      convertedAt: convertedToCustomerId ? daysAgo(rand, 15) : undefined,
    })
  }
  return out
}

export function generateFollows(
  count: number,
  seed = 5005,
  users: User[] = [],
  customers: Customer[] = [],
  leads: Lead[] = []
): Follow[] {
  const rand = mulberry32(seed)
  const out: Follow[] = []
  const customerWeights = customers.map(() => 2)
  const leadWeights = leads.map(() => 1)
  type EntityRef = {
    entityType: 'customer' | 'lead'
    entityId: string
    weight: number
  }
  const refs: EntityRef[] = [
    ...customers.map((c, i) => ({
      entityType: 'customer' as const,
      entityId: c.id,
      weight: customerWeights[i],
    })),
    ...leads.map((l, i) => ({
      entityType: 'lead' as const,
      entityId: l.id,
      weight: leadWeights[i],
    })),
  ]
  if (refs.length === 0) return []
  const totalWeight = refs.reduce((s, r) => s + r.weight, 0)
  for (let i = 0; i < count; i++) {
    const id = `f-${String(i + 1).padStart(5, '0')}`
    let pickRand = rand() * totalWeight
    const ref =
      refs.find((r) => {
        pickRand -= r.weight
        return pickRand <= 0
      }) ?? refs[0]
    const owner = users.length > 0 ? pick(rand, users) : null
    out.push({
      id,
      entityType: ref.entityType,
      entityId: ref.entityId,
      type: pick(rand, FOLLOW_TYPES),
      content: pick(rand, [
        '客户对产品功能表示认可，约下周再沟通',
        '电话沟通 30 分钟，客户有合作意向',
        '邮件发送报价单，等待客户反馈',
        '上门拜访，客户现场体验良好',
        '微信沟通，初步建立信任关系',
        '跟进记录：客户希望定制化方案',
      ] as const),
      nextFollowAt: rand() > 0.5 ? daysAgo(rand, -14) : undefined,
      createdBy: owner?.id ?? 'u-001',
      createdByName: owner?.name,
      createdAt: daysAgo(rand, 60),
    })
  }
  return out
}
