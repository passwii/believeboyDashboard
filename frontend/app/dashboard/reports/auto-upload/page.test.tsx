import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { DATE_REQUIRED_REPORT_TYPES, isDateRequired } from '@/components/report-upload/types'
import AutoUploadPage from './page'
import {
  getUploadReportTypeLabel,
  REPORT_TYPES,
  REPORT_UPLOAD_REPORT_TYPE_LABELS,
} from './report-type-labels'

// 稳定引用：生产 useSession 返回引用稳定的对象；mock 若每次 render 返回新对象，
// AutoUploadContent 的 useEffect(loadProjects, [session]) 会无限重跑（fetch 永不落定），
// 与 v2/page.test.tsx 中 useManagedProjects 的注释同理。
const SESSION = { data: { user: { name: '测试用户' } }, status: 'authenticated' }
const HEADER_REFRESH = vi.hoisted(() => ({ handler: null as null | (() => void | Promise<void>) }))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    HEADER_REFRESH.handler = handler
    return { setLoading: vi.fn() }
  },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => SESSION,
}))

const PROJECTS: Array<{ name: string }> = []

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: () => Promise.resolve(PROJECTS),
}))

const SUMMARY_LABEL = '库存分类账 · 汇总视图（Summary）'
const DETAIL_LABEL = '库存分类账 · 明细视图（Detail）'
const AUTO_UPLOAD_SOURCE_ROOT = join(process.cwd(), 'app/dashboard/reports/auto-upload')
const AUTO_UPLOAD_CSS = readFileSync(
  join(AUTO_UPLOAD_SOURCE_ROOT, 'auto-upload-warm.module.css'),
  'utf8'
)
const AUTO_UPLOAD_PAGE_SOURCE = readFileSync(
  join(AUTO_UPLOAD_SOURCE_ROOT, 'page.tsx'),
  'utf8'
)
const TERMINAL_VISUAL_RESIDUE = [
  { label: 'Terminal token', pattern: /--term-/g },
  { label: 'Terminal utility', pattern: /\bterm-[a-z0-9-]+/g },
  { label: 'Terminal zero-radius utility', pattern: /\brounded-none\b/g },
]

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(path)
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) return []
    return ['.css', '.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

function jsonResponse(payload: unknown) {
  return { ok: true, json: async () => payload } as Response
}

const RECOGNITION = {
  temp_file_id: 't-1',
  original_filename: '库存分类账 2026-03一览视图.csv',
  extension: 'csv',
  report_type: 'inventory_ledger_summary',
  matched_columns: ['date', 'msku', 'disposition', 'starting_warehouse_balance'],
  reason: 'ok',
  status: 'recognized',
  country: 'US',
  detected_countries: [],
  primary_country: null,
  date_input_mode: 'single_auto',
  detected_date: '2026-03-01',
  detected_start_date: null,
  detected_end_date: null,
  project_match: {
    status: 'unmatched',
    project_name: null,
    candidate_projects: [],
    matched_by: null,
    matched_values: [],
    message: null,
  },
  row_count_preview: 10,
  warnings: [],
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/rpa-reports/status')) return jsonResponse({ items: [] })
      if (url.includes('/report-upload/recognize')) return jsonResponse(RECOGNITION)
      return jsonResponse({})
    })
  )
})

describe('getUploadReportTypeLabel（上传队列类型中文标签）', () => {
  it('inventory_ledger_summary 返回计划指定的精确中文文案', () => {
    expect(getUploadReportTypeLabel('inventory_ledger_summary')).toBe(SUMMARY_LABEL)
  })

  it('inventory_ledger_detail 返回计划指定的精确中文文案', () => {
    expect(getUploadReportTypeLabel('inventory_ledger_detail')).toBe(DETAIL_LABEL)
  })

  it('旧版 inventory_ledger 仍有非空历史标签，不显示原始 key', () => {
    const label = getUploadReportTypeLabel('inventory_ledger')
    expect(label).toBeTruthy()
    expect(label).not.toBe('inventory_ledger')
  })

  it('unknown / null 显示「未识别」', () => {
    expect(getUploadReportTypeLabel('unknown')).toBe('未识别')
    expect(getUploadReportTypeLabel(null)).toBe('未识别')
  })
})

