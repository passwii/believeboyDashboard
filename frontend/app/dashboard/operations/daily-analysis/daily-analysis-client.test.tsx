import type { ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ===== BLF-819 review：daily-analysis-client 头部→页面绑定 effect 测试 =====
// 完整渲染该组件需要 mock 大量数据面（recharts 图表 / ops 聚合接口），
// 这里用「同构最小消费组件」复刻绑定 effect 的真实实现路径：
// 直接从源文件复制 effect 本体逻辑（含 signature 去重 + isFirstApply 守卫 +
// loadDataRef 桥接），mock useTerminalGlobalFilter 驱动，验证三条行为契约。
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

// ---- 绑定 effect 源码镜像（daily-analysis-client.tsx:943-976，BLF-819 引入）----
type DateRange = { from?: Date; to?: Date }
function parseDateInputValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function BindingHarness({ onSetProjectId, onSetCountry, onLoadData }: {
  onSetProjectId: (v: string) => void
  onSetCountry: (v: string) => void
  onLoadData: (range: DateRange) => void
}) {
  const globalFilter = useTerminalGlobalFilter()
  const gfProjectId = globalFilter.ready ? globalFilter.projectId : null
  const gfCountry = globalFilter.ready ? globalFilter.country : null
  const gfDateFrom = globalFilter.ready ? globalFilter.dateFrom : null
  const gfDateTo = globalFilter.ready ? globalFilter.dateTo : null

  // 与源文件一致：loadData 在下方定义，用 ref 桥接
  const loadDataRef = useRef<((rangeOverride?: DateRange) => void) | null>(null)
  useEffect(() => {
    loadDataRef.current = onLoadData
  })
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
    if (gfProjectId && gfProjectId !== 'MIRRORED_CURRENT') {
      onSetProjectId(gfProjectId === 'all' ? 'all' : gfProjectId)
    }
    if (gfCountry && ['US', 'DE', 'UK', 'ALL'].includes(gfCountry)) {
      onSetCountry(gfCountry)
    }
    if (gfDateFrom && gfDateTo) {
      const from = parseDateInputValue(gfDateFrom)
      const to = parseDateInputValue(gfDateTo)
      if (from && to) {
        onLoadData({ from, to })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalFilter.ready, gfProjectId, gfCountry, gfDateFrom, gfDateTo])

  return <div data-testid="harness" />
}

import { useEffect, useRef } from 'react'

function renderHarness(overrides: Partial<Parameters<typeof BindingHarness>[0]> = {}) {
  const calls = {
    setProjectId: [] as string[],
    setCountry: [] as string[],
    loadData: [] as string[],
  }
  const { rerender } = render(
    <BindingHarness
      onSetProjectId={(v) => calls.setProjectId.push(v)}
      onSetCountry={(v) => calls.setCountry.push(v)}
      onLoadData={(r) => {
        const fmt = (d?: Date) =>
          `${d!.getFullYear()}-${String(d!.getMonth() + 1).padStart(2, '0')}-${String(d!.getDate()).padStart(2, '0')}`
        calls.loadData.push(`${fmt(r.from)}~${fmt(r.to)}`)
      }}
      {...overrides}
    />
  )
  const rerenderHarness = (overrides2: Partial<Parameters<typeof BindingHarness>[0]> = {}) => {
    rerender(
      <BindingHarness
        onSetProjectId={(v) => calls.setProjectId.push(v)}
        onSetCountry={(v) => calls.setCountry.push(v)}
        onLoadData={(r) => {
          const fmt = (d?: Date) =>
            `${d!.getFullYear()}-${String(d!.getMonth() + 1).padStart(2, '0')}-${String(d!.getDate()).padStart(2, '0')}`
          calls.loadData.push(`${fmt(r.from)}~${fmt(r.to)}`)
        }}
        {...overrides}
        {...overrides2}
      />
    )
  }
  return { calls, rerender: rerenderHarness }
}

describe('daily-analysis-client BLF-819 头部→页面绑定 effect（源码镜像契约测试）', () => {
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
  })

  it('首次水合：头部带持久化项目（gProject/storage）时写入页面项目与国家', async () => {
    setGf({ projectId: '42', country: 'DE' })
    const { calls } = renderHarness()
    await waitFor(() => {
      expect(calls.setProjectId).toContain('42')
      expect(calls.setCountry).toContain('DE')
    })
  })

  it('头部切换：setter 后页面项目/站点/日期随动，且日期触发 loadData 桥接', async () => {
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
      expect(calls.loadData).toEqual(['2026-08-01~2026-08-05'])
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
})
