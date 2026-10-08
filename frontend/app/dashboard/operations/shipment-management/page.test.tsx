import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const excelCapture = vi.hoisted(() => ({
  sheetNames: [] as string[],
  valuesBySheet: {} as Record<string, unknown[][]>,
  fillsBySheet: {} as Record<string, Array<Array<unknown>>>,
  bordersBySheet: {} as Record<string, Array<Array<unknown>>>,
  mergesBySheet: {} as Record<string, string[]>,
  imageCount: 0,
  sheetImageCount: 0,
}))

vi.mock('exceljs', () => {
  class FakeWorksheet {
    name: string
    views: unknown[] = []
    columns: unknown[] = []
    constructor(name: string) {
      this.name = name
    }
    getRow(rowNumber: number) {
      const sheetName = this.name
      const makeCell = (column: number) => ({
        font: {},
        alignment: {},
        numFmt: undefined as unknown,
        set value(value: unknown) {
          const rows = excelCapture.valuesBySheet[sheetName] ?? []
          rows[rowNumber] ??= []
          rows[rowNumber][column - 1] = value
          excelCapture.valuesBySheet[sheetName] = rows
        },
        get value() {
          return excelCapture.valuesBySheet[sheetName]?.[rowNumber]?.[column - 1]
        },
        set fill(value: unknown) {
          const rows = excelCapture.fillsBySheet[sheetName] ?? []
          rows[rowNumber] ??= []
          rows[rowNumber][column] = value
          excelCapture.fillsBySheet[sheetName] = rows
        },
        get fill() {
          return excelCapture.fillsBySheet[sheetName]?.[rowNumber]?.[column]
        },
        set border(value: unknown) {
          const rows = excelCapture.bordersBySheet[sheetName] ?? []
          rows[rowNumber] ??= []
          rows[rowNumber][column] = value
          excelCapture.bordersBySheet[sheetName] = rows
        },
        get border() {
          return excelCapture.bordersBySheet[sheetName]?.[rowNumber]?.[column]
        },
      })
      return {
        height: 0,
        font: {},
        getCell: (column: number) => makeCell(column),
        eachCell: (
          optionsOrCallback: unknown,
          callback?: (cell: ReturnType<typeof makeCell>, column: number) => void
        ) => {
          const eachCallback =
            typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
          const cells = Array.from({ length: 18 }, (_, index) => makeCell(index + 1))
          if (eachCallback) cells.forEach((cell, index) => eachCallback(cell, index + 1))
        },
        set values(values: unknown) {
          const rows = excelCapture.valuesBySheet[sheetName] ?? []
          rows[rowNumber] = Array.isArray(values) ? values : []
          excelCapture.valuesBySheet[sheetName] = rows
        },
      }
    }
    getCell(rowNumber: number, column: number) {
      return this.getRow(rowNumber).getCell(column)
    }
    mergeCells(...args: unknown[]) {
      const merges = excelCapture.mergesBySheet[this.name] ?? []
      merges.push(args.join(':'))
      excelCapture.mergesBySheet[this.name] = merges
    }
    addRow(values: unknown) {
      const rows = excelCapture.valuesBySheet[this.name] ?? []
      rows.push(Array.isArray(values) ? values : [values])
      excelCapture.valuesBySheet[this.name] = rows
      return this.getRow(rows.length)
    }
    addImage() {
      excelCapture.sheetImageCount += 1
    }
  }
  class FakeWorkbook {
    creator = ''
    created: Date = new Date()
    worksheets: FakeWorksheet[] = []
    addWorksheet(name: string) {
      excelCapture.sheetNames.push(name)
      const worksheet = new FakeWorksheet(name)
      this.worksheets.push(worksheet)
      return worksheet
    }
    addImage() {
      excelCapture.imageCount += 1
      return 1
    }
    get xlsx() {
      return {
        writeBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        load: () => Promise.resolve(this),
      }
    }
  }
  return { Workbook: FakeWorkbook, default: { Workbook: FakeWorkbook } }
})

// ── mocks ────────────────────────────────────────────────────────────────────

// 稳定引用（关键教训）：useSession / useNotifications 的 mock 必须返回稳定 identity，
// 否则 loader 的 useCallback deps 抖动 → useEffect 重复触发、双重 fetch、loading 断言竞态。
const { stableSession, mockNotify, fetchMock } = vi.hoisted(() => ({
  stableSession: { user: { id: 'user-1', roleType: 'admin', isAdmin: true } },
  mockNotify: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
}))

// 每个用例可重写 mockSearchParams（如 ?tab=cost / ?tab=fba-box-detail&shipment_no=...）
let mockSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/shipment-management',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