describe('REPORT_UPLOAD_REPORT_TYPE_LABELS', () => {
  it('包含两个独立类型的精确中文文案', () => {
    expect(REPORT_UPLOAD_REPORT_TYPE_LABELS.inventory_ledger_summary).toBe(SUMMARY_LABEL)
    expect(REPORT_UPLOAD_REPORT_TYPE_LABELS.inventory_ledger_detail).toBe(DETAIL_LABEL)
  })

  it('保留旧版 inventory_ledger 的非空历史标签', () => {
    expect(REPORT_UPLOAD_REPORT_TYPE_LABELS.inventory_ledger).toBeTruthy()
  })

  it('旧版 inventory_ledger 历史标签为计划指定精确文案', () => {
    expect(REPORT_UPLOAD_REPORT_TYPE_LABELS.inventory_ledger).toBe(
      '历史库存分类账类型（待重新识别）'
    )
  })
})

describe('REPORT_TYPES（RPA 状态矩阵）', () => {
  it('不含库存分类账两类视图（BLF-482 已移除）', () => {
    const keys = REPORT_TYPES.map((rt) => rt.key)
    expect(keys).not.toContain('inventory_ledger_summary')
    expect(keys).not.toContain('inventory_ledger_detail')
  })

  it('广告相关列从「词份额」到「时间效果」统一加「广告-」前缀（BLF-482）', () => {
    const adEntries = REPORT_TYPES.filter((rt) =>
      rt.key.startsWith('ad_')
    )
    expect(adEntries.length).toBeGreaterThan(0)
    for (const entry of adEntries) {
      expect(entry.label.startsWith('广告-')).toBe(true)
    }
    expect(REPORT_TYPES.find((rt) => rt.key === 'ad_search_term_share_report')?.label).toBe('广告-词份额')
    expect(REPORT_TYPES.find((rt) => rt.key === 'ad_time_trend_report')?.label).toBe('广告-时间效果')
  })

  it('不把旧版 inventory_ledger 作为可展示列', () => {
    expect(REPORT_TYPES.some((rt) => rt.key === 'inventory_ledger')).toBe(false)
  })

  it('不含预留/未激活报表类型（BLF-647 已删除）', () => {
    const keys = REPORT_TYPES.map((rt) => rt.key)
    for (const reserved of [
      'storage_report',
      'returns_detail_report',
      'fba_inventory_report',
      'reimbursement_report',
      'tax_invoice_report',
      'health_report',
      'advertising_reports',
      'brand_report',
      'vendor_report',
    ]) {
      expect(keys).not.toContain(reserved)
    }
  })
})

describe('DATE_REQUIRED_REPORT_TYPES / isDateRequired', () => {
  it('两个独立类型都需要日期', () => {
    expect(DATE_REQUIRED_REPORT_TYPES).toContain('inventory_ledger_summary')
    expect(DATE_REQUIRED_REPORT_TYPES).toContain('inventory_ledger_detail')
    expect(isDateRequired('inventory_ledger_summary')).toBe(true)
    expect(isDateRequired('inventory_ledger_detail')).toBe(true)
  })

  it('旧版 inventory_ledger 仍需要日期（历史队列兼容）', () => {
    expect(isDateRequired('inventory_ledger')).toBe(true)
  })
})

