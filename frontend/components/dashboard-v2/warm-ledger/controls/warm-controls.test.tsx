import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
  WarmSelect,
  WarmSegmentedControl,
} from './index'

describe('Warm controls', () => {
  it('keeps a loading button disabled and exposes its busy name', () => {
    const onClick = vi.fn()

    render(
      <WarmButton onClick={onClick} loading loadingLabel="正在刷新当前页数据">
        刷新
      </WarmButton>
    )

    const button = screen.getByRole('button', { name: '正在刷新当前页数据' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('supports disabled icon actions with an accessible name', () => {
    render(
      <WarmIconButton aria-label="刷新当前页数据" disabled>
        <span aria-hidden="true">↻</span>
      </WarmIconButton>
    )

    expect(screen.getByRole('button', { name: '刷新当前页数据' })).toBeDisabled()
  })

  it('exposes the active segment with aria-pressed and reports changes', () => {
    const onChange = vi.fn()

    render(
      <WarmSegmentedControl
        ariaLabel="项目排序"
        value="sales"
        options={[
          { value: 'sales', label: '销售额' },
          { value: 'adSpend', label: '广告费' },
        ]}
        onChange={onChange}
      />
    )

    const sales = screen.getByRole('button', { name: '销售额' })
    const adSpend = screen.getByRole('button', { name: '广告费' })
    expect(sales).toHaveAttribute('aria-pressed', 'true')
    expect(adSpend).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(adSpend)
    expect(onChange).toHaveBeenCalledWith('adSpend')
  })

  it('renders a labeled styled select and retains its disabled state', () => {
    const onChange = vi.fn()

    render(
      <WarmSelect
        id="project-filter"
        label="项目筛选"
        value="all"
        options={[{ value: 'all', label: '全部项目' }]}
        onChange={onChange}
        disabled
      />
    )

    const select = screen.getByRole('combobox', { name: '项目筛选' })
    expect(screen.getByText('全部项目')).toBeInTheDocument()
    expect(select).toBeDisabled()
  })

  it('connects invalid select state to its inline error message', () => {
    render(
      <WarmSelect
        id="project-filter"
        label="项目筛选"
        value="all"
        options={[{ value: 'all', label: '全部项目' }]}
        onChange={vi.fn()}
        disabled
        error="项目列表加载失败"
      />
    )

    const select = screen.getByRole('combobox', { name: '项目筛选' })
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(select).toHaveAccessibleDescription('项目列表加载失败')
    expect(screen.getByRole('alert')).toHaveTextContent('项目列表加载失败')
  })

  it('renders a neutral badge by default and supports semantic tones', () => {
    const { rerender } = render(<WarmBadge>同步完成</WarmBadge>)
    expect(screen.getByText('同步完成')).toHaveAttribute('data-tone', 'neutral')

    rerender(<WarmBadge tone="positive">同步完成</WarmBadge>)
    expect(screen.getByText('同步完成')).toHaveAttribute('data-tone', 'positive')
  })
})