// 捕获 header 插槽节点 / 刷新回调 / loading 上报，供断言
let capturedSlotNode: unknown = null
let capturedRefreshHandler: (() => void) | null = null
let capturedRefreshLoading: boolean | undefined
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
    return { setLoading: vi.fn() }
  },
  // 测试环境无 TerminalHeader anchor：就地渲染插槽内容，便于断言上移控件
  useHeaderSlot: (node: unknown) => {
    capturedSlotNode = node
    return node
  },
  useMobileFilterStrip: () => null,
}))

// ── 数据工厂 ──────────────────────────────────────────────────────────────────

function listItem(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    project_id: 1,
    project_name: '项目A',
    country: 'US',
    shipment_no: 'FBA12345678',
    tracking_no: 'TBA-001',
    warehouse_code: 'WH-01',
    forwarder_name: '测试货代',
    shipping_method: 'sea',
    created_date: '2026-08-01',
    etd_date: '2026-08-05',
    eta_date: '2026-08-20',
    actual_inbound_date: null,
    shipment_status: 'in_transit',
    remark: null,
    sku_count: 2,
    total_quantity: 100,
    logistics_unit_price: 12.5,
    total_volume_m3: 1.2,
    total_chargeable_weight_kg: 300,
    logistics_total_price: 1250,
    include_in_history_shipping_calc: true,
    updated_at: '2026-08-01T00:00:00Z',
    shipment_batch: 'BATCH-01',
    ...overrides,
  }
}

function listPayload() {
  return { items: [listItem()], page: 1, page_size: 20, total: 1, has_next: false }
}

function detailPayload() {
  return {
    ...listItem(),
    items: [
      {
        id: 11,
        item_date: '2026-08-01',
        sku: 'SKU-001',
        quantity: 100,
        carton_count: 10,
        remark: null,
        volume_m3: 1.2,
        actual_weight_kg: 280,
        volumetric_weight_kg: 300,
        chargeable_weight_kg: 300,
        estimated_logistics_cost: 1250,
        average_logistics_unit_price: 12.5,
      },
    ],
  }
}

function costSummaryPayload() {
  return {
    shipment_count: 1,
    total_sku: 2,
    total_quantity: 100,
    total_chargeable_weight_kg: 300,
    total_logistics_cost: 1250,
  }
}

function skuSummaryPayload() {
  return {
    items: [
      {
        project_id: 1,
        project_name: '项目A',
        country: 'US',
        sku: 'SKU-001',
        shipment_count: 1,
        total_quantity: 100,
        total_chargeable_weight_kg: 300,
        total_logistics_cost: 1250,
        average_logistics_unit_price: 12.5,
      },
    ],
  }
}

function fbaBoxPayload() {
  return {
    project_ids: [1],
    project_names: ['项目A'],
    countries: ['US'],
    shipment_nos: ['FBA12345678'],
    items: [
      {
        project_id: 1,
        project_name: '项目A',
        country: 'US',
        shipment_no: 'FBA12345678',
        warehouse_code: 'WH-01',
        sku: 'TEST-SKU-FBA',
        product_name: '测试品',
        asin: 'B0TEST',
        fnsku: 'FNSKU-1',
        package_length_cm: 10,
        package_width_cm: 10,
        package_height_cm: 10,
        weight_kg: 1,
        length_cm: 50,
        width_cm: 40,
        height_cm: 30,
        carton_weight_kg: 12,
        quantity: 100,
        units_per_carton: 10,
        carton_count: 10,
        full_carton_count: 10,
        partial_carton_units: 0,
        outer_box_text: 'BOX',
        total_weight_kg: 120,
        total_volume_m3: 0.6,
        fba_label_prefix: 'FBA',
        tracking_no: 'TBA-001',
        product_image_thumbnail_r2_url: null,
        product_image_r2_url: 'https://example.com/product.png',
      },
      {
        project_id: 1,
        project_name: '项目A',
        country: 'US',
        shipment_no: 'FBA12345678',
        warehouse_code: 'WH-01',
        sku: 'TEST-SKU-FBA-2',
        product_name: '测试品二',
        asin: 'B0TEST2',
        fnsku: 'FNSKU-2',
        package_length_cm: 10,
        package_width_cm: 10,
        package_height_cm: 10,
        weight_kg: 1,
        length_cm: 50,
        width_cm: 40,
        height_cm: 30,
        carton_weight_kg: 12,
        quantity: 50,
        units_per_carton: 10,
        carton_count: 5,
        full_carton_count: 5,
        partial_carton_units: 0,
        outer_box_text: 'BOX',
        total_weight_kg: 60,
        total_volume_m3: 0.3,
        fba_label_prefix: 'FBA',
        tracking_no: 'TBA-001',
        product_image_thumbnail_r2_url: null,
        product_image_r2_url: 'https://example.com/product.png',
      },
    ],
  }
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response
}

