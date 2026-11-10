import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications, stableSession } from '@/test-utils/stable-mocks'

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replaced: [] as string[],
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  usePathname: () => '/dashboard/crm/intent',
  useRouter: () => ({
    replace: (url: string) => {
      nav.replaced.push(String(url))
      nav.params = new URLSearchParams(String(url).split('?')[1] ?? '')
    },
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}))
vi.mock('next-auth/react', () => ({
  useSession: () =>
    stableSession({ user: { id: 'u-1', name: '张三', roleType: 'admin' } }),
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))
vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))
vi.mock('@/lib/download-blob', () => ({ downloadBlob: vi.fn() }))

import { downloadBlob } from '@/lib/download-blob'
import { ApiError } from '@/lib/crm/intent/http-client'
import type { IntentClient } from '@/lib/crm/intent/client'
import {
  INTENT_STATE_LABELS,
  INTENT_STATE_ORDER,
  type IntentCompany,
  type IntentCompanyDetail,
  type IntentFollowup,
  type IntentFollowupInput,
  type IntentMeta,
  type IntentPoolPage,
  type IntentProfileInput,
} from '@/lib/crm/intent/types'

import IntentWorkbench from './_components/intent-workbench'

const META: IntentMeta = {
  batch: {
    id: 7,
    batchDate: '2026-11-10',
    updatedAt: '2026-11-10T10:00:00+08:00',
    total: 12,
    poolTotal: 80,
    source: 'ai',
    sourceFileName: null,
  },
  stats: {
    total: 12,
    byLevel: { A: 3, B: 3, C: 3, D: 3 },
    withPhone: 12,
    contacted: 3,
    followedUp: 3,
    poolTotal: 80,
    dupGroups: 0,
    dueCount: 1,
  },
  facets: {
    levels: ['A', 'B', 'C', 'D'],
    categories: ['家居用品'],
    channels: [],
    provinces: ['浙江'],
    cities: [{ province: '浙江', cities: ['宁波'] }],
    states: INTENT_STATE_ORDER.map((state) => ({ value: state, label: INTENT_STATE_LABELS[state] })),
  },
  dataRev: 31,
  followupRev: 3,
  changed: true,
  serverTime: '2026-11-10T10:00:00+08:00',
}

function followupFixture(overrides: Partial<IntentFollowup> = {}): IntentFollowup {
  return {
    state: 'none',
    stateLabel: '未联系',
    note: '',
    lastContactAt: null,
    nextContactAt: null,
    version: 3,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  }
}

function companyFixture(overrides: Partial<IntentCompany> & { id: number; name: string }): IntentCompany {
  const followup = overrides.followup ?? followupFixture()
  const base: IntentCompany = {
    id: overrides.id,
    batchId: 7,
    batchDate: '2026-11-10',
    externalId: null,
    name: overrides.name,
    creditCode: null,
    legalPerson: '张三',
    province: '浙江',
    city: '宁波',
    foundedYear: 2012,
    registeredCapitalWan: 300,
    products: '懒人沙发、收纳箱',
    category: '家居用品',
    channel: null,
    channels: [],
    channelSource: null,
    trademarks: [],
    trademarkCount: 0,
    intentLevel: 'A',
    intentScore: 86,
    intentBasis: '主营产品为轻小件',
    amazonFit: null,
    walmartFit: null,
    sources: [],
    risks: null,
    screenedAt: '2026-11-09',
    phoneNote: null,
    owner: null,
    humanTouched: false,
    convertedCustomerId: null,
    convertedAt: null,
    phones: [
      { id: 1, raw: '13800000001', normalized: '13800000001', source: 'list', isValid: false },
    ],
    followup,
  }
  return { ...base, ...overrides }
}

const COMPANY_A = companyFixture({
  id: 1,
  name: '宁波岚川家居用品有限公司',
  intentLevel: 'A',
  intentScore: 86,
  owner: { id: 'u-2', name: '李四' },
})
const COMPANY_B = companyFixture({
  id: 2,
  name: '宁波云栖日用品有限公司',
  intentLevel: 'B',
  intentScore: 70,
  followup: followupFixture({ state: 'contacted', stateLabel: '已联系', version: 2 }),
})