describe('AutoUploadPage 队列与状态矩阵渲染', () => {
  it('进度条用 transform 动画，避免触发布局', () => {
    expect(AUTO_UPLOAD_CSS).not.toMatch(/transition:\s*width/)
    expect(cssBlock(AUTO_UPLOAD_CSS, '.progressFill')).toContain(
      'transform-origin: left center'
    )
    expect(AUTO_UPLOAD_PAGE_SOURCE).toContain('transform: `scaleX(')
  })

  it('项目筛选按钮不被 control 的强制视觉压住 hover/focus', () => {
    const control = cssBlock(AUTO_UPLOAD_CSS, '.control')

    expect(control).not.toMatch(/background:[^;]+!important/)
    expect(control).not.toMatch(/border:[^;]+!important/)
    expect(control).not.toMatch(/box-shadow:[^;]+!important/)
    expect(cssBlock(AUTO_UPLOAD_CSS, '.projectFilter:hover:not(:disabled)')).toContain(
      'background: var(--warm-ledger-color-raised-hover)'
    )
    expect(cssBlock(AUTO_UPLOAD_CSS, '.projectFilter:focus-visible')).toContain(
      'outline:'
    )
  })

  it('上传说明是普通 sans 文本，不使用 mono', async () => {
    const user = userEvent.setup()
    render(<AutoUploadPage />)
    await user.click(screen.getByRole('tab', { name: '文件上传' }))

    for (const text of ['拖拽文件到这里，或点击选择', '支持 .txt / .csv / .xlsx']) {
      const element = screen.getByText(text)
      expect(element.className).toContain('font-sans')
      expect(element.className).not.toContain('font-mono')
    }

    expect(screen.getByRole('combobox', { name: '选择上传站点' })).toHaveClass('font-sans')
    expect(screen.getByRole('combobox', { name: '选择上传站点' })).not.toHaveClass(
      'font-mono'
    )
    expect(screen.getByText('本次识别文件')).toHaveClass('font-sans')
    expect(screen.getByText('本次识别文件')).not.toHaveClass('font-mono')
    expect(screen.getByText('暂无文件')).toHaveClass('font-sans')
    expect(screen.getByText('暂无文件')).not.toHaveClass('font-mono')
  })

  it('上传中只保留 WarmButton spinner，不保留上传图标', async () => {
    const user = userEvent.setup()
    let resolveCommit!: () => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/rpa-reports/status')) return jsonResponse({ items: [] })
        if (url.includes('/report-upload/recognize')) {
          return jsonResponse({
            ...RECOGNITION,
            project_match: {
              status: 'matched',
              project_name: '测试项目',
              candidate_projects: [],
              matched_by: 'sku',
              matched_values: ['MSKU-1'],
              message: null,
            },
          })
        }
        if (url.includes('/report-upload/commit')) {
          return await new Promise<Response>((resolve) => {
            resolveCommit = () => resolve(jsonResponse({ status: 'persisted' }))
          })
        }
        return jsonResponse({})
      })
    )

    render(<AutoUploadPage />)
    await user.click(screen.getByRole('tab', { name: '文件上传' }))
    await user.upload(
      screen.getByLabelText(/拖拽文件到这里/),
      new File(['date,msku'], '库存分类账 2026-03一览视图.csv', { type: 'text/csv' })
    )
    await screen.findByText(`类型：${SUMMARY_LABEL}`)
    await user.click(screen.getByRole('button', { name: /上传全部/ }))

    const button = await screen.findByRole('button', { name: '正在上传全部文件' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('svg')).toBeNull()
    expect(button.querySelectorAll('.warm-ledger__loading-mark')).toHaveLength(1)

    await act(async () => resolveCommit())
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'))
  })

  it('状态刷新中只保留 WarmIconButton spinner，不叠加子 Loader2', async () => {
    let resolveStatus!: () => void
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/rpa-reports/status')) {
          return await new Promise<Response>((resolve) => {
            resolveStatus = () => resolve(jsonResponse({ items: [] }))
          })
        }
        return jsonResponse({})
      })
    )

    render(<AutoUploadPage />)
    const button = await screen.findByRole('button', { name: '正在刷新报表状态' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('svg')).toBeNull()
    expect(button.querySelectorAll('.warm-ledger__loading-mark')).toHaveLength(1)

    await act(async () => resolveStatus())
  })

  it('使用 Warm Ledger 页面表面并保留桌面表格滚动容器', async () => {
    const { container } = render(<AutoUploadPage />)

    await screen.findByText('销售')

    expect(container.querySelector('[data-warm-auto-upload="true"]')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'RPA 报表状态' })).toHaveAttribute(
      'data-warm-rpa-status',
      'true'
    )
    expect(screen.getByTestId('rpa-status-scroll')).toHaveAttribute(
      'data-auto-upload-status-scroll',
      'true'
    )
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).not.toMatch(/term-|rounded-none/)
    }
  })

  it('源文件不重新引入 Terminal 视觉残留', () => {
    const violations = collectSourceFiles(AUTO_UPLOAD_SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return TERMINAL_VISUAL_RESIDUE.flatMap(({ label, pattern }) =>
        Array.from(source.matchAll(pattern), (match) => ({
          path,
          label,
          match: match[0],
        }))
      )
    })

    expect(violations).toEqual([])
  })

  it('识别为 inventory_ledger_summary 时队列展示中文标签而非原始 key', async () => {
    const user = userEvent.setup()
    render(<AutoUploadPage />)

    await user.click(screen.getByRole('tab', { name: '文件上传' }))

    const input = screen.getByLabelText(/拖拽文件到这里/)
    const file = new File(['date,msku,disposition'], '库存分类账 2026-03一览视图.csv', {
      type: 'text/csv',
    })
    await user.upload(input, file)

    expect(await screen.findByText(`类型：${SUMMARY_LABEL}`)).toBeInTheDocument()
    expect(screen.queryByText('类型：inventory_ledger_summary')).not.toBeInTheDocument()
  })

  it('RPA 状态矩阵不再渲染 库存分类账 汇总/明细 两列（BLF-482）', async () => {
    render(<AutoUploadPage />)

    await screen.findByText('销售')
    expect(screen.queryByText('汇总')).not.toBeInTheDocument()
    expect(screen.queryByText('明细')).not.toBeInTheDocument()
  })

  it('RPA 状态矩阵广告列渲染「广告-」前缀表头', async () => {
    render(<AutoUploadPage />)

    expect(await screen.findByText('广告-词份额')).toBeInTheDocument()
    expect(screen.getByText('广告-时间效果')).toBeInTheDocument()
    expect(screen.queryByText('词份额')).not.toBeInTheDocument()
  })

  it('Head 刷新重取当前状态视图，保留日期和筛选上下文', async () => {
    render(<AutoUploadPage />)
    await screen.findByText('销售')
    const fetchMock = vi.mocked(fetch)
    const before = fetchMock.mock.calls.filter(([input]) => String(input).includes('/rpa-reports/status')).length

    await act(async () => HEADER_REFRESH.handler?.())

    const after = fetchMock.mock.calls.filter(([input]) => String(input).includes('/rpa-reports/status')).length
    expect(after).toBe(before + 1)
  })

  it('上传成功后队列展示入库行数（rows_ingested 结构化字段）', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/rpa-reports/status')) return jsonResponse({ items: [] })
        if (url.includes('/report-upload/recognize')) {
          return jsonResponse({
            ...RECOGNITION,
            project_match: {
              status: 'matched',
              project_name: '测试项目',
              candidate_projects: [],
              matched_by: 'sku',
              matched_values: ['MSKU-1'],
              message: '已根据SKU自动匹配项目',
            },
          })
        }
        if (url.includes('/report-upload/commit')) {
          return jsonResponse({
            report_type: 'inventory_ledger_summary',
            status: 'persisted',
            rows_ingested: 1234,
            message: '库存分类账汇总视图已入库（1234 行）',
          })
        }
        return jsonResponse({})
      })
    )

    render(<AutoUploadPage />)

    await user.click(screen.getByRole('tab', { name: '文件上传' }))

    const input = screen.getByLabelText(/拖拽文件到这里/)
    const file = new File(['date,msku,disposition'], '库存分类账 2026-03一览视图.csv', {
      type: 'text/csv',
    })
    await user.upload(input, file)
    await screen.findByText(`类型：${SUMMARY_LABEL}`)

    await user.click(screen.getByRole('button', { name: /上传全部/ }))

    // 行数文本被拆在 <p> 与高亮 <span> 中，用 textContent 断言整行文案
    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === 'P' &&
          (element.textContent ?? '').includes('入库：1,234 行')
      )
    ).toBeInTheDocument()
  })
})

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  expect(start, `missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close)
}
