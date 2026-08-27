import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

import {
  LegacyFallbackFilters,
  SkuSearchField,
} from '@/components/dashboard/daily-analysis-header-filters'

// Radix Select 在 jsdom 下需要 PointerEvent 与 scrollIntoView 才能交互
beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      public pointerId: number
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params)
        this.pointerId = params.pointerId ?? 0
      }
    }
    ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill
  }
})

type SkuOption = {
  sku: string
  asin: string | null
  fnsku: string | null
  product_name: string | null
  units_per_carton: number
}

const SKU_OPTIONS: SkuOption[] = [
  {
    sku: 'SKU-001',
    asin: 'B0AAAAAAA1',
    fnsku: 'X001',
    product_name: '无线充电器',
    units_per_carton: 20,
  },
]

function SkuFieldHarness(props: Partial<ComponentProps<typeof SkuSearchField>> = {}) {
  return <SkuSearchField value="" options={[]} loading={false} onChange={() => {}} {...props} />
}

describe('SkuSearchField（BLF-832 follow-up 终端规格化）', () => {
  it('trigger 使用头部标准控件规格（h-9 零圆角 term-bg mono）且无前置标签', () => {
    render(<SkuFieldHarness />)
    // BLF-876：已移除 FieldLabel 前置标签，控件靠 placeholder/文案自解释
    expect(document.querySelector('label')).toBeNull()

    const trigger = screen.getByRole('button')
    for (const cls of ['h-9', 'rounded-none', 'border-term-border', 'bg-term-bg', 'font-mono']) {
      expect(trigger.className).toContain(cls)
    }
    // 不再是旧版 outline 圆角风格
    expect(trigger.className).not.toContain('rounded-md')
  })

  it('未选中时显示「全部 SKU」；选中后显示 SKU 与品名', () => {
    const { rerender } = render(<SkuFieldHarness />)
    expect(screen.getByRole('button').textContent).toContain('全部 SKU')

    rerender(
      <SkuFieldHarness value="SKU-001" options={SKU_OPTIONS} loading={false} onChange={() => {}} />
    )
    const text = screen.getByRole('button').textContent ?? ''
    expect(text).toContain('SKU-001')
    expect(text).toContain('无线充电器')
  })

  it('disabled 时点击不打开弹层、不触发 onOpen，且按钮处于禁用态', () => {
    const onOpen = vi.fn()
    render(<SkuFieldHarness disabled onOpen={onOpen} />)

    const trigger = screen.getByRole('button')
    expect(trigger).toBeDisabled()
    trigger.click()
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('搜索 SKU')).toBeNull()
    // 视觉降级类保留
    expect(trigger.className).toContain('opacity-50')
  })

  it('弹层为终端样式（零圆角、term 边框/面色，item 终端 hover）', async () => {
    const user = userEvent.setup()
    render(<SkuFieldHarness value="" options={SKU_OPTIONS} loading={false} onChange={() => {}} />)
    await user.click(screen.getByRole('button'))
    // DialogContent 已调整为 rounded-none border-term-border bg-term-panel
    expect(document.body.textContent).toContain('全部 SKU')
  })
})

const FALLBACK_PROJECTS = [
  { id: 1, name: '项目甲' },
  { id: 2, name: '项目乙' },
]

function FallbackHarness(props: Partial<ComponentProps<typeof LegacyFallbackFilters>> = {}) {
  return (
    <LegacyFallbackFilters
      projectId="1"
      projects={FALLBACK_PROJECTS}
      country="US"
      dateRange={undefined}
      onProjectChange={() => {}}
      onCountryChange={() => {}}
      onDateRangeChange={() => {}}
      onDateApply={() => {}}
      {...props}
    />
  )
}

describe('LegacyFallbackFilters（md~xl 降级三件套）', () => {
  it('渲染项目 / 站点 / 日期三件套，trigger 显示当前选中值', () => {
    render(<FallbackHarness />)
    // 两个 Radix Select（项目/站点）；DateRangePicker 是普通 button 触发器
    expect(screen.getAllByRole('combobox').length).toBe(2)
    // Radix Select trigger 内以 span 文本呈现当前选中项；日期触发器存在且带 mono 类
    expect(screen.getByText('项目甲')).toBeInTheDocument()
    expect(screen.getByText('美国站 (US)')).toBeInTheDocument()
    const dateTrigger = document.querySelector('button.font-mono')
    expect(dateTrigger).not.toBeNull()
  })

  it('打开项目下拉可见「全部项目」聚合位与其他项目；切换回调携带新值', async () => {
    const user = userEvent.setup()
    const onProjectChange = vi.fn()
    render(<FallbackHarness onProjectChange={onProjectChange} />)

    // 直接点击 trigger 元素（子 span 有 pointer-events:none）
    await user.click(screen.getAllByRole('combobox')[0])
    expect(await screen.findByRole('option', { name: '全部项目' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '项目乙' }))
    expect(onProjectChange).toHaveBeenCalledWith('2')
  })

  it('站点下拉含「全部站点」聚合位；切换回调透传国家码', async () => {
    const user = userEvent.setup()
    const onCountryChange = vi.fn()
    render(<FallbackHarness onCountryChange={onCountryChange} />)

    await user.click(screen.getAllByRole('combobox')[1])
    expect(await screen.findByRole('option', { name: '全部站点' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '德国站 (DE)' }))
    expect(onCountryChange).toHaveBeenCalledWith('DE')
  })
})