/** 默认 fetch 路由：按 URL 子串分派到各 loader 的响应 */
function defaultFetchImpl(url: string): Promise<Response> {
  const u = String(url)
  if (u.includes('/cost-summary')) return Promise.resolve(jsonResponse(costSummaryPayload()))
  if (u.includes('/sku-summary')) return Promise.resolve(jsonResponse(skuSummaryPayload()))
  if (u.includes('/fba-box-details')) return Promise.resolve(jsonResponse(fbaBoxPayload()))
  if (u.includes('/shipment-schedules?')) return Promise.resolve(jsonResponse(listPayload()))
  return Promise.resolve(jsonResponse(detailPayload()))
}

function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]))
}

import ShipmentManagementPage from './page'

// ── tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSearchParams = new URLSearchParams()
  fetchMock.mockImplementation(defaultFetchImpl)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  excelCapture.sheetNames = []
  excelCapture.valuesBySheet = {}
  excelCapture.fillsBySheet = {}
  excelCapture.bordersBySheet = {}
  excelCapture.mergesBySheet = {}
  excelCapture.imageCount = 0
  excelCapture.sheetImageCount = 0
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  capturedSlotNode = null
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
})

describe('ShipmentManagementPage header 化渲染契约（operations header migration B2）', () => {
  it('渲染不崩溃：4 个 tab、表格行与写操作栏齐全', async () => {
    render(<ShipmentManagementPage />)
    // 列表加载完成（overview tab 默认）
    expect(await screen.findByText('FBA12345678')).toBeInTheDocument()
    // 4 动效 tabs 保留
    expect(screen.getByText('总览')).toBeInTheDocument()
    expect(screen.getByText('发货费用')).toBeInTheDocument()
    expect(screen.getByText('SKU汇总')).toBeInTheDocument()
    expect(screen.getByText('FBA 箱单明细')).toBeInTheDocument()
    // 写操作留正文：新建批次 / 下载模板 / 批量导入（批量导入为 asChild label + 隐藏 file input）
    expect(screen.getByRole('button', { name: /新建批次/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下载模板/ })).toBeInTheDocument()
    expect(screen.getByText('批量导入')).toBeInTheDocument()
  })

  it('将页签与写操作收进同一工具行，窄屏时上下排列', async () => {
    render(<ShipmentManagementPage />)
    await screen.findByText('FBA12345678')

    const toolbar = screen.getByTestId('shipment-management-toolbar')
    expect(toolbar).toContainElement(screen.getByRole('tablist'))
    expect(toolbar).toContainElement(screen.getByRole('button', { name: /新建批次/ }))
    expect(toolbar).toContainElement(screen.getByRole('button', { name: /下载模板/ }))
    expect(toolbar).toHaveClass('flex-col', 'lg:flex-row')
  })

  it('筛选控件上移 header 插槽：项目 / 状态 / 国家 / 货件编号 combobox 注册进插槽', async () => {
    render(<ShipmentManagementPage />)
    await screen.findByText('FBA12345678')
    // 插槽节点已注册
    expect(capturedSlotNode).not.toBeNull()
    // 3 个 HeaderSlotSelect + term combobox 触发器
    expect(screen.getByTitle('项目筛选')).toBeInTheDocument()
    expect(screen.getByTitle('状态筛选')).toBeInTheDocument()
    expect(screen.getByTitle('国家筛选')).toBeInTheDocument()
    expect(screen.getByTitle('货件编号筛选')).toBeInTheDocument()
    // combobox 空选时显示「全部货件」
    expect(screen.getByText('全部货件')).toBeInTheDocument()
  })

  it('旧控制台已移除：无「控制台」文案、无页内刷新按钮、无旧筛选 label', async () => {
    render(<ShipmentManagementPage />)
    await screen.findByText('FBA12345678')
    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
    // 控制台全局刷新 + fba tab 内局部刷新均已删除（全局刷新唯一入口）
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument()
    // 旧控制台筛选 label（header 控件不带 label，语义由 trigger 值/title 承载）
    expect(screen.queryByText('国家地区')).not.toBeInTheDocument()
  })

  it('头部刷新（总览 tab）：重拉当前列表 loadList(1) 并上报 loading', async () => {
    render(<ShipmentManagementPage />)
    await screen.findByText('FBA12345678')
    expect(capturedRefreshHandler).not.toBeNull()
    fetchMock.mockClear()

    // 受控 deferred Promise 挂起本次重拉，确定性断言 loading 上报
    let resolveListFetch!: (value: Response) => void
    const pendingListFetch = new Promise<Response>((resolve) => {
      resolveListFetch = resolve
    })
    fetchMock.mockImplementationOnce(() => pendingListFetch)

    capturedRefreshHandler?.()
    await vi.waitFor(() => {
      expect(fetchedUrls().some((u) => u.includes('/shipment-schedules?'))).toBe(true)
    })
    // loading 状态上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落
    resolveListFetch(jsonResponse(listPayload()))
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })

  it('头部刷新（发货费用 tab）：重拉成本汇总 + 批次表格数据集', async () => {
    mockSearchParams = new URLSearchParams('tab=cost')
    render(<ShipmentManagementPage />)
    // 成本汇总统计条出现（costSummary 加载完成）
    expect(await screen.findByText('¥ 1,250')).toBeInTheDocument()
    await screen.findByText('FBA12345678')
    fetchMock.mockClear()

    capturedRefreshHandler?.()
    await vi.waitFor(() => {
      const urls = fetchedUrls()
      // cost tab 数据集 = 成本汇总 + 批次表格（items），两者都重拉
      expect(urls.some((u) => u.includes('/cost-summary'))).toBe(true)
      expect(urls.some((u) => u.includes('/shipment-schedules?'))).toBe(true)
    })
    // 分支正确性：不应触碰其它 tab 的数据集
    expect(fetchedUrls().some((u) => u.includes('/sku-summary'))).toBe(false)
    expect(fetchedUrls().some((u) => u.includes('/fba-box-details'))).toBe(false)
  })

  it('头部刷新（SKU汇总 tab）：重拉 SKU 汇总数据集', async () => {
    mockSearchParams = new URLSearchParams('tab=sku-summary')
    render(<ShipmentManagementPage />)
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
    fetchMock.mockClear()

    capturedRefreshHandler?.()
    await vi.waitFor(() => {
      expect(fetchedUrls().some((u) => u.includes('/sku-summary'))).toBe(true)
    })
    expect(fetchedUrls().some((u) => u.includes('/cost-summary'))).toBe(false)
    expect(fetchedUrls().some((u) => u.includes('/fba-box-details'))).toBe(false)
  })

  it('FBA 箱单导出保留分组底纹、合并单元格、图片与总计', async () => {
    mockSearchParams = new URLSearchParams('tab=fba-box-detail&shipment_no=FBA12345678')
    render(<ShipmentManagementPage />)
    await screen.findByText('TEST-SKU-FBA')

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    await vi.waitFor(() => expect(excelCapture.sheetNames).toContain('FBA箱单明细'))
    const details = excelCapture.valuesBySheet['FBA箱单明细']!
    const detailFills = excelCapture.fillsBySheet['FBA箱单明细']!
    expect(details[2]?.[3]).toBe('TEST-SKU-FBA')
    expect(details[3]?.[3]).toBe('TEST-SKU-FBA-2')
    expect(detailFills[2]?.[4]).toMatchObject({ fgColor: { argb: 'FFFFFFFF' } })
    // 同一货件属于同一底纹组；FBA 箱单保持其分组底纹逻辑而非逐行斑马纹。
    expect(detailFills[3]?.[4]).toMatchObject({ fgColor: { argb: 'FFFFFFFF' } })
    expect(excelCapture.sheetImageCount).toBe(2)
    expect(excelCapture.mergesBySheet['FBA箱单明细']).toContain('2:1:3:1')
    expect(details[4]?.[0]).toBe('合计')
  })

  it('头部刷新（FBA 箱单 tab）：重拉当前选中货件的箱单明细', async () => {
    mockSearchParams = new URLSearchParams('tab=fba-box-detail&shipment_no=FBA12345678')
    render(<ShipmentManagementPage />)
    // 箱单明细加载完成（URL 带入的货件编号触发 fba loader）
    expect(await screen.findByText('TEST-SKU-FBA')).toBeInTheDocument()
    fetchMock.mockClear()

    capturedRefreshHandler?.()
    await vi.waitFor(() => {
      expect(fetchedUrls().some((u) => u.includes('/fba-box-details'))).toBe(true)
    })
    expect(fetchedUrls().some((u) => u.includes('/cost-summary'))).toBe(false)
    expect(fetchedUrls().some((u) => u.includes('/sku-summary'))).toBe(false)
  })
})