const DETAIL: IntentCompanyDetail = {
  ...COMPANY_A,
  sharedPhones: [
    {
      phoneNormalized: '13800000001',
      raw: '13800000001',
      companies: [{ id: 2, name: '宁波云栖日用品有限公司', intentLevel: 'B' }],
      pool: [],
    },
  ],
}

const POOL: IntentPoolPage = {
  items: [
    {
      id: 9,
      name: '池企业甲',
      legalPerson: '王五',
      website: 'https://example.com',
      channel: '展会',
      channels: ['展会'],
      channelSource: null,
      status: 'pending',
      phones: [{ id: 2, raw: '13900000001', normalized: '13900000001', source: 'list', isValid: false }],
    },
  ],
  total: 80,
  page: 1,
  pageSize: 60,
}

function createClient(overrides: Partial<IntentClient> = {}): IntentClient {
  return {
    getMeta: vi.fn(async () => META),
    listCompanies: vi.fn(async () => ({
      items: [COMPANY_A, COMPANY_B],
      total: 12,
      page: 1,
      pageSize: 50,
    })),
    getCompany: vi.fn(async () => DETAIL),
    updateProfile: vi.fn(
      async (_id: number, input: IntentProfileInput) =>
        ({
          ...DETAIL,
          creditCode: input.creditCode,
          legalPerson: input.legalPerson,
          province: input.province,
          city: input.city,
          products: input.products,
          category: input.category,
          channel: input.channel,
          channels: input.channels,
          channelSource: input.channelSource,
          trademarks: input.trademarks,
          intentLevel: input.intentLevel,
          intentScore: input.intentScore,
          sources: input.sources,
          risks: input.risks,
          screenedAt: input.screenedAt,
        }),
    ),
    updateFollowup: vi.fn(
      async (_id: number, input: IntentFollowupInput, version: number) =>
        followupFixture({
          ...input,
          stateLabel: INTENT_STATE_LABELS[input.state ?? 'none'],
          version: version + 1,
        }) as IntentFollowup
    ),
    claimCompany: vi.fn(async () => ({
      ...DETAIL,
      owner: { id: 'u-1', name: '张三' },
      humanTouched: true,
    })),
    addPhone: vi.fn(async () => ({
      ...DETAIL,
      phones: [
        ...DETAIL.phones,
        { id: 5, raw: '13900000002', normalized: '13900000002', source: 'manual' as const, isValid: false },
      ],
    })),
    setPhoneValid: vi.fn(async () => ({
      ...DETAIL,
      phones: DETAIL.phones.map((phone) => ({ ...phone, isValid: true })),
    })),
    deletePhone: vi.fn(async () => DETAIL),
    convertCompany: vi.fn(async () => ({
      companyId: 1,
      customerId: 88,
      dataRev: 32,
      company: {
        ...DETAIL,
        convertedCustomerId: 88,
        convertedAt: '2026-11-10T12:00:00+08:00',
      },
    })),
    getBoard: vi.fn(async () => ({
      groups: INTENT_STATE_ORDER.map((state) => ({
        state,
        stateLabel: INTENT_STATE_LABELS[state],
        count: state === 'contacted' ? 3 : 0,
        items:
          state === 'contacted'
            ? [
                {
                  id: 2,
                  name: '宁波云栖日用品有限公司',
                  intentLevel: 'B' as const,
                  intentLevelLabel: '可培育',
                  intentScore: 70,
                  nextContactAt: null,
                  owner: { id: 'u-2', name: '李四' },
                  updatedAt: '2026-11-10T10:00:00+08:00',
                },
              ]
            : [],
      })),
      total: 3,
    })),
    getPool: vi.fn(async () => POOL),
    exportCsv: vi.fn(async () => ({
      blob: new Blob(['csv']),
      filename: '客户雷达_意向客户_2026-11-10.csv',
    })),
    uploadBatch: vi.fn(),
    listBatches: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    getBatch: vi.fn(async () => ({
      id: 7,
      batchDate: '2026-11-10',
      source: 'manual',
      sourceLabel: '人工导入',
      sourceFileName: null,
      totalCompanies: 10,
      totalPool: 5,
      createdCount: 8,
      updatedCount: 1,
      skippedLockedCount: 1,
      rejectedCount: 0,
      status: 'completed',
      errorDetail: null,
      createdAt: null,
      completedAt: null,
      rejected: [],
      rows: [],
      rowsTruncated: false,
    })),
    ...overrides,
  }
}

