import { useCallback, useEffect, useRef, useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ===== BLF-819 review / BLF-882 fix：daily-analysis-client 头部→页面绑定 effect 测试 =====
// 完整渲染该组件需要 mock 大量数据面（recharts 图表 / ops 聚合接口），
// 这里用「同构最小消费组件」复刻绑定 effect 的真实实现路径：
// 直接从源文件复制 effect 本体逻辑（含 signature 去重 + isFirstApply 守卫 +
// loadDataRef 桥接 + BLF-882 projectWillChange 直连守卫），并镜像页面侧
// projectId/country/dateRange 状态与 [loadData] effect（状态落定后的自然重跑），
// mock useTerminalGlobalFilter 驱动，验证行为契约。
// 若日后把绑定 effect 抽成共享 hook，本文件应改为直接 import 该 hook。

// ---- 可控全局筛选 mock（与 order-info/page.test.tsx 同款 Proxy 方案）----
const gfState = {
  ready: true,
  projectId: '',
  country: 'US',
  dateFrom: '',
  dateTo: '',
}
let gfVersion = 0
const gfSetters = {
  setProjectId: vi.fn(),
  setCountry: vi.fn(),
  setDateRange: vi.fn(),
}
const gfValue = new Proxy(gfState, {
  get(target, key) {
    if (key === '__gfVersion') return gfVersion
    if (key in gfSetters) return gfSetters[key as keyof typeof gfSetters]
    return target[key as keyof typeof gfState]
  },
})
vi.mock('@/components/terminal/global-filter-context', () => ({
  useTerminalGlobalFilter: () => gfValue,
}))

import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'

function setGf(patch: Partial<typeof gfState>) {
  Object.assign(gfState, patch)
  gfVersion += 1
}

// ---- 绑定 effect 源码镜像（daily-analysis-client.tsx，BLF-819 引入、BLF-882 修复直连竞态）----
type DateRange = { from?: Date; to?: Date }
function parseDateInputValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 页面 dateRange 初值镜像：源码 defaultRange（近 7 天），取固定日期便于断言 */
const DEFAULT_RANGE: DateRange = { from: new Date(2026, 7, 20), to: new Date(2026, 7, 26) }

type LoadDataCall = { range: string; projectId: string; via: 'direct' | 'effect' }

function BindingHarness({
  onSetProjectId,
  onSetCountry,
  onLoadData,
  initialProjectId = '',
}: {
  onSetProjectId: (v: string) => void
  onSetCountry: (v: string) => void
  onLoadData: (call: LoadDataCall) => void
  initialProjectId?: string
}) {
  const globalFilter = useTerminalGlobalFilter()
  const gfProjectId = globalFilter.ready ? globalFilter.projectId : null
  const gfCountry = globalFilter.ready ? globalFilter.country : null
  const gfDateFrom = globalFilter.ready ? globalFilter.dateFrom : null
  const gfDateTo = globalFilter.ready ? globalFilter.dateTo : null

  // 页面侧状态镜像：projectId/country（useUrlParam 替身）+ dateRange
  const [projectId, setProjectIdState] = useState(initialProjectId)
  const [country, setCountryState] = useState('US')
  const [dateRange, setDateRange] = useState<DateRange | undefined>(DEFAULT_RANGE)

  // loadData 镜像：闭包捕获当前 render 的 projectId/dateRange（与源码 useCallback 一致）；
  // 观察者回调走 ref 桥接，其身份变化不参与 effect 依赖。
  const onLoadDataRef = useRef(onLoadData)
  onLoadDataRef.current = onLoadData
  const loadData = useCallback(
    (rangeOverride: DateRange | undefined, via: 'direct' | 'effect') => {
      const effective = rangeOverride ?? dateRange
      const fmt = (d?: Date) =>
        d
          ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
              d.getDate()
            ).padStart(2, '0')}`
          : ''
      onLoadDataRef.current({
        range: `${fmt(effective?.from)}~${fmt(effective?.to)}`,
        projectId,
        via,
      })
    },
    [projectId, dateRange]
  )

  // 与源文件一致：loadData 在下方定义，用 ref 桥接
  const loadDataRef = useRef<((rangeOverride?: DateRange) => void) | null>(null)
  loadDataRef.current = (range) => loadData(range, 'direct')

  const lastAppliedGfRef = useRef('')
  useEffect(() => {
    if (!globalFilter.ready) return
    const signature = `${gfProjectId}|${gfCountry}|${gfDateFrom}|${gfDateTo}`
    if (signature === lastAppliedGfRef.current) return
    const isFirstApply = lastAppliedGfRef.current === ''
    lastAppliedGfRef.current = signature
    if (isFirstApply) {
      if (!gfProjectId) return
    }
    const projectWillChange = Boolean(gfProjectId) && gfProjectId !== projectId
    if (gfProjectId && projectWillChange) {
      const next = gfProjectId === 'all' ? 'all' : gfProjectId
      onSetProjectId(next)
      setProjectIdState(next)
    }
    if (gfCountry && ['US', 'DE', 'UK', 'ALL'].includes(gfCountry) && gfCountry !== country) {
      onSetCountry(gfCountry)
      setCountryState(gfCountry)
    }
    if (gfDateFrom && gfDateTo) {
      const from = parseDateInputValue(gfDateFrom)
      const to = parseDateInputValue(gfDateTo)
      if (from && to) {
        setDateRange({ from, to })
        // BLF-882：项目即将变化时当前 render 的 loadData 闭包仍持有旧 projectId，
        // 直连会以旧值（进入页面常为空）发请求并误报「请先选择项目」；
        // 跳过直连，由下方 [loadData] effect 在状态落定后自然重跑。
        if (!projectWillChange && projectId) {
          loadDataRef.current?.({ from, to })
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter.ready, gfProjectId, gfCountry, gfDateFrom, gfDateTo])

  // 源码 [loadData] effect 镜像：projectId/dateRange 落定后自然触发加载
  useEffect(() => {
    if (!projectId) return
    loadData(undefined, 'effect')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 与源码一致：仅随 loadData 身份（含 projectId/dateRange 闭包）重跑
  }, [loadData])

  return <div data-testid="harness" />
}

function renderHarness(overrides: Partial<Parameters<typeof BindingHarness>[0]> = {}) {
  const calls = {
    setProjectId: [] as string[],
    setCountry: [] as string[],
    loadData: [] as LoadDataCall[],
  }
  const props = (extra: Partial<Parameters<typeof BindingHarness>[0]>) => ({
    onSetProjectId: (v: string) => calls.setProjectId.push(v),
    onSetCountry: (v: string) => calls.setCountry.push(v),
    onLoadData: (call: LoadDataCall) => calls.loadData.push(call),
    ...extra,
  })
  const { rerender } = render(<BindingHarness {...props(overrides)} />)
  const rerenderHarness = (overrides2: Partial<Parameters<typeof BindingHarness>[0]> = {}) => {
    rerender(<BindingHarness {...props({ ...overrides, ...overrides2 })} />)
  }
  return { calls, rerender: rerenderHarness }
}

describe('daily-analysis-client BLF-819/BLF-882 头部→页面绑定 effect（源码镜像契约测试）', () => {
  beforeEach(() => {
    Object.assign(gfState, { ready: true, projectId: '', country: 'US', dateFrom: '', dateTo: '' })
    gfVersion += 1
    for (const fn of Object.values(gfSetters)) fn.mockClear()
  })

  it('首次水合守卫：URL 无 g* 参数（projectId 为空）时 binding 不写页面筛选（保留自动选第一个项目行为）', async () => {
    const { calls } = renderHarness()
    await waitFor(() => expect(screen.getByTestId('harness')).toBeInTheDocument())
    // 让 signature 稳定后跑完一轮 effect
    act(() => {})
    expect(calls.setProjectId).toEqual([])
    expect(calls.setCountry).toEqual([])
    expect(calls.loadData).toEqual([])
  })

  it('首次水合：头部带持久化项目（gProject/storage）时写入页面项目与国家', async () => {
    setGf({ projectId: '42', country: 'DE' })
    const { calls } = renderHarness()
    await waitFor(() => {
      expect(calls.setProjectId).toContain('42')
      expect(calls.setCountry).toContain('DE')
    })
  })

  it('头部切换：setter 后页面项目/站点随动，日期经 [loadData] effect 落定后触发加载（BLF-882 后不再直连旧闭包）', async () => {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '', dateTo: '' })
    const { calls, rerender } = renderHarness()
    await waitFor(() => expect(screen.getByTestId('harness')).toBeInTheDocument())

    act(() => {
      setGf({ projectId: '7', country: 'UK', dateFrom: '2026-08-01', dateTo: '2026-08-05' })
    })
    rerender()

    await waitFor(() => {
      expect(calls.setProjectId).toContain('7')
      expect(calls.setCountry).toContain('UK')
      expect(calls.loadData).toEqual([
        { range: '2026-08-01~2026-08-05', projectId: '7', via: 'effect' },
      ])
    })
  })

  it("'all' 语义映射：头部全部项目透传为页面 'all'", async () => {
    setGf({ projectId: 'all' })
    const { calls } = renderHarness()
    await waitFor(() => expect(calls.setProjectId).toContain('all'))
  })

  it('signature 去重：同一组值重复 rerender 不重复触发页面 setter', async () => {
    setGf({ ready: true, projectId: '', country: 'US', dateFrom: '', dateTo: '' })
    const { calls, rerender } = renderHarness()
    await waitFor(() => expect(screen.getByTestId('harness')).toBeInTheDocument())

    act(() => {
      setGf({ projectId: '9' })
    })
    rerender()
    await waitFor(() => expect(calls.setProjectId).toContain('9'))

    const countAfterFirstApply = calls.setProjectId.length
    // 同 signature 再 render 多次 → 不再追加
    rerender()
    rerender()
    expect(calls.setProjectId.length).toBe(countAfterFirstApply)
  })

  it('BLF-882 回归：首次水合头部带持久化项目+日期、页面项目为空时，不以空项目直连 loadData（不误报「请先选择项目」）', async () => {
    setGf({ projectId: '42', country: 'US', dateFrom: '2026-08-20', dateTo: '2026-08-26' })
    const { calls } = renderHarness()

    await waitFor(() => expect(calls.setProjectId).toContain('42'))
    await waitFor(() => expect(calls.loadData.length).toBe(1))
    // 任何 loadData 调用都不得携带空 projectId（修复前直连闭包持有旧空值 → 误报 toast）
    expect(calls.loadData.every((c) => c.projectId !== '')).toBe(true)
    expect(calls.loadData).toEqual([
      { range: '2026-08-20~2026-08-26', projectId: '42', via: 'effect' },
    ])
  })

  it('BLF-882 兼容：页面项目与头部一致（无变化）时，日期直连桥接保留（BLF-819 快路径）', async () => {
    setGf({ projectId: '42', country: 'US', dateFrom: '2026-08-10', dateTo: '2026-08-12' })
    const { calls } = renderHarness({ initialProjectId: '42' })

    await waitFor(() => {
      expect(calls.loadData.some(
        (c) => c.via === 'direct' && c.range === '2026-08-10~2026-08-12' && c.projectId === '42'
      )).toBe(true)
    })
    expect(calls.loadData.every((c) => c.projectId === '42')).toBe(true)
  })
})