function renderPage(client: IntentClient) {
  return render(<IntentWorkbench client={client} />)
}

beforeEach(() => {
  nav.params = new URLSearchParams()
  nav.replaced = []
  vi.clearAllMocks()
})

describe('意向客户工作台', () => {
  it('渲染 Warm 页面、工具栏、5 张指标与卡片网格', async () => {
    const client = createClient()
    const { container } = renderPage(client)

    await screen.findByText('宁波岚川家居用品有限公司')

    expect(container.querySelector('[data-warm-crm-page]')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-crm-toolbar]')).toBeInTheDocument()
    expect(container.querySelector('[data-intent-metrics]')).toBeInTheDocument()
    expect(screen.getByText(/批次 2026-11-10/)).toBeInTheDocument()
    expect(screen.getByText('同步正常')).toBeInTheDocument()

    const metrics = container.querySelector('[data-intent-metrics]')
    expect(metrics?.textContent).toContain('在库企业')
    expect(metrics?.textContent).toContain('12')
    expect(metrics?.textContent).toContain('80')

    expect(
      screen.getByRole('button', { name: '打开 宁波岚川家居用品有限公司 详情' })
    ).toBeInTheDocument()
    expect(client.getMeta).toHaveBeenCalled()
    expect(client.listCompanies).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mine', page: 1, pageSize: 50 }),
      expect.anything()
    )
  })

  it('切到待筛池 / 跟进看板时各自加载数据', async () => {
    const client = createClient()
    renderPage(client)
    await screen.findByText('宁波岚川家居用品有限公司')

    const tabs = screen.getByRole('group', { name: '视图页签' })
    fireEvent.click(within(tabs).getByText('待筛池 80'))
    await screen.findByText('池企业甲')
    expect(client.getPool).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 60 }),
      expect.anything()
    )

    fireEvent.click(within(tabs).getByText('跟进看板 3'))
    await screen.findByText('宁波云栖日用品有限公司')
    expect(client.getBoard).toHaveBeenCalledWith('mine', expect.anything())
    expect(screen.getAllByText('已联系').length).toBeGreaterThan(0)
  })

  it('级别筛选写入 URL 并按 level=A 重新取数', async () => {
    const client = createClient()
    renderPage(client)
    await screen.findByText('宁波岚川家居用品有限公司')

    const levelGroup = screen.getByRole('group', { name: '意向级别筛选' })
    fireEvent.click(within(levelGroup).getByText('A 级'))

    await waitFor(() =>
      expect(client.listCompanies).toHaveBeenLastCalledWith(
        expect.objectContaining({ level: 'A', page: 1 }),
        expect.anything()
      )
    )
    expect(nav.replaced.at(-1)).toContain('level=A')
  })

  it('?record= 深链打开抽屉，改状态走乐观更新 + If-Match version', async () => {
    nav.params = new URLSearchParams('record=1')
    const client = createClient()
    renderPage(client)

    await waitFor(() => expect(client.getCompany).toHaveBeenCalledWith(1, expect.anything()))
    await screen.findByText('统一社会信用代码')
    expect(screen.getByLabelText('跟进状态')).toHaveValue('none')

    fireEvent.change(screen.getByLabelText('跟进状态'), { target: { value: 'quoted' } })

    await waitFor(() =>
      expect(client.updateFollowup).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ state: 'quoted', lastContactAt: expect.any(String) }),
        3
      )
    )
    await waitFor(() => expect(screen.getByLabelText('跟进状态')).toHaveValue('quoted'))
  })

  it('409 冲突覆盖服务端 current 并提示已刷新', async () => {
    nav.params = new URLSearchParams('record=1')
    const client = createClient({
      updateFollowup: vi.fn(async () => {
        throw new ApiError(409, '记录已被其他人更新', {
          detail: {
            code: 'INTENT_VERSION_CONFLICT',
            current: { state: 'won', state_label: '已成交', version: 6, note: '' },
          },
        })
      }),
    })
    renderPage(client)

    await screen.findByText('统一社会信用代码')
    fireEvent.change(screen.getByLabelText('跟进状态'), { target: { value: 'quoted' } })

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'warning', title: '记录已被其他人更新' })
      )
    )
    await waitFor(() => expect(screen.getByLabelText('跟进状态')).toHaveValue('won'))
  })

  it('关闭抽屉时 flush 未落地的备注', async () => {
    nav.params = new URLSearchParams('record=1')
    const client = createClient()
    renderPage(client)

    await screen.findByText('统一社会信用代码')
    const note = screen.getByLabelText('跟进备注') as HTMLTextAreaElement
    fireEvent.change(note, { target: { value: '已电话沟通，对方希望先看英文版资料' } })

    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    fireEvent.click(closeButtons[closeButtons.length - 1])

    await waitFor(() =>
      expect(client.updateFollowup).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ note: '已电话沟通，对方希望先看英文版资料' }),
        3
      )
    )
  })

  it('零数据与筛选无结果是两套文案；管理员可见导入入口', async () => {
    const zeroMeta: IntentMeta = {
      ...META,
      batch: null,
      stats: { ...META.stats, total: 0, contacted: 0, poolTotal: 0, byLevel: { A: 0, B: 0, C: 0, D: 0 } },
    }
    const client = createClient({
      getMeta: vi.fn(async () => zeroMeta),
      listCompanies: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 50 })),
    })
    renderPage(client)

    await screen.findByText('还没有意向客户数据')
    expect(screen.queryByText('没有符合条件的企业')).not.toBeInTheDocument()
    expect(screen.getAllByText('导入批次').length).toBeGreaterThan(0)
  })

  it('管理员打开导入批次 Dialog（含批次日期与文件选择）', async () => {
    const client = createClient()
    renderPage(client)
    await screen.findByText('宁波岚川家居用品有限公司')

    fireEvent.click(screen.getByRole('button', { name: '导入批次' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('导入批次')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('批次日期')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('批次文件')).toBeInTheDocument()
  })

  it('共用号码 Dialog 列出共用公司，点击后切换抽屉记录', async () => {
    nav.params = new URLSearchParams('record=1')
    const client = createClient()
    renderPage(client)

    await screen.findByText('统一社会信用代码')
    fireEvent.click(screen.getByRole('button', { name: '共用 1 家' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('号码共用')).toBeInTheDocument()
    expect(within(dialog).getByText('13800000001')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: /宁波云栖日用品有限公司/ }))
    await waitFor(() => expect(client.getCompany).toHaveBeenLastCalledWith(2, expect.anything()))
    await waitFor(() => expect(nav.params.get('record')).toBe('2'))
  })

  it('转为客户确认后调用 convertCompany 并显示已转客户', async () => {
    nav.params = new URLSearchParams('record=1')
    const client = createClient()
    renderPage(client)

    await screen.findByText('统一社会信用代码')
    fireEvent.click(screen.getByRole('button', { name: '转为客户' }))

    await waitFor(() => expect(client.convertCompany).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.getAllByText('已转客户').length).toBeGreaterThan(0))
  })

  it('P0-1：待领取（scope=sea）详情带 scope 请求并可领取', async () => {
    nav.params = new URLSearchParams('scope=sea&record=1')
    const client = createClient({
      getCompany: vi.fn(async () => ({ ...DETAIL, owner: null, humanTouched: false })),
    })
    renderPage(client)

    await screen.findByText('统一社会信用代码')
    expect(client.getCompany).toHaveBeenCalledWith(1, expect.objectContaining({ scope: 'sea' }))
    expect(screen.getByText(/筛于 2026-11-09 · 批次 2026-11-10/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '领取' }))
    await waitFor(() => expect(client.claimCompany).toHaveBeenCalledWith(1))
  })

  it('P1-2：编辑资料提交 PATCH profile 字段并整体替换详情', async () => {
    nav.params = new URLSearchParams('record=1')
    const client = createClient()
    renderPage(client)

    await screen.findByText('统一社会信用代码')
    fireEvent.click(screen.getByRole('button', { name: '编辑资料' }))
    expect(screen.getByLabelText('统一社会信用代码')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('法人'), { target: { value: '王五' } })
    fireEvent.change(screen.getByRole('textbox', { name: '省份' }), { target: { value: '江苏' } })
    fireEvent.change(screen.getByRole('textbox', { name: '渠道' }), { target: { value: '展会' } })
    fireEvent.change(screen.getByRole('textbox', { name: '渠道明细' }), {
      target: { value: '展会、官网' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: '渠道来源' }), {
      target: { value: 'batch-2026-11-10.csv' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存资料' }))

    await waitFor(() =>
      expect(client.updateProfile).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          legalPerson: '王五',
          province: '江苏',
          intentLevel: 'A',
          channel: '展会',
          channels: ['展会', '官网'],
          channelSource: 'batch-2026-11-10.csv',
        })
      )
    )
    await waitFor(() => expect(screen.getByText('王五')).toBeInTheDocument())
    expect(screen.getByText('展会 / 官网')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存资料' })).not.toBeInTheDocument()
  })

  it('P1-7：溢出计数渲染为 +N（不出现 +$）', async () => {
    const many = companyFixture({
      id: 3,
      name: '多产品企业',
      products: '甲、乙、丙、丁、戊、己',
      channels: ['展会', '官网'],
    })
    const client = createClient({
      listCompanies: vi.fn(async () => ({ items: [many], total: 1, page: 1, pageSize: 50 })),
      getPool: vi.fn(async () => ({
        ...POOL,
        items: [
          {
            ...POOL.items[0],
            phones: [
              { id: 2, raw: '13900000001', normalized: '13900000001', source: 'list' as const, isValid: false },
              { id: 3, raw: '13900000002', normalized: '13900000002', source: 'list' as const, isValid: false },
            ],
            channels: ['展会', '官网'],
            channel: '展会',
          },
        ],
      })),
    })
    const { container } = renderPage(client)

    await screen.findByText('多产品企业')
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(container.textContent).not.toContain('+$')

    fireEvent.click(within(screen.getByRole('group', { name: '列表视图' })).getByText('表格'))
    await waitFor(() => expect(screen.getByText('+1')).toBeInTheDocument())

    const tabs = screen.getByRole('group', { name: '视图页签' })
    fireEvent.click(within(tabs).getByText('待筛池 80'))
    await screen.findByText('池企业甲')
    await waitFor(() => expect(screen.getAllByText('+1').length).toBeGreaterThanOrEqual(2))
  })

  it('P2-9：已联系指标按 state=contacted 联动筛选', async () => {
    const client = createClient()
    renderPage(client)
    await screen.findByText('宁波岚川家居用品有限公司')

    fireEvent.click(screen.getByRole('button', { name: /已联系/ }))
    await waitFor(() =>
      expect(client.listCompanies).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'contacted', page: 1 }),
        expect.anything()
      )
    )
    expect(nav.replaced.at(-1)).toContain('state=contacted')
  })

  it('导出 CSV 使用服务端文件名触发下载', async () => {
    const client = createClient()
    renderPage(client)
    await screen.findByText('宁波岚川家居用品有限公司')

    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }))
    await waitFor(() => expect(client.exportCsv).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mine', sort: 'score' })
    ))
    expect(vi.mocked(downloadBlob)).toHaveBeenCalled()
    const filename = vi.mocked(downloadBlob).mock.calls[0]?.[1]
    expect(filename).toBe('客户雷达_意向客户_2026-11-10.csv')
  })
})
